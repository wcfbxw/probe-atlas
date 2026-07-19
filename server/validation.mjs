const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function finiteNumber(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function optionalFinite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return value === undefined || finiteNumber(value, min, max);
}

function stringValue(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function safeString(value, fallback, maxLength = 160) {
  return stringValue(value, maxLength) ? value : fallback;
}

export function isValidServerId(value) {
  return typeof value === "string" && SERVER_ID_PATTERN.test(value);
}

export function validateAuthMessage(message) {
  if (
    !message ||
    message.type !== "auth" ||
    !isValidServerId(message.server_id) ||
    !stringValue(message.token, 512)
  ) {
    return { ok: false, error: "invalid_auth_packet" };
  }

  return {
    ok: true,
    value: {
      server_id: message.server_id,
      token: message.token,
      hostname: safeString(message.hostname, message.server_id, 160),
      os: safeString(message.os, "Unknown", 200),
      arch: safeString(message.arch, "unknown", 40),
      cpu_model: safeString(message.cpu_model, "Unknown CPU", 200),
      cpu_cores: finiteNumber(message.cpu_cores, 1, 4096)
        ? Math.round(message.cpu_cores)
        : 1,
      mem_total_mb: finiteNumber(message.mem_total_mb, 1)
        ? Math.round(message.mem_total_mb)
        : 0,
      disk_total_mb: finiteNumber(message.disk_total_mb, 1)
        ? Math.round(message.disk_total_mb)
        : 0,
      display_name: safeString(message.display_name, message.hostname ?? message.server_id, 160),
      region: safeString(message.region, "未分组", 80),
      provider: safeString(message.provider, "自建", 80),
      tags: Array.isArray(message.tags)
        ? message.tags
            .filter((tag) => typeof tag === "string" && tag.length <= 32)
            .slice(0, 8)
        : [],
    },
  };
}

export function validateMetricsMessage(message, authenticatedServerId) {
  if (
    !message ||
    message.type !== "metrics" ||
    message.server_id !== authenticatedServerId ||
    !finiteNumber(message.timestamp, 1) ||
    !message.data ||
    typeof message.data !== "object"
  ) {
    return { ok: false, error: "invalid_metrics_envelope" };
  }

  const { cpu, memory, disk, network, uptime_seconds: uptime } = message.data;
  if (
    !cpu ||
    !memory ||
    !disk ||
    !network ||
    !finiteNumber(cpu.usage_percent, 0, 100) ||
    !finiteNumber(cpu.load_1, 0, 100_000) ||
    !optionalFinite(cpu.load_5, 0, 100_000) ||
    !optionalFinite(cpu.load_15, 0, 100_000) ||
    !finiteNumber(memory.used_mb, 0) ||
    !finiteNumber(memory.total_mb, 1) ||
    !finiteNumber(memory.usage_percent, 0, 100) ||
    !optionalFinite(memory.swap_used_mb, 0) ||
    !optionalFinite(memory.swap_total_mb, 0) ||
    !finiteNumber(disk.used_mb, 0) ||
    !finiteNumber(disk.total_mb, 1) ||
    !finiteNumber(disk.usage_percent, 0, 100) ||
    !optionalFinite(disk.read_bytes_sec, 0) ||
    !optionalFinite(disk.write_bytes_sec, 0) ||
    !finiteNumber(network.rx_bytes_sec, 0) ||
    !finiteNumber(network.tx_bytes_sec, 0) ||
    !finiteNumber(network.total_rx_bytes, 0) ||
    !finiteNumber(network.total_tx_bytes, 0) ||
    !finiteNumber(uptime, 0)
  ) {
    return { ok: false, error: "invalid_metrics_data" };
  }

  const tcp = network.tcp_connections ?? {};
  if (
    !optionalFinite(tcp.established, 0, 10_000_000) ||
    !optionalFinite(tcp.listen, 0, 10_000_000) ||
    !optionalFinite(tcp.time_wait, 0, 10_000_000)
  ) {
    return { ok: false, error: "invalid_tcp_metrics" };
  }

  return {
    ok: true,
    value: {
      type: "metrics",
      schema_version: Number.isInteger(message.schema_version)
        ? message.schema_version
        : 1,
      sequence: Number.isSafeInteger(message.sequence) ? message.sequence : null,
      timestamp: Math.trunc(message.timestamp),
      server_id: authenticatedServerId,
      data: {
        cpu: {
          usage_percent: cpu.usage_percent,
          load_1: cpu.load_1,
          load_5: cpu.load_5 ?? cpu.load_1,
          load_15: cpu.load_15 ?? cpu.load_1,
        },
        memory: {
          used_mb: Math.round(memory.used_mb),
          total_mb: Math.round(memory.total_mb),
          usage_percent: memory.usage_percent,
          swap_used_mb: Math.round(memory.swap_used_mb ?? 0),
          swap_total_mb: Math.round(memory.swap_total_mb ?? 0),
        },
        disk: {
          used_mb: Math.round(disk.used_mb),
          total_mb: Math.round(disk.total_mb),
          usage_percent: disk.usage_percent,
          read_bytes_sec: Math.round(disk.read_bytes_sec ?? 0),
          write_bytes_sec: Math.round(disk.write_bytes_sec ?? 0),
        },
        network: {
          rx_bytes_sec: Math.round(network.rx_bytes_sec),
          tx_bytes_sec: Math.round(network.tx_bytes_sec),
          total_rx_bytes: Math.round(network.total_rx_bytes),
          total_tx_bytes: Math.round(network.total_tx_bytes),
          tcp_connections: {
            established: Math.round(tcp.established ?? 0),
            listen: Math.round(tcp.listen ?? 0),
            time_wait: Math.round(tcp.time_wait ?? 0),
          },
        },
        uptime_seconds: Math.round(uptime),
      },
    },
  };
}

