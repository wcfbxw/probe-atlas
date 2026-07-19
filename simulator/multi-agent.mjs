import WebSocket from "ws";

const PROFILES = [
  {
    serverId: "vps-us-01",
    token: "dev-us-token-change-me",
    displayName: "美国 · 硅谷 01",
    hostname: "node-us-silicon-01",
    region: "北美",
    provider: "EdgeCloud",
    os: "Ubuntu 22.04 LTS",
    arch: "amd64",
    cpuModel: "AMD EPYC 7763",
    cpuCores: 4,
    memTotal: 8192,
    diskTotal: 81_920,
    baseCpu: 24,
    baseMemory: 42,
    baseRx: 2_400_000,
    baseTx: 980_000,
    phase: 0.4,
    tags: ["production", "api"],
  },
  {
    serverId: "vps-hk-01",
    token: "dev-hk-token-change-me",
    displayName: "香港 · 九龙 01",
    hostname: "node-hk-kowloon-01",
    region: "亚洲",
    provider: "OrbitHost",
    os: "Debian 12",
    arch: "amd64",
    cpuModel: "Intel Xeon Gold 6338",
    cpuCores: 8,
    memTotal: 16_384,
    diskTotal: 163_840,
    baseCpu: 46,
    baseMemory: 63,
    baseRx: 4_100_000,
    baseTx: 2_600_000,
    phase: 1.7,
    tags: ["production", "gateway"],
  },
  {
    serverId: "vps-de-01",
    token: "dev-de-token-change-me",
    displayName: "德国 · 法兰克福 01",
    hostname: "node-de-frankfurt-01",
    region: "欧洲",
    provider: "Northstar",
    os: "Ubuntu 24.04 LTS",
    arch: "arm64",
    cpuModel: "Ampere Altra Q80-30",
    cpuCores: 6,
    memTotal: 12_288,
    diskTotal: 122_880,
    baseCpu: 18,
    baseMemory: 37,
    baseRx: 1_800_000,
    baseTx: 1_350_000,
    phase: 2.9,
    tags: ["staging", "worker"],
  },
];

function readArgument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const wsUrl =
  readArgument("--url", process.env.AGENT_WS_URL) ||
  "ws://127.0.0.1:8080/ws/agent";
const durationSeconds = Number.parseInt(readArgument("--duration", "0"), 10) || 0;
const offlineId = readArgument("--offline-id", "");
const offlineAfterSeconds =
  Number.parseInt(readArgument("--offline-after", "0"), 10) || 0;

function buildMetrics(profile, state) {
  const now = Date.now();
  const seconds = now / 1000;
  const wave = Math.sin(seconds / 4 + profile.phase);
  const quickWave = Math.sin(seconds / 1.7 + profile.phase);
  const cpu =
    profile.serverId === "vps-de-01" && state.sequence >= 2 && state.sequence <= 5
      ? 94 + Math.sin(seconds) * 2
      : profile.baseCpu + wave * 12 + quickWave * 4;
  const memory = profile.baseMemory + Math.sin(seconds / 12 + profile.phase) * 5;
  const rx = Math.max(
    0,
    profile.baseRx * (1 + wave * 0.34 + quickWave * 0.12),
  );
  const tx = Math.max(
    0,
    profile.baseTx * (1 + Math.cos(seconds / 5 + profile.phase) * 0.42),
  );
  const intervalSeconds = 2;
  state.totalRx += Math.round(rx * intervalSeconds);
  state.totalTx += Math.round(tx * intervalSeconds);

  return {
    type: "metrics",
    schema_version: 1,
    sequence: state.sequence,
    timestamp: Math.floor(now / 1000),
    server_id: profile.serverId,
    data: {
      cpu: {
        usage_percent: Number(Math.max(0, Math.min(cpu, 100)).toFixed(1)),
        load_1: Number((cpu / 100 * profile.cpuCores).toFixed(2)),
        load_5: Number((cpu / 105 * profile.cpuCores).toFixed(2)),
        load_15: Number((cpu / 110 * profile.cpuCores).toFixed(2)),
      },
      memory: {
        used_mb: Math.round((memory / 100) * profile.memTotal),
        total_mb: profile.memTotal,
        usage_percent: Number(memory.toFixed(1)),
        swap_used_mb: 0,
        swap_total_mb: 2048,
      },
      disk: {
        used_mb: Math.round(profile.diskTotal * (0.34 + profile.phase * 0.02)),
        total_mb: profile.diskTotal,
        usage_percent: Number((34 + profile.phase * 2).toFixed(1)),
        read_bytes_sec: Math.round(210_000 + Math.abs(quickWave) * 820_000),
        write_bytes_sec: Math.round(380_000 + Math.abs(wave) * 1_800_000),
      },
      network: {
        rx_bytes_sec: Math.round(rx),
        tx_bytes_sec: Math.round(tx),
        total_rx_bytes: state.totalRx,
        total_tx_bytes: state.totalTx,
        tcp_connections: {
          established: Math.round(18 + Math.abs(wave) * 24),
          listen: 9,
          time_wait: Math.round(4 + Math.abs(quickWave) * 11),
        },
      },
      uptime_seconds: 864_000 + Math.floor(seconds % 86_400),
    },
  };
}

function runAgent(profile) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      perMessageDeflate: false,
      handshakeTimeout: 5_000,
    });
    const state = {
      sequence: 0,
      totalRx: 12_000_000_000 + Math.round(profile.phase * 1_000_000_000),
      totalTx: 8_000_000_000 + Math.round(profile.phase * 800_000_000),
      timer: null,
      offlineTimer: null,
    };

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          token: profile.token,
          server_id: profile.serverId,
          display_name: profile.displayName,
          hostname: profile.hostname,
          region: profile.region,
          provider: profile.provider,
          tags: profile.tags,
          os: profile.os,
          arch: profile.arch,
          cpu_model: profile.cpuModel,
          cpu_cores: profile.cpuCores,
          mem_total_mb: profile.memTotal,
          disk_total_mb: profile.diskTotal,
        }),
      );
    });

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "auth_ack") {
        console.log(`[sim] ${profile.serverId} authenticated`);
        const send = () => {
          state.sequence += 1;
          socket.send(JSON.stringify(buildMetrics(profile, state)));
        };
        setTimeout(send, 250);
        state.timer = setInterval(send, 2_000);

        if (
          profile.serverId === offlineId &&
          offlineAfterSeconds > 0
        ) {
          state.offlineTimer = setTimeout(() => {
            console.log(`[sim] ${profile.serverId} going offline`);
            socket.close(1000, "simulated_offline");
          }, offlineAfterSeconds * 1_000);
        }
      } else if (message.type === "error") {
        console.error(`[sim] ${profile.serverId}: ${message.code}`);
      }
    });

    socket.on("close", () => {
      clearInterval(state.timer);
      clearTimeout(state.offlineTimer);
      resolve();
    });
    socket.on("error", reject);

    if (durationSeconds > 0) {
      setTimeout(() => socket.close(1000, "simulation_complete"), durationSeconds * 1_000);
    }
  });
}

console.log(`[sim] connecting ${PROFILES.length} agents to ${wsUrl}`);
await Promise.all(PROFILES.map(runAgent));

