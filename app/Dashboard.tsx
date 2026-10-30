"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Cpu,
  Database,
  Globe2,
  HardDrive,
  MemoryStick,
  Radio,
  Search,
  Server,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  NetworkChart,
  type NetworkPoint,
} from "./components/NetworkChart";
import { formatRate } from "./format";

type Metrics = {
  cpu: {
    usage_percent: number;
    load_1: number;
    load_5: number;
    load_15: number;
  };
  memory: {
    used_mb: number;
    total_mb: number;
    usage_percent: number;
  };
  disk: {
    used_mb: number;
    total_mb: number;
    usage_percent: number;
    read_bytes_sec: number;
    write_bytes_sec: number;
  };
  network: {
    rx_bytes_sec: number;
    tx_bytes_sec: number;
    total_rx_bytes: number;
    total_tx_bytes: number;
    tcp_connections: {
      established: number;
      listen: number;
      time_wait: number;
    };
  };
  uptime_seconds: number;
};

type Status = {
  server_id: string;
  received_at: number;
  sequence: number | null;
  data: Metrics;
};

type ServerView = {
  server_id: string;
  display_name: string;
  hostname: string;
  region: string;
  provider: string;
  tags: string[];
  os: string;
  arch: string;
  cpu_model: string;
  cpu_cores: number;
  mem_total_mb: number;
  disk_total_mb: number;
  last_seen_at: number | null;
  connected: boolean;
  online: boolean;
  status: Status | null;
};

type AlertRecord = {
  id: string;
  server_id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  created_at: number;
};

type Filter = "all" | "online" | "offline" | "alert";
type ConnectionState = "connecting" | "live" | "retrying";

const API_BASE =
  process.env.NEXT_PUBLIC_PROBE_API_URL ??
  (typeof window === "undefined"
    ? "http://127.0.0.1:8080"
    : `${window.location.protocol}//${window.location.hostname}:8080`);
const WS_BASE = API_BASE.replace(/^http/, "ws");

