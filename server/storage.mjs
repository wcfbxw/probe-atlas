import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "redis";

export class MemoryStatusStore {
  constructor() {
    this.mode = "memory";
    this.statuses = new Map();
    this.online = new Set();
  }

  async init() {}

  async close() {
    this.statuses.clear();
    this.online.clear();
  }

  async setStatus(serverId, status, ttlMs) {
    this.statuses.set(serverId, {
      value: status,
      expiresAt: Date.now() + ttlMs,
    });
    this.online.add(serverId);
  }

  async getStatuses(serverIds) {
    const now = Date.now();
    return serverIds.map((serverId) => {
      const entry = this.statuses.get(serverId);
      if (!entry || entry.expiresAt <= now) {
        this.statuses.delete(serverId);
        return null;
      }
      return entry.value;
    });
  }

  async removeOnline(serverId) {
    this.online.delete(serverId);
  }
}

export class RedisStatusStore {
  constructor(redisUrl, logger = console) {
    this.mode = "redis";
    this.client = createClient({ url: redisUrl });
    this.client.on("error", (error) => logger.error(error, "Redis connection error"));
  }

  async init() {
    await this.client.connect();
  }

  async close() {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  async setStatus(serverId, status, ttlMs) {
    const transaction = this.client.multi();
    transaction.set(`server:status:${serverId}`, JSON.stringify(status), {
      PX: ttlMs,
    });
    transaction.sAdd("server:online_set", serverId);
    transaction.zAdd("server:last_seen", {
      score: status.received_at,
      value: serverId,
    });
    await transaction.exec();
  }

  async getStatuses(serverIds) {
    if (serverIds.length === 0) {
      return [];
    }
    const values = await this.client.mGet(
      serverIds.map((serverId) => `server:status:${serverId}`),
    );
    return values.map((value) => (value ? JSON.parse(value) : null));
  }

  async removeOnline(serverId) {
    await this.client.sRem("server:online_set", serverId);
  }
}

export function createStatusStore(config, logger) {
  return config.redisUrl
    ? new RedisStatusStore(config.redisUrl, logger)
    : new MemoryStatusStore();
}

function trafficView(row, periodStart) {
  const samePeriod = row?.period_start === periodStart;
  return {
    period_start: periodStart,
    month_rx_bytes: samePeriod ? row.period_rx : 0,
    month_tx_bytes: samePeriod ? row.period_tx : 0,
    total_rx_bytes: row?.total_rx ?? 0,
    total_tx_bytes: row?.total_tx ?? 0,
  };
}

// Start (YYYY-MM-DD, server local time) of the billing month containing `now`.
export function trafficPeriodStart(now, resetDay = 1) {
  const date = new Date(now);
  let year = date.getFullYear();
  let month = date.getMonth();
  if (date.getDate() < resetDay) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(resetDay).padStart(2, "0")}`;
}

export class SqliteRepository {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "probe.sqlite");
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        server_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        region TEXT NOT NULL,
        provider TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        os TEXT NOT NULL,
        arch TEXT NOT NULL,
        cpu_model TEXT NOT NULL,
        cpu_cores INTEGER NOT NULL,
        mem_total_mb INTEGER NOT NULL,
        disk_total_mb INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS metrics_1m (
        server_id TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        cpu_sum REAL NOT NULL,
        cpu_max REAL NOT NULL,
        memory_sum REAL NOT NULL,
        memory_max REAL NOT NULL,
        load_1_sum REAL NOT NULL,
        disk_usage_last REAL NOT NULL,
        disk_read_sum REAL NOT NULL,
        disk_read_max REAL NOT NULL,
        disk_write_sum REAL NOT NULL,
        disk_write_max REAL NOT NULL,
        network_rx_sum REAL NOT NULL,
        network_rx_max REAL NOT NULL,
        network_tx_sum REAL NOT NULL,
        network_tx_max REAL NOT NULL,
        total_rx_last INTEGER NOT NULL,
        total_tx_last INTEGER NOT NULL,
        tcp_established_max INTEGER NOT NULL,
        uptime_last INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, bucket_ts)
      );

      CREATE INDEX IF NOT EXISTS metrics_1m_server_time_idx
        ON metrics_1m (server_id, bucket_ts DESC);

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        value REAL,
        threshold REAL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS alerts_created_idx
        ON alerts (created_at DESC);

      CREATE TABLE IF NOT EXISTS traffic_counters (
        server_id TEXT PRIMARY KEY,
        last_rx INTEGER NOT NULL,
        last_tx INTEGER NOT NULL,
        last_uptime INTEGER NOT NULL,
        total_rx INTEGER NOT NULL DEFAULT 0,
        total_tx INTEGER NOT NULL DEFAULT 0,
        period_start TEXT NOT NULL,
        period_rx INTEGER NOT NULL DEFAULT 0,
        period_tx INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  prepare() {
    this.upsertServerStatement = this.db.prepare(`
      INSERT INTO servers (
        server_id, display_name, hostname, region, provider, tags_json,
        os, arch, cpu_model, cpu_cores, mem_total_mb, disk_total_mb,
        created_at, updated_at, last_seen_at
      ) VALUES (
        @server_id, @display_name, @hostname, @region, @provider, @tags_json,
        @os, @arch, @cpu_model, @cpu_cores, @mem_total_mb, @disk_total_mb,
        @now, @now, NULL
      )
      ON CONFLICT(server_id) DO UPDATE SET
        display_name = excluded.display_name,
        hostname = excluded.hostname,
        region = excluded.region,
        provider = excluded.provider,
        tags_json = excluded.tags_json,
        os = excluded.os,
        arch = excluded.arch,
        cpu_model = excluded.cpu_model,
        cpu_cores = excluded.cpu_cores,
        mem_total_mb = excluded.mem_total_mb,
        disk_total_mb = excluded.disk_total_mb,
        updated_at = excluded.updated_at
    `);

    this.touchServerStatement = this.db.prepare(`
      UPDATE servers
      SET last_seen_at = ?, updated_at = ?
      WHERE server_id = ?
    `);

    this.addSampleStatement = this.db.prepare(`
      INSERT INTO metrics_1m (
        server_id, bucket_ts, sample_count,
        cpu_sum, cpu_max, memory_sum, memory_max, load_1_sum,
        disk_usage_last, disk_read_sum, disk_read_max,
        disk_write_sum, disk_write_max,
        network_rx_sum, network_rx_max, network_tx_sum, network_tx_max,
        total_rx_last, total_tx_last, tcp_established_max,
        uptime_last, updated_at
      ) VALUES (
        @server_id, @bucket_ts, 1,
        @cpu, @cpu, @memory, @memory, @load_1,
        @disk_usage, @disk_read, @disk_read,
        @disk_write, @disk_write,
        @network_rx, @network_rx, @network_tx, @network_tx,
        @total_rx, @total_tx, @tcp_established,
        @uptime, @updated_at
      )
      ON CONFLICT(server_id, bucket_ts) DO UPDATE SET
        sample_count = sample_count + 1,
        cpu_sum = cpu_sum + excluded.cpu_sum,
        cpu_max = MAX(cpu_max, excluded.cpu_max),
        memory_sum = memory_sum + excluded.memory_sum,
        memory_max = MAX(memory_max, excluded.memory_max),
        load_1_sum = load_1_sum + excluded.load_1_sum,
        disk_usage_last = excluded.disk_usage_last,
        disk_read_sum = disk_read_sum + excluded.disk_read_sum,
        disk_read_max = MAX(disk_read_max, excluded.disk_read_max),
        disk_write_sum = disk_write_sum + excluded.disk_write_sum,
        disk_write_max = MAX(disk_write_max, excluded.disk_write_max),
        network_rx_sum = network_rx_sum + excluded.network_rx_sum,
        network_rx_max = MAX(network_rx_max, excluded.network_rx_max),
        network_tx_sum = network_tx_sum + excluded.network_tx_sum,
        network_tx_max = MAX(network_tx_max, excluded.network_tx_max),
        total_rx_last = excluded.total_rx_last,
        total_tx_last = excluded.total_tx_last,
        tcp_established_max = MAX(tcp_established_max, excluded.tcp_established_max),
        uptime_last = excluded.uptime_last,
        updated_at = excluded.updated_at
    `);

    this.insertAlertStatement = this.db.prepare(`
      INSERT OR IGNORE INTO alerts (
        id, server_id, type, severity, title, message,
        value, threshold, created_at
      ) VALUES (
        @id, @server_id, @type, @severity, @title, @message,
        @value, @threshold, @created_at
      )
    `);

    this.getTrafficStatement = this.db.prepare(
      "SELECT * FROM traffic_counters WHERE server_id = ?",
    );

    this.saveTrafficStatement = this.db.prepare(`
      INSERT INTO traffic_counters (
        server_id, last_rx, last_tx, last_uptime, total_rx, total_tx,
        period_start, period_rx, period_tx, updated_at
      ) VALUES (
        @server_id, @last_rx, @last_tx, @last_uptime, @total_rx, @total_tx,
        @period_start, @period_rx, @period_tx, @updated_at
      )
      ON CONFLICT(server_id) DO UPDATE SET
        last_rx = excluded.last_rx,
        last_tx = excluded.last_tx,
        last_uptime = excluded.last_uptime,
        total_rx = excluded.total_rx,
        total_tx = excluded.total_tx,
        period_start = excluded.period_start,
        period_rx = excluded.period_rx,
        period_tx = excluded.period_tx,
        updated_at = excluded.updated_at
    `);

    this.pruneMetricsStatement = this.db.prepare(
      "DELETE FROM metrics_1m WHERE bucket_ts < ?",
    );
    this.pruneAlertsStatement = this.db.prepare(
      "DELETE FROM alerts WHERE created_at < ?",
    );
  }

  upsertServer(metadata, now = Date.now()) {
    this.upsertServerStatement.run({
      server_id: metadata.server_id,
      display_name: metadata.display_name,
      hostname: metadata.hostname,
      region: metadata.region,
      provider: metadata.provider,
      tags_json: JSON.stringify(metadata.tags ?? []),
      os: metadata.os,
      arch: metadata.arch,
      cpu_model: metadata.cpu_model,
      cpu_cores: metadata.cpu_cores,
      mem_total_mb: metadata.mem_total_mb,
      disk_total_mb: metadata.disk_total_mb,
      now,
    });
  }

  touchServer(serverId, now = Date.now()) {
    this.touchServerStatement.run(now, now, serverId);
  }

  addSample(serverId, metrics, receivedAt = Date.now()) {
    const bucketTs = Math.floor(receivedAt / 60_000) * 60_000;
    this.addSampleStatement.run({
      server_id: serverId,
      bucket_ts: bucketTs,
      cpu: metrics.cpu.usage_percent,
      memory: metrics.memory.usage_percent,
      load_1: metrics.cpu.load_1,
      disk_usage: metrics.disk.usage_percent,
      disk_read: metrics.disk.read_bytes_sec,
      disk_write: metrics.disk.write_bytes_sec,
      network_rx: metrics.network.rx_bytes_sec,
      network_tx: metrics.network.tx_bytes_sec,
      total_rx: metrics.network.total_rx_bytes,
      total_tx: metrics.network.total_tx_bytes,
      tcp_established: metrics.network.tcp_connections.established,
      uptime: metrics.uptime_seconds,
      updated_at: receivedAt,
    });
  }

  getServers() {
    return this.db
      .prepare("SELECT * FROM servers ORDER BY region, display_name")
      .all()
      .map((row) => ({
        ...row,
        tags: JSON.parse(row.tags_json),
        tags_json: undefined,
      }));
  }

  getHistory(serverId, minutes = 60) {
    const from = Date.now() - minutes * 60_000;
    return this.db
      .prepare(`
        SELECT *
        FROM metrics_1m
        WHERE server_id = ? AND bucket_ts >= ?
        ORDER BY bucket_ts ASC
      `)
      .all(serverId, from)
      .map((row) => ({
        timestamp: row.bucket_ts,
        samples: row.sample_count,
        cpu_avg: row.cpu_sum / row.sample_count,
        cpu_max: row.cpu_max,
        memory_avg: row.memory_sum / row.sample_count,
        memory_max: row.memory_max,
        load_1_avg: row.load_1_sum / row.sample_count,
        disk_usage: row.disk_usage_last,
        disk_read_avg: row.disk_read_sum / row.sample_count,
        disk_read_max: row.disk_read_max,
        disk_write_avg: row.disk_write_sum / row.sample_count,
        disk_write_max: row.disk_write_max,
        network_rx_avg: row.network_rx_sum / row.sample_count,
        network_rx_max: row.network_rx_max,
        network_tx_avg: row.network_tx_sum / row.sample_count,
        network_tx_max: row.network_tx_max,
        total_rx: row.total_rx_last,
        total_tx: row.total_tx_last,
        tcp_established_max: row.tcp_established_max,
        uptime: row.uptime_last,
      }));
  }

  insertAlert(alert) {
    this.insertAlertStatement.run({
      ...alert,
      value: alert.value ?? null,
      threshold: alert.threshold ?? null,
    });
  }

  getAlerts(limit = 50) {
    return this.db
      .prepare("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  // Agents report interface counters since boot; accumulate the deltas so the
  // monthly and all-time totals survive reboots and control-server restarts.
  recordTraffic(serverId, metrics, periodStart, now = Date.now()) {
    const rx = metrics.network.total_rx_bytes;
    const tx = metrics.network.total_tx_bytes;
    const uptime = metrics.uptime_seconds;
    const row = this.getTrafficStatement.get(serverId);

    let deltaRx = 0;
    let deltaTx = 0;
    if (row) {
      if (uptime < row.last_uptime) {
        // Rebooted: the counters restarted from zero.
        deltaRx = rx;
        deltaTx = tx;
      } else if (rx >= row.last_rx && tx >= row.last_tx) {
        deltaRx = rx - row.last_rx;
        deltaTx = tx - row.last_tx;
      }
      // Otherwise the counters went backwards without a reboot (e.g. the
      // agent changed which interfaces it counts): only move the baseline.
    }

    const samePeriod = row?.period_start === periodStart;
    const next = {
      server_id: serverId,
      last_rx: rx,
      last_tx: tx,
      last_uptime: uptime,
      total_rx: (row?.total_rx ?? 0) + deltaRx,
      total_tx: (row?.total_tx ?? 0) + deltaTx,
      period_start: periodStart,
      period_rx: (samePeriod ? row.period_rx : 0) + deltaRx,
      period_tx: (samePeriod ? row.period_tx : 0) + deltaTx,
      updated_at: now,
    };
    this.saveTrafficStatement.run(next);
    return trafficView(next, periodStart);
  }

  getTraffic(serverId, periodStart) {
    return trafficView(this.getTrafficStatement.get(serverId), periodStart);
  }

  prune({ metricsBefore, alertsBefore }) {
    return {
      metrics: Number(this.pruneMetricsStatement.run(metricsBefore).changes),
      alerts: Number(this.pruneAlertsStatement.run(alertsBefore).changes),
    };
  }

  close() {
    this.db.close();
  }
}
