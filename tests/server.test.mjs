import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { buildServer } from "../server/index.mjs";
import { SqliteRepository } from "../server/storage.mjs";

const SERVER_ID = "test-node-01";
const TOKEN = "test-node-token-with-enough-entropy";

function authPacket(token = TOKEN) {
  return {
    type: "auth",
    token,
    server_id: SERVER_ID,
    display_name: "测试节点",
    hostname: "test-host",
    region: "本地",
    provider: "Test",
    tags: ["test"],
    os: "Linux",
    arch: "amd64",
    cpu_model: "Test CPU",
    cpu_cores: 4,
    mem_total_mb: 4096,
    disk_total_mb: 40960,
  };
}

function metricsPacket(sequence, cpu = 42, memory = 55) {
  return {
    type: "metrics",
    schema_version: 1,
    sequence,
    timestamp: Math.floor(Date.now() / 1000),
    server_id: SERVER_ID,
    data: {
      cpu: {
        usage_percent: cpu,
        load_1: 1.2,
        load_5: 1.1,
        load_15: 1,
      },
      memory: {
        used_mb: 2048,
        total_mb: 4096,
        usage_percent: memory,
        swap_used_mb: 0,
        swap_total_mb: 1024,
      },
      disk: {
        used_mb: 12000,
        total_mb: 40960,
        usage_percent: 29.3,
        read_bytes_sec: 1000,
        write_bytes_sec: 2000,
      },
      network: {
        rx_bytes_sec: 3000,
        tx_bytes_sec: 4000,
        total_rx_bytes: 100000,
        total_tx_bytes: 200000,
        tcp_connections: {
          established: 12,
          listen: 4,
          time_wait: 2,
        },
      },
      uptime_seconds: 86400,
    },
  };
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      cleanup();
      resolve(JSON.parse(raw.toString()));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("agent authentication, metrics, alerts, history and offline TTL work end-to-end", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "probe-atlas-test-"));
  const app = await buildServer({
    nodeEnv: "test",
    logger: false,
    dataDir,
    agentTokens: new Map([[SERVER_ID, TOKEN]]),
    statusTtlMs: 450,
    offlineSweepMs: 100,
    dashboardBatchMs: 100,
    alertConsecutive: 3,
    alertCooldownMs: 10_000,
  });

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wsUrl = `ws://127.0.0.1:${address.port}/ws/agent`;

    const invalidSocket = new WebSocket(wsUrl);
    await once(invalidSocket, "open");
    invalidSocket.send(JSON.stringify(authPacket("invalid-test-token")));
    const [invalidCode] = await once(invalidSocket, "close");
    assert.equal(invalidCode, 4001);

    const socket = new WebSocket(wsUrl);
    await once(socket, "open");
    socket.send(JSON.stringify(authPacket()));
    const authAck = await nextJson(socket);
    assert.equal(authAck.type, "auth_ack");
    assert.equal(authAck.server_id, SERVER_ID);

    await delay(170);
    socket.send(JSON.stringify(metricsPacket(1)));
    assert.equal((await nextJson(socket)).type, "ack");

    let serversPayload = await fetch(`${baseUrl}/api/v1/servers`).then((response) =>
      response.json(),
    );
    assert.equal(serversPayload.servers.length, 1);
    assert.equal(serversPayload.servers[0].online, true);
    assert.equal(
      serversPayload.servers[0].status.data.network.rx_bytes_sec,
      3000,
    );

    for (let sequence = 2; sequence <= 4; sequence += 1) {
      await delay(170);
      socket.send(JSON.stringify(metricsPacket(sequence, 96)));
      assert.equal((await nextJson(socket)).type, "ack");
    }

    const alertPayload = await fetch(`${baseUrl}/api/v1/alerts`).then((response) =>
      response.json(),
    );
    assert.ok(alertPayload.alerts.some((alert) => alert.type === "CPU"));

    const historyPayload = await fetch(
      `${baseUrl}/api/v1/servers/${SERVER_ID}/history?minutes=5`,
    ).then((response) => response.json());
    assert.equal(historyPayload.server_id, SERVER_ID);
    assert.equal(historyPayload.points.length, 1);
    assert.equal(historyPayload.points[0].samples, 4);

    socket.close(1000, "test_offline");
    await once(socket, "close");
    await delay(750);

    serversPayload = await fetch(`${baseUrl}/api/v1/servers`).then((response) =>
      response.json(),
    );
    assert.equal(serversPayload.servers[0].online, false);

    const offlineAlerts = await fetch(`${baseUrl}/api/v1/alerts`).then(
      (response) => response.json(),
    );
    assert.ok(offlineAlerts.alerts.some((alert) => alert.type === "OFFLINE"));
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("prune removes history and alerts older than the retention cutoff", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "probe-atlas-test-"));
  const repository = new SqliteRepository(dataDir);
  const now = Date.now();
  const day = 86_400_000;

  try {
    const { data } = metricsPacket(1);
    repository.addSample(SERVER_ID, data, now - 40 * day);
    repository.addSample(SERVER_ID, data, now);
    for (const [id, createdAt] of [["old", now - 100 * day], ["new", now]]) {
      repository.insertAlert({
        id,
        server_id: SERVER_ID,
        type: "CPU",
        severity: "critical",
        title: "test",
        message: "test",
        created_at: createdAt,
      });
    }

    const removed = repository.prune({
      metricsBefore: now - 30 * day,
      alertsBefore: now - 90 * day,
    });
    assert.deepEqual(removed, { metrics: 1, alerts: 1 });
    assert.equal(repository.getHistory(SERVER_ID, 60 * 24 * 60).length, 1);
    assert.deepEqual(
      repository.getAlerts().map((alert) => alert.id),
      ["new"],
    );
  } finally {
    repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

