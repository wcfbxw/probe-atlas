#!/usr/bin/env bash
set -Eeuo pipefail

RAW_BASE_URL="https://raw.githubusercontent.com/wcfbxw/probe-atlas/main"
SERVER_URL=""
SERVER_ID=""
TOKEN=""
DISPLAY_NAME=""
REGION="未分组"
PROVIDER="自建"

usage() {
  cat <<'EOF'
Probe Atlas Agent 一键安装

用法：
  sudo bash install-agent.sh \
    --server-url wss://monitor.example.com/ws/agent \
    --server-id vps-hk-01 \
    --token YOUR_NODE_TOKEN \
    [--display-name 香港节点] [--region 亚洲] [--provider ExampleCloud]
EOF
}

die() {
  echo "错误：$*" >&2
  exit 1
}

need_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || die "$1 缺少参数"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url)
      need_value "$@"
      SERVER_URL="$2"
      shift 2
      ;;
    --server-id)
      need_value "$@"
      SERVER_ID="$2"
      shift 2
      ;;
    --token)
      need_value "$@"
      TOKEN="$2"
      shift 2
      ;;
    --display-name)
      need_value "$@"
      DISPLAY_NAME="$2"
      shift 2
      ;;
    --region)
      need_value "$@"
      REGION="$2"
      shift 2
      ;;
    --provider)
      need_value "$@"
      PROVIDER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "请使用 sudo 或 root 运行"
command -v systemctl >/dev/null 2>&1 || die "需要使用 systemd 的 Linux 服务器"
[[ "$SERVER_URL" =~ ^wss?:// ]] || die "server-url 必须以 ws:// 或 wss:// 开头"
[[ "$SERVER_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] ||
  die "server-id 格式无效"
[[ "$TOKEN" =~ ^[a-zA-Z0-9._~-]{16,256}$ ]] ||
  die "token 只能包含字母、数字及 . _ ~ -，长度 16–256 位"
DISPLAY_NAME="${DISPLAY_NAME:-$(hostname -s)}"

for value in "$SERVER_URL" "$SERVER_ID" "$TOKEN" "$DISPLAY_NAME" "$REGION" "$PROVIDER"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "参数中不能包含换行符"
done

install_prerequisites() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      python3 python3-venv python3-pip curl ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3 python3-pip curl ca-certificates
    # EL8 ships Python 3.6 as python3; the agent dependencies need 3.9+.
    if ! find_python >/dev/null; then
      dnf install -y python3.11 python3.11-pip ||
        dnf install -y python39 python39-pip ||
        true
    fi
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3 python3-pip curl ca-certificates
  else
    die "仅支持带 apt、dnf 或 yum 的 systemd Linux 发行版"
  fi
}

find_python() {
  local candidate
  for candidate in python3 python3.13 python3.12 python3.11 python3.10 python3.9; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
        >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

quote_systemd_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

install_prerequisites
PYTHON_BIN="$(find_python)" ||
  die "未找到 Python 3.9 或更高版本；CentOS 7 等旧系统请先自行安装 Python 3.9+ 后重试"

if ! id probe-agent >/dev/null 2>&1; then
  useradd --system --home-dir /opt/probe-agent --shell /usr/sbin/nologin probe-agent
fi

install -d -m 0755 /opt/probe-agent
install -d -m 0750 -o root -g probe-agent /etc/probe-agent

curl -fsSL "$RAW_BASE_URL/agent/agent.py" -o /opt/probe-agent/agent.py
curl -fsSL "$RAW_BASE_URL/agent/requirements.txt" -o /opt/probe-agent/requirements.txt
curl -fsSL "$RAW_BASE_URL/agent/probe-agent.service" \
  -o /etc/systemd/system/probe-agent.service

"$PYTHON_BIN" -m venv /opt/probe-agent/venv
/opt/probe-agent/venv/bin/pip install --disable-pip-version-check \
  -r /opt/probe-agent/requirements.txt

umask 077
{
  printf "PROBE_SERVER_URL=%s\n" "$(quote_systemd_value "$SERVER_URL")"
  printf "PROBE_SERVER_ID=%s\n" "$(quote_systemd_value "$SERVER_ID")"
  printf "PROBE_AGENT_TOKEN=%s\n" "$(quote_systemd_value "$TOKEN")"
  printf "PROBE_DISPLAY_NAME=%s\n" "$(quote_systemd_value "$DISPLAY_NAME")"
  printf "PROBE_REGION=%s\n" "$(quote_systemd_value "$REGION")"
  printf "PROBE_PROVIDER=%s\n" "$(quote_systemd_value "$PROVIDER")"
  printf 'PROBE_INTERVAL_SECONDS="2"\n'
} > /etc/probe-agent/agent.env
chown root:probe-agent /etc/probe-agent/agent.env
chmod 0640 /etc/probe-agent/agent.env

chown -R root:root /opt/probe-agent
chmod 0755 /opt/probe-agent/agent.py

systemctl daemon-reload
systemctl enable --now probe-agent

if ! systemctl is-active --quiet probe-agent; then
  systemctl status probe-agent --no-pager || true
  die "Agent 启动失败"
fi

echo
echo "Probe Agent 已安装并运行。"
echo "节点 ID：$SERVER_ID"
echo "连接地址：$SERVER_URL"
echo "查看日志：sudo journalctl -u probe-agent -f"
