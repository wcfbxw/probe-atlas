import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { AlertEngine } from "./alerts.mjs";
import { loadConfig } from "./config.mjs";
import { createStatusStore, SqliteRepository } from "./storage.mjs";
import {
  validateAuthMessage,
  validateMetricsMessage,
} from "./validation.mjs";

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left ?? "");
  const rightBuffer = Buffer.from(right ?? "");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function safeSend(socket, payload) {
  if (socket.readyState !== 1) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function isAllowedOrigin(origin, config) {
  if (!origin || config.allowedOrigins.includes(origin)) {
    return true;
  }
  if (config.nodeEnv === "production") {
    return false;
  }
  try {
    const url = new URL(origin);
    return (
      url.port === "3000" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname.startsWith("10.") ||
        url.hostname.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname))
    );
  } catch {
    return false;
  }
}

export async function buildServer(overrides = {}) {
  const config = loadConfig(overrides);
  const app = Fastify({
    logger: config.logger,
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (isAllowedOrigin(origin, config)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"), false);
    },
    credentials: true,
  });
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    },
  });

  const repository = new SqliteRepository(config.dataDir);
  const statusStore = createStatusStore(config, app.log);
  await statusStore.init();

  const activeAgents = new Map();
  const dashboardSockets = new Set();
  const onlineServers = new Set();
  const pendingDashboardMetrics = new Map();
  const timers = new Set();

  function broadcast(payload) {
    for (const socket of dashboardSockets) {
      try {
        safeSend(socket, payload);
      } catch (error) {
        app.log.warn(error, "Dashboard socket send failed");
        dashboardSockets.delete(socket);
      }
    }
  }

  const alertEngine = new AlertEngine(
    config,
    repository,
    (alert) => broadcast({ type: "alert.created", alert }),
    app.log,
  );

  async function getServerViews() {
    const servers = repository.getServers();
    const statuses = await statusStore.getStatuses(
      servers.map((server) => server.server_id),
    );
    return servers.map((server, index) => {
      const status = statuses[index];
      return {
        server_id: server.server_id,
        display_name: server.display_name,
        hostname: server.hostname,
        region: server.region,
        provider: server.provider,
        tags: server.tags,
        os: server.os,
        arch: server.arch,
        cpu_model: server.cpu_model,
        cpu_cores: server.cpu_cores,
        mem_total_mb: server.mem_total_mb,
        disk_total_mb: server.disk_total_mb,
        last_seen_at: server.last_seen_at,
        connected: activeAgents.has(server.server_id),
        online: Boolean(status),
        status,
      };
    });
  }

  app.get("/healthz", async () => ({
    status: "ok",
    storage: {
      realtime: statusStore.mode,
      history: "sqlite",
    },
    active_agent_connections: activeAgents.size,
    dashboard_connections: dashboardSockets.size,
    uptime_seconds: Math.round(process.uptime()),
    timestamp: Date.now(),
  }));

  app.get("/api/v1/servers", async () => ({
    servers: await getServerViews(),
    timestamp: Date.now(),
  }));

  app.get("/api/v1/summary", async () => {
    const servers = await getServerViews();
    const online = servers.filter((server) => server.online);
    const alerts = repository.getAlerts(100);
    return {
      total: servers.length,
      online: online.length,
      offline: servers.length - online.length,
      critical_alerts: alerts.filter(
        (alert) =>
          alert.severity === "critical" &&
          alert.created_at >= Date.now() - 60 * 60_000,
      ).length,
      rx_bytes_sec: online.reduce(
        (sum, server) => sum + server.status.data.network.rx_bytes_sec,
        0,
      ),
      tx_bytes_sec: online.reduce(
        (sum, server) => sum + server.status.data.network.tx_bytes_sec,
        0,
      ),
      timestamp: Date.now(),
    };
  });

  app.get("/api/v1/servers/:serverId/history", async (request, reply) => {
    const { serverId } = request.params;
    const requestedMinutes = Number.parseInt(request.query?.minutes ?? "60", 10);
    const minutes = Number.isFinite(requestedMinutes)
      ? Math.min(Math.max(requestedMinutes, 1), 10_080)
      : 60;
    const exists = repository
      .getServers()
      .some((server) => server.server_id === serverId);
    if (!exists) {
      return reply.code(404).send({ error: "server_not_found" });
    }
    return {
      server_id: serverId,
      minutes,
      points: repository.getHistory(serverId, minutes),
    };
  });

  app.get("/api/v1/alerts", async (request) => {
    const requestedLimit = Number.parseInt(request.query?.limit ?? "50", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;
    return { alerts: repository.getAlerts(limit) };
  });

  app.get("/ws/dashboard", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin, config)) {
      socket.close(4003, "origin_not_allowed");
      return;
    }

    dashboardSockets.add(socket);
    safeSend(socket, {
      type: "dashboard.ready",
      timestamp: Date.now(),
      batch_interval_ms: config.dashboardBatchMs,
    });
    socket.on("close", () => dashboardSockets.delete(socket));
    socket.on("error", () => dashboardSockets.delete(socket));
  });

  app.get("/ws/agent", { websocket: true }, (socket, request) => {
    let session = null;
    let lastMessageAt = 0;
    let lastSequence = -1;
    let messageChain = Promise.resolve();

    const authTimer = setTimeout(() => {
      if (!session) {
        socket.close(4001, "authentication_timeout");
      }
    }, config.authTimeoutMs);

    async function handleMessage(raw) {
      const now = Date.now();
      if (now - lastMessageAt < 150) {
        socket.close(4008, "rate_limit");
        return;
      }
      lastMessageAt = now;

      const message = parseJson(raw);
      if (!message) {
        safeSend(socket, { type: "error", code: "invalid_json" });
        return;
      }

      if (!session) {
        const result = validateAuthMessage(message);
        if (!result.ok) {
          socket.close(4001, result.error);
          return;
        }

        const expectedToken = config.agentTokens.get(result.value.server_id);
        if (!expectedToken || !constantTimeEqual(result.value.token, expectedToken)) {
          app.log.warn(
            { serverId: result.value.server_id, remoteAddress: request.ip },
            "Agent authentication failed",
          );
          socket.close(4001, "authentication_failed");
          return;
        }

        const oldSocket = activeAgents.get(result.value.server_id);
        if (oldSocket && oldSocket !== socket) {
          oldSocket.close(4009, "connection_replaced");
        }

        session = {
          id: crypto.randomUUID(),
          serverId: result.value.server_id,
        };
        activeAgents.set(session.serverId, socket);
        repository.upsertServer(result.value, now);
        clearTimeout(authTimer);
        safeSend(socket, {
          type: "auth_ack",
          status: "ok",
          session_id: session.id,
          server_id: session.serverId,
          status_ttl_ms: config.statusTtlMs,
          server_time: now,
        });
        return;
      }

      const result = validateMetricsMessage(message, session.serverId);
      if (!result.ok) {
        safeSend(socket, {
          type: "error",
          code: result.error,
          sequence: message.sequence ?? null,
        });
        return;
      }

      if (
        result.value.sequence !== null &&
        result.value.sequence <= lastSequence
      ) {
        safeSend(socket, {
          type: "error",
          code: "duplicate_or_out_of_order_sequence",
          sequence: result.value.sequence,
        });
        return;
      }
      if (result.value.sequence !== null) {
        lastSequence = result.value.sequence;
      }

      const receivedAt = Date.now();
      const status = {
        server_id: session.serverId,
        session_id: session.id,
        sequence: result.value.sequence,
        agent_timestamp: result.value.timestamp * 1000,
        received_at: receivedAt,
        data: result.value.data,
      };

      await statusStore.setStatus(
        session.serverId,
        status,
        config.statusTtlMs,
      );
      repository.touchServer(session.serverId, receivedAt);
      repository.addSample(session.serverId, result.value.data, receivedAt);
      alertEngine.evaluate(session.serverId, result.value.data, receivedAt);
      pendingDashboardMetrics.set(session.serverId, status);

      if (!onlineServers.has(session.serverId)) {
        onlineServers.add(session.serverId);
        broadcast({
          type: "server.online",
          server_id: session.serverId,
          timestamp: receivedAt,
        });
      }

      safeSend(socket, {
        type: "ack",
        status: "ok",
        sequence: result.value.sequence,
        server_time: receivedAt,
      });
    }

    socket.on("message", (raw) => {
      messageChain = messageChain
        .then(() => handleMessage(raw))
        .catch((error) => {
          app.log.error(error, "Agent message processing failed");
          socket.close(1011, "internal_error");
        });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (session && activeAgents.get(session.serverId) === socket) {
        activeAgents.delete(session.serverId);
      }
    });
    socket.on("error", (error) => {
      app.log.debug(error, "Agent socket error");
    });
  });

  const batchTimer = setInterval(() => {
    if (pendingDashboardMetrics.size === 0) {
      return;
    }
    broadcast({
      type: "server.metrics.batch",
      timestamp: Date.now(),
      updates: Array.from(pendingDashboardMetrics.values()),
    });
    pendingDashboardMetrics.clear();
  }, config.dashboardBatchMs);
  timers.add(batchTimer);

  const offlineTimer = setInterval(async () => {
    try {
      const servers = repository.getServers();
      const statuses = await statusStore.getStatuses(
        servers.map((server) => server.server_id),
      );

      for (let index = 0; index < servers.length; index += 1) {
        const server = servers[index];
        if (statuses[index] || !onlineServers.has(server.server_id)) {
          continue;
        }

        onlineServers.delete(server.server_id);
        await statusStore.removeOnline(server.server_id);
        const event = {
          type: "server.offline",
          server_id: server.server_id,
          last_seen_at: server.last_seen_at,
          timestamp: Date.now(),
        };
        broadcast(event);
        alertEngine.createOfflineAlert(
          server.server_id,
          server.last_seen_at ?? Date.now(),
          event.timestamp,
        );
      }
    } catch (error) {
      app.log.error(error, "Offline sweep failed");
    }
  }, config.offlineSweepMs);
  timers.add(offlineTimer);

  const existingServers = repository.getServers();
  const existingStatuses = await statusStore.getStatuses(
    existingServers.map((server) => server.server_id),
  );
  existingServers.forEach((server, index) => {
    if (existingStatuses[index]) {
      onlineServers.add(server.server_id);
    }
  });

  app.addHook("onClose", async () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
    for (const socket of activeAgents.values()) {
      socket.close(1001, "server_shutdown");
    }
    for (const socket of dashboardSockets) {
      socket.close(1001, "server_shutdown");
    }
    await statusStore.close();
    repository.close();
  });

  app.decorate("probeContext", {
    config,
    repository,
    statusStore,
    activeAgents,
    dashboardSockets,
  });

  return app;
}

async function start() {
  const app = await buildServer();
  await app.listen({
    host: app.probeContext.config.host,
    port: app.probeContext.config.port,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
