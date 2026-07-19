import crypto from "node:crypto";

const RULES = [
  {
    key: "cpu",
    threshold: 90,
    read: (metrics) => metrics.cpu.usage_percent,
    title: "CPU 持续高负载",
    unit: "%",
  },
  {
    key: "memory",
    threshold: 95,
    read: (metrics) => metrics.memory.usage_percent,
    title: "内存使用率过高",
    unit: "%",
  },
];

export class AlertEngine {
  constructor(config, repository, onAlert, logger = console) {
    this.config = config;
    this.repository = repository;
    this.onAlert = onAlert;
    this.logger = logger;
    this.counters = new Map();
    this.cooldowns = new Map();
  }

  evaluate(serverId, metrics, now = Date.now()) {
    const alerts = [];

    for (const rule of RULES) {
      const stateKey = `${serverId}:${rule.key}`;
      const value = rule.read(metrics);
      if (value <= rule.threshold) {
        this.counters.delete(stateKey);
        continue;
      }

      const count = (this.counters.get(stateKey) ?? 0) + 1;
      this.counters.set(stateKey, count);
      const cooldownUntil = this.cooldowns.get(stateKey) ?? 0;
      if (count < this.config.alertConsecutive || cooldownUntil > now) {
        continue;
      }

      const alert = {
        id: crypto.randomUUID(),
        server_id: serverId,
        type: rule.key.toUpperCase(),
        severity: "critical",
        title: rule.title,
        message: `${serverId} 连续 ${count} 次超过 ${rule.threshold}${rule.unit}，当前 ${value.toFixed(1)}${rule.unit}`,
        value,
        threshold: rule.threshold,
        created_at: now,
      };

      this.repository.insertAlert(alert);
      this.cooldowns.set(stateKey, now + this.config.alertCooldownMs);
      alerts.push(alert);
      this.onAlert?.(alert);
      void this.deliverWebhook(alert);
    }

    return alerts;
  }

  createOfflineAlert(serverId, lastSeenAt, now = Date.now()) {
    const alert = {
      id: crypto.randomUUID(),
      server_id: serverId,
      type: "OFFLINE",
      severity: "critical",
      title: "节点离线",
      message: `${serverId} 已超过状态有效期，最后上报时间 ${new Date(lastSeenAt).toISOString()}`,
      value: null,
      threshold: null,
      created_at: now,
    };
    this.repository.insertAlert(alert);
    this.onAlert?.(alert);
    void this.deliverWebhook(alert);
    return alert;
  }

  async deliverWebhook(alert) {
    if (!this.config.webhookUrl) {
      return;
    }

    const body = JSON.stringify(alert);
    const timestamp = Date.now().toString();
    const signature = this.config.webhookSecret
      ? crypto
          .createHmac("sha256", this.config.webhookSecret)
          .update(`${timestamp}.${body}`)
          .digest("hex")
      : "";

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-probe-timestamp": timestamp,
          "x-probe-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }
    } catch (error) {
      this.logger.error(error, "Webhook delivery failed");
    }
  }
}

