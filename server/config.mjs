import path from "node:path";

const DEV_TOKENS = {
  "vps-us-01": "dev-us-token-change-me",
  "vps-hk-01": "dev-hk-token-change-me",
  "vps-de-01": "dev-de-token-change-me",
};

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAgentTokens(rawValue) {
  if (!rawValue) {
    return new Map(Object.entries(DEV_TOKENS));
  }

  const parsed = JSON.parse(rawValue);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("AGENT_TOKENS_JSON must be a JSON object");
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error("AGENT_TOKENS_JSON must contain at least one agent");
  }

  return new Map(
    entries.map(([serverId, token]) => {
      if (typeof token !== "string" || token.length < 16) {
        throw new Error(`Token for ${serverId} must contain at least 16 characters`);
      }
      return [serverId, token];
    }),
  );
}

export function loadConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const agentTokens =
    overrides.agentTokens ?? parseAgentTokens(process.env.AGENT_TOKENS_JSON);

  if (nodeEnv === "production" && !process.env.AGENT_TOKENS_JSON) {
    throw new Error("Production requires AGENT_TOKENS_JSON with per-agent tokens");
  }

  return {
    nodeEnv,
    host: overrides.host ?? process.env.HOST ?? "0.0.0.0",
    port: overrides.port ?? positiveInteger(process.env.PORT, 8080),
    dataDir:
      overrides.dataDir ??
      process.env.DATA_DIR ??
      path.resolve(process.cwd(), ".data"),
    redisUrl: overrides.redisUrl ?? process.env.REDIS_URL ?? "",
    agentTokens,
    statusTtlMs:
      overrides.statusTtlMs ??
      positiveInteger(process.env.STATUS_TTL_MS, 10_000),
    offlineSweepMs:
      overrides.offlineSweepMs ??
      positiveInteger(process.env.OFFLINE_SWEEP_MS, 5_000),
    dashboardBatchMs:
      overrides.dashboardBatchMs ??
      positiveInteger(process.env.DASHBOARD_BATCH_MS, 1_000),
    authTimeoutMs:
      overrides.authTimeoutMs ??
      positiveInteger(process.env.AUTH_TIMEOUT_MS, 5_000),
    alertConsecutive:
      overrides.alertConsecutive ??
      positiveInteger(process.env.ALERT_CONSECUTIVE, 3),
    alertCooldownMs:
      overrides.alertCooldownMs ??
      positiveInteger(process.env.ALERT_COOLDOWN_MS, 600_000),
    metricsRetentionDays:
      overrides.metricsRetentionDays ??
      positiveInteger(process.env.METRICS_RETENTION_DAYS, 30),
    alertRetentionDays:
      overrides.alertRetentionDays ??
      positiveInteger(process.env.ALERT_RETENTION_DAYS, 90),
    trafficResetDay: Math.min(
      overrides.trafficResetDay ??
        positiveInteger(process.env.TRAFFIC_RESET_DAY, 1),
      28,
    ),
    pruneIntervalMs:
      overrides.pruneIntervalMs ??
      positiveInteger(process.env.PRUNE_INTERVAL_MS, 3_600_000),
    webhookUrl: overrides.webhookUrl ?? process.env.WEBHOOK_URL ?? "",
    webhookSecret:
      overrides.webhookSecret ?? process.env.WEBHOOK_SECRET ?? "",
    allowedOrigins:
      overrides.allowedOrigins ??
      (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    logger: overrides.logger ?? nodeEnv !== "test",
  };
}

