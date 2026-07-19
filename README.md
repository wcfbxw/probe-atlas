# Probe Atlas

轻量级 Agent–Server 分布式服务器监控系统。当前版本包含：

- Fastify WebSocket 控制服务
- 每节点独立 Token 认证与会话绑定
- Redis 实时状态适配器，未配置 Redis 时使用本地内存模式
- SQLite 本地分钟聚合历史，附 TimescaleDB 生产表结构
- CPU/内存连续三次超限告警和 10 分钟冷却
- Python `psutil` Agent
- 三节点本地模拟器
- React + ECharts 多节点实时 Dashboard

## 本地快速启动

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev:all
```

然后访问：

```text
http://localhost:3000
```

控制服务监听 `http://127.0.0.1:8080`，模拟器自动接入三台节点。

也可以分别启动：

```bash
npm run dev
npm run dev:server
npm run dev:sim
```

## 运行真实 Agent

Linux 服务器上：

```bash
python3 -m venv /opt/probe-agent/venv
/opt/probe-agent/venv/bin/pip install -r agent/requirements.txt
```

创建 `/etc/probe-agent/agent.env`：

```bash
PROBE_SERVER_URL=wss://monitor.example.com/ws/agent
PROBE_SERVER_ID=vps-us-01
PROBE_AGENT_TOKEN=节点独立随机Token
PROBE_DISPLAY_NAME=美国硅谷01
PROBE_REGION=北美
PROBE_PROVIDER=ExampleCloud
```

将 `agent/probe-agent.service` 安装到 systemd 后启动。生产环境必须使用
WSS、独立随机 Token、私网 Redis/TimescaleDB，并在控制服务前配置
Dashboard 身份认证。

## API

```text
GET /healthz
GET /api/v1/servers
GET /api/v1/summary
GET /api/v1/servers/{server_id}/history?minutes=60
GET /api/v1/alerts
WS  /ws/agent
WS  /ws/dashboard
```

## 测试

```bash
npm test
```

本地数据写入 `.data/probe.sqlite`。配置 `REDIS_URL` 后，实时状态切换到
Redis，使用规范中的 `server:status:{server_id}` 和
`server:online_set` Key。
