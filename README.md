# Probe Atlas

轻量级 Agent–Server 分布式服务器监控系统。一个面板可同时展示多台 Linux
服务器的 CPU、内存、磁盘、网络、连接数、在线状态和历史趋势。

## 生产环境一键安装

推荐使用一台有公网 IP 的 Linux 服务器作为控制端。支持带 systemd 的
Ubuntu、Debian、Rocky Linux、AlmaLinux 和 CentOS；需要 root 或 sudo 权限。

### 方式一：绑定域名（推荐）

先将域名的 `A`/`AAAA` 记录指向控制服务器，然后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/wcfbxw/probe-atlas/main/deploy/install-server.sh \
  | sudo bash -s -- --domain monitor.example.com
```

安装程序会自动完成以下工作：

- 安装 Docker 和 Docker Compose；
- 启动 Dashboard、控制服务、Redis 与 Caddy；
- 自动申请并续期 HTTPS 证书；
- 生成面板账号、随机密码和首个节点 Token；
- 仅对外开放 80/443，API、Redis 和内部服务不直接暴露。

完成后终端会显示面板地址、登录账号、密码，以及首台 Agent 的安装命令。
用浏览器访问 `https://monitor.example.com` 即可进入面板。

### 方式二：暂时没有域名

```bash
curl -fsSL https://raw.githubusercontent.com/wcfbxw/probe-atlas/main/deploy/install-server.sh \
  | sudo bash
```

安装后通过 `http://服务器公网IP` 访问。此方式没有 TLS，只适合首次测试；
正式使用请绑定域名并使用 HTTPS/WSS。

## 安装被监控节点

服务端安装完成时会输出一条专属于首个节点的命令。复制到被监控的 Linux
服务器执行即可，例如：

```bash
curl -fsSL https://raw.githubusercontent.com/wcfbxw/probe-atlas/main/deploy/install-agent.sh \
  | sudo bash -s -- \
    --server-url 'wss://monitor.example.com/ws/agent' \
    --server-id 'vps-us-01' \
    --token '服务端生成的独立Token' \
    --display-name '美国硅谷 01' \
    --region '北美' \
    --provider 'ExampleCloud'
```

Agent 需要 Python 3.9 或更高版本。Rocky Linux / AlmaLinux 8 自带的 Python 3.6
过旧，安装脚本会自动安装 `python3.11`；CentOS 7 等更旧的系统需先自行安装
Python 3.9+。

Agent 会作为 `probe-agent.service` 开机自启，每 2 秒上报一次。查看状态：

```bash
sudo systemctl status probe-agent
sudo journalctl -u probe-agent -f
```

## 把多台服务器放到同一个面板

在控制服务器上为每台新服务器生成独立身份：

```bash
sudo probe-add-agent vps-hk-01
sudo probe-add-agent vps-de-01
```

每次命令都会输出一条新的 Agent 安装命令。把它复制到对应服务器执行，
节点上线后会自动出现在同一个面板中。每台节点必须使用不同的 `server-id`
和独立 Token，不能共用凭据。

## 日常维护

```bash
# 查看所有容器
cd /opt/probe-atlas && sudo docker compose ps

# 查看日志
cd /opt/probe-atlas && sudo docker compose logs -f --tail=200

# 更新到最新版
cd /opt/probe-atlas
sudo git pull --ff-only
sudo docker compose up -d --build
```

部署配置保存在 `/opt/probe-atlas/.env`。该文件包含 Agent Token 和面板密码
哈希，权限应保持为仅 root 可读，也不要提交到 Git。

## 本地开发

需要 Node.js 22 或更高版本：

```bash
npm install
npm run dev:all
```

访问 `http://localhost:3000`。控制服务监听 `127.0.0.1:8080`，模拟器会接入
三台测试节点。也可以分别启动：

```bash
npm run dev
npm run dev:server
npm run dev:sim
```

## 核心组件

- Fastify + WebSocket 控制服务；
- Redis 实时状态与 TTL 离线判定；
- SQLite 分钟级聚合历史（附 TimescaleDB 表结构），默认保留 30 天、告警保留
  90 天（`METRICS_RETENTION_DAYS` / `ALERT_RETENTION_DAYS`）；
- 每个节点的本月流量与累计流量（只统计物理网卡，排除 lo、Docker、VPN 等虚拟
  网卡；按 `TRAFFIC_RESET_DAY` 每月重置，默认每月 1 日，时区由 `TZ` 决定）；
- CPU/内存连续三次超限告警与 10 分钟冷却；
- Python `psutil` Agent，systemd 沙箱化运行；
- React + ECharts 多节点实时 Dashboard；
- Caddy HTTPS、WSS 与面板 HTTP Basic 身份验证。

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

生产部署中 API 和 Dashboard WebSocket 由面板登录保护；Agent WebSocket
使用每节点独立 Token 认证。

## 测试

```bash
npm test
```

本地历史数据写入 `.data/probe.sqlite`。配置 `REDIS_URL` 后，实时状态使用
`server:status:{server_id}` 和 `server:online_set`。