function formatSize(megabytes = 0) {
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
  return `${Math.round(megabytes)} MB`;
}

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days}天 ${hours}小时` : `${hours}小时`;
}

function relativeTime(timestamp: number | null) {
  if (!timestamp) return "从未上报";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  return `${Math.floor(seconds / 3600)}小时前`;
}

function MetricGauge({
  value,
  label,
  tone = "green",
}: {
  value: number;
  label: string;
  tone?: "green" | "blue" | "amber" | "red";
}) {
  const safeValue = Math.max(0, Math.min(value, 100));
  return (
    <div className="gauge-block">
      <div
        className={`metric-gauge tone-${tone}`}
        style={{ "--gauge-value": `${safeValue * 3.6}deg` } as React.CSSProperties}
      >
        <div className="gauge-center">
          <strong>{safeValue.toFixed(0)}</strong>
          <span>%</span>
        </div>
      </div>
      <span>{label}</span>
    </div>
  );
}

function ProgressMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="progress-metric">
      <div className="progress-label">
        <span>{label}</span>
        <strong>{value.toFixed(1)}%</strong>
      </div>
      <div className="progress-track">
        <span style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <small>{detail}</small>
    </div>
  );
}

function ServerCard({
  server,
  selected,
  hasAlert,
  onSelect,
}: {
  server: ServerView;
  selected: boolean;
  hasAlert: boolean;
  onSelect: () => void;
}) {
  const metrics = server.status?.data;
  const cpu = metrics?.cpu.usage_percent ?? 0;
  const cpuTone = cpu > 90 ? "red" : cpu > 70 ? "amber" : "green";

  return (
    <button
      className={`server-card ${selected ? "is-selected" : ""} ${
        server.online ? "" : "is-offline"
      }`}
      onClick={onSelect}
      type="button"
      aria-label={`查看 ${server.display_name} 详情`}
    >
      <div className="server-card-head">
        <div>
          <div className="server-title-row">
            <span className={`status-dot ${server.online ? "online" : "offline"}`} />
            <h3>{server.display_name}</h3>
          </div>
          <p>{server.hostname}</p>
        </div>
        <div className="card-badges">
          {hasAlert && (
            <span className="alert-badge">
              <AlertTriangle size={12} /> 告警
            </span>
          )}
          <span className="region-badge">{server.region}</span>
        </div>
      </div>

      {server.online && metrics ? (
        <>
          <div className="server-metrics">
            <MetricGauge value={cpu} label="CPU" tone={cpuTone} />
            <div className="metric-stack">
              <ProgressMetric
                label="内存"
                value={metrics.memory.usage_percent}
                detail={`${formatSize(metrics.memory.used_mb)} / ${formatSize(
                  metrics.memory.total_mb,
                )}`}
              />
              <ProgressMetric
                label="磁盘"
                value={metrics.disk.usage_percent}
                detail={`${formatSize(metrics.disk.used_mb)} / ${formatSize(
                  metrics.disk.total_mb,
                )}`}
              />
            </div>
          </div>
          <div className="card-network">
            <span>
              <ArrowDown size={14} /> {formatRate(metrics.network.rx_bytes_sec)}
            </span>
            <span>
              <ArrowUp size={14} /> {formatRate(metrics.network.tx_bytes_sec)}
            </span>
            <small>运行 {formatUptime(metrics.uptime_seconds)}</small>
          </div>
        </>
      ) : (
        <div className="offline-state">
          <WifiOff size={22} />
          <div>
            <strong>节点离线</strong>
            <span>最后上报 {relativeTime(server.last_seen_at)}</span>
          </div>
        </div>
      )}
    </button>
  );
}

export function Dashboard() {
  const [servers, setServers] = useState<ServerView[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [pointsByServer, setPointsByServer] = useState<
    Record<string, NetworkPoint[]>
  >({});
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [connection, setConnection] =
    useState<ConnectionState>("connecting");
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const loadSnapshot = useCallback(async () => {
    const [serverResponse, alertResponse] = await Promise.all([
      fetch(`${API_BASE}/api/v1/servers`, { cache: "no-store" }),
      fetch(`${API_BASE}/api/v1/alerts?limit=50`, { cache: "no-store" }),
    ]);
    if (!serverResponse.ok || !alertResponse.ok) {
      throw new Error("控制服务响应异常");
    }
    const serverPayload = await serverResponse.json();
    const alertPayload = await alertResponse.json();
    setServers(serverPayload.servers);
    setAlerts(alertPayload.alerts);
    setSelectedId((current) => current || serverPayload.servers[0]?.server_id || "");
    setLoadError("");
  }, []);

  useEffect(() => {
    const initialLoad = setTimeout(() => {
      void loadSnapshot().catch((error) => {
        setLoadError(error instanceof Error ? error.message : "无法连接控制服务");
      });
    }, 0);
    return () => clearTimeout(initialLoad);
  }, [loadSnapshot]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      setConnection((current) => (current === "connecting" ? current : "retrying"));
      socket = new WebSocket(`${WS_BASE}/ws/dashboard`);

      socket.addEventListener("open", () => {
        setConnection("live");
        void loadSnapshot();
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "server.metrics.batch") {
          const updates: Status[] = message.updates;
          const updateMap = new Map(
            updates.map((update) => [update.server_id, update]),
          );
          setServers((current) =>
            current.map((server) => {
              const status = updateMap.get(server.server_id);
              return status
                ? {
                    ...server,
                    online: true,
                    connected: true,
                    last_seen_at: status.received_at,
                    status,
                  }
                : server;
            }),
          );
          setPointsByServer((current) => {
            const next = { ...current };
            for (const update of updates) {
              const points = next[update.server_id] ?? [];
              next[update.server_id] = [
                ...points,
                {
                  time: update.received_at,
                  rx: update.data.network.rx_bytes_sec,
                  tx: update.data.network.tx_bytes_sec,
                },
              ].slice(-90);
            }
            return next;
          });
        } else if (message.type === "server.offline") {
          setServers((current) =>
            current.map((server) =>
              server.server_id === message.server_id
                ? { ...server, online: false, connected: false, status: null }
                : server,
            ),
          );
        } else if (message.type === "alert.created") {
          setAlerts((current) => [message.alert, ...current].slice(0, 50));
        }
      });
      socket.addEventListener("close", () => {
        if (!stopped) {
          setConnection("retrying");
          retryTimer = setTimeout(connect, 2_000);
        }
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [loadSnapshot]);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void fetch(`${API_BASE}/api/v1/servers/${selectedId}/history?minutes=60`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!payload) return;
        const historyPoints: NetworkPoint[] = payload.points.map(
          (point: {
            timestamp: number;
            network_rx_avg: number;
            network_tx_avg: number;
          }) => ({
            time: point.timestamp,
            rx: point.network_rx_avg,
            tx: point.network_tx_avg,
          }),
        );
        setPointsByServer((current) => ({
          ...current,
          [selectedId]: [...historyPoints, ...(current[selectedId] ?? [])].slice(-90),
        }));
      });
  }, [selectedId]);

  const recentAlertIds = useMemo(
    () =>
      new Set(
        alerts
          .filter((alert) => alert.created_at >= now - 60 * 60_000)
          .map((alert) => alert.server_id),
      ),
    [alerts, now],
  );

  const filteredServers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return servers.filter((server) => {
      const matchesSearch =
        !query ||
        [server.display_name, server.hostname, server.server_id, server.region]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query);
      const matchesFilter =
        filter === "all" ||
        (filter === "online" && server.online) ||
        (filter === "offline" && !server.online) ||
        (filter === "alert" && recentAlertIds.has(server.server_id));
      return matchesSearch && matchesFilter;
    });
  }, [filter, recentAlertIds, search, servers]);

  const selected =
    servers.find((server) => server.server_id === selectedId) ?? servers[0];
  const online = servers.filter((server) => server.online);
  const totalRx = online.reduce(
    (sum, server) => sum + (server.status?.data.network.rx_bytes_sec ?? 0),
    0,
  );
  const totalTx = online.reduce(
    (sum, server) => sum + (server.status?.data.network.tx_bytes_sec ?? 0),
    0,
  );
  const selectedMetrics = selected?.status?.data;
  const recentAlertCount = alerts.filter(
    (alert) => alert.created_at >= now - 60 * 60_000,
  ).length;

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={21} />
          </div>
          <div>
            <strong>Probe Atlas</strong>
            <span>分布式节点监控</span>
          </div>
        </div>
        <div className="topbar-meta">
          <span className={`connection-chip state-${connection}`}>
            <Radio size={13} />
            {connection === "live"
              ? "实时链路已连接"
              : connection === "retrying"
                ? "正在重新连接"
                : "正在连接"}
          </span>
          <span className="utc-clock">
            UTC+8 ·{" "}
            {new Date().toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      </header>

      <section className="hero-row">
        <div>
          <p className="eyebrow">LIVE INFRASTRUCTURE</p>
          <h1>所有节点，一眼掌握</h1>
          <p>实时采集 CPU、内存、磁盘与网络状态，异常在失控之前被发现。</p>
        </div>
        <div className="traffic-total">
          <span>当前聚合流量</span>
          <div>
            <strong><ArrowDown size={16} /> {formatRate(totalRx)}</strong>
            <strong><ArrowUp size={16} /> {formatRate(totalTx)}</strong>
          </div>
        </div>
      </section>

      <section className="summary-grid" aria-label="节点汇总">
        <article className="summary-card accent-cyan">
          <div className="summary-icon"><Server size={18} /></div>
          <div><span>全部节点</span><strong>{servers.length}</strong></div>
          <small>已纳入监控</small>
        </article>
        <article className="summary-card accent-green">
          <div className="summary-icon"><Radio size={18} /></div>
          <div><span>在线</span><strong>{online.length}</strong></div>
          <small>{servers.length ? Math.round((online.length / servers.length) * 100) : 0}% 可用</small>
        </article>
        <article className="summary-card accent-muted">
          <div className="summary-icon"><WifiOff size={18} /></div>
          <div><span>离线</span><strong>{servers.length - online.length}</strong></div>
          <small>TTL 自动判定</small>
        </article>
        <article className="summary-card accent-amber">
          <div className="summary-icon"><AlertTriangle size={18} /></div>
          <div><span>近一小时告警</span><strong>{recentAlertCount}</strong></div>
          <small>连续阈值检测</small>
        </article>
      </section>

      <section className="workspace">
        <div className="node-column">
          <div className="toolbar">
            <div className="filter-tabs" role="group" aria-label="节点状态筛选">
              {([
                ["all", "全部"],
                ["online", "在线"],
                ["offline", "离线"],
                ["alert", "告警"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="search-box">
              <Search size={15} />
              <span className="sr-only">搜索节点</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索节点、区域…"
              />
            </label>
          </div>

          {loadError && (
            <div className="service-notice">
              <AlertTriangle size={18} />
              <div><strong>控制服务尚未连接</strong><span>{loadError}，面板会自动重试。</span></div>
            </div>
          )}

          <div className="server-grid">
            {filteredServers.map((server) => (
              <ServerCard
                key={server.server_id}
                server={server}
                selected={server.server_id === selected?.server_id}
                hasAlert={recentAlertIds.has(server.server_id)}
                onSelect={() => setSelectedId(server.server_id)}
              />
            ))}
          </div>
          {!loadError && filteredServers.length === 0 && (
            <div className="empty-state">当前筛选条件下没有节点</div>
          )}
        </div>

        <aside className="detail-panel">
          {selected ? (
            <>
              <div className="detail-head">
                <div>
                  <span className="panel-kicker">NODE DETAIL</span>
                  <h2>{selected.display_name}</h2>
                  <p>{selected.server_id} · {selected.provider}</p>
                </div>
                <span className={`detail-status ${selected.online ? "online" : "offline"}`}>
                  {selected.online ? "ONLINE" : "OFFLINE"}
                </span>
              </div>

              <div className="network-title">
                <div><Globe2 size={16} /><strong>网络吞吐</strong></div>
                <div className="chart-legend"><span className="rx">下载</span><span className="tx">上传</span></div>
              </div>
              <NetworkChart points={pointsByServer[selected.server_id] ?? []} />

              <div className="detail-stats">
                <div><Cpu size={15} /><span>负载 1m</span><strong>{selectedMetrics?.cpu.load_1.toFixed(2) ?? "—"}</strong></div>
                <div><MemoryStick size={15} /><span>内存</span><strong>{selectedMetrics ? formatSize(selectedMetrics.memory.used_mb) : "—"}</strong></div>
                <div><HardDrive size={15} /><span>磁盘写入</span><strong>{selectedMetrics ? formatRate(selectedMetrics.disk.write_bytes_sec) : "—"}</strong></div>
                <div><Database size={15} /><span>TCP 连接</span><strong>{selectedMetrics?.network.tcp_connections.established ?? "—"}</strong></div>
              </div>

              <div className="node-facts">
                <div><span>系统</span><strong>{selected.os}</strong></div>
                <div><span>架构</span><strong>{selected.arch}</strong></div>
                <div><span>处理器</span><strong>{selected.cpu_model}</strong></div>
                <div><span>最近上报</span><strong>{relativeTime(selected.last_seen_at)}</strong></div>
              </div>

              <div className="recent-alerts">
                <div className="section-heading">
                  <strong>最近事件</strong>
                  <span>{alerts.filter((alert) => alert.server_id === selected.server_id).length}</span>
                </div>
                {alerts
                  .filter((alert) => alert.server_id === selected.server_id)
                  .slice(0, 3)
                  .map((alert) => (
                    <div className="alert-row" key={alert.id}>
                      <AlertTriangle size={14} />
                      <div><strong>{alert.title}</strong><span>{relativeTime(alert.created_at)}</span></div>
                    </div>
                  ))}
                {!alerts.some((alert) => alert.server_id === selected.server_id) && (
                  <p className="no-events">暂无异常事件</p>
                )}
              </div>
            </>
          ) : (
            <div className="detail-empty">
              <Activity size={28} />
              <p>等待节点接入</p>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
