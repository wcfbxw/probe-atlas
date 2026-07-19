#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="https://github.com/wcfbxw/probe-atlas.git"
RAW_BASE_URL="https://raw.githubusercontent.com/wcfbxw/probe-atlas/main"
INSTALL_DIR="/opt/probe-atlas"
DOMAIN=""
SERVER_ID=""
PANEL_USERNAME="admin"
PANEL_PASSWORD=""
AGENT_TOKEN=""

usage() {
  cat <<'EOF'
Probe Atlas 服务端一键安装

用法：
  sudo bash install-server.sh [选项]

选项：
  --domain DOMAIN          面板域名，例如 monitor.example.com
  --server-id ID           首台探针 ID，默认使用当前主机名
  --panel-user USER        面板用户名，默认 admin
  --panel-password PASS    面板密码，默认自动生成
  --agent-token TOKEN      首台探针 Token，默认自动生成
  --install-dir DIR        安装目录，默认 /opt/probe-atlas
  -h, --help               显示帮助

不提供域名时，将通过服务器公网 IP 使用 HTTP。正式环境强烈建议绑定域名，
Caddy 会自动申请并续期 HTTPS 证书。
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
    --domain)
      need_value "$@"
      DOMAIN="$2"
      shift 2
      ;;
    --server-id)
      need_value "$@"
      SERVER_ID="$2"
      shift 2
      ;;
    --panel-user)
      need_value "$@"
      PANEL_USERNAME="$2"
      shift 2
      ;;
    --panel-password)
      need_value "$@"
      PANEL_PASSWORD="$2"
      shift 2
      ;;
    --agent-token)
      need_value "$@"
      AGENT_TOKEN="$2"
      shift 2
      ;;
    --install-dir)
      need_value "$@"
      INSTALL_DIR="$2"
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

if [[ -n "$DOMAIN" ]]; then
  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%/}"
  [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$ &&
    "$DOMAIN" == *"."* ]] ||
    die "域名格式无效，请使用 monitor.example.com 这类格式"
fi

if [[ -z "$SERVER_ID" ]]; then
  SERVER_ID="$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-')"
fi
[[ "$SERVER_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] ||
  die "server-id 只能包含字母、数字、点、下划线和连字符，最长 64 位"
[[ "$PANEL_USERNAME" =~ ^[a-zA-Z0-9._-]{1,32}$ ]] ||
  die "panel-user 格式无效"

install_prerequisites() {
  if command -v curl >/dev/null 2>&1 &&
    command -v git >/dev/null 2>&1 &&
    command -v openssl >/dev/null 2>&1; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl git ca-certificates openssl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl git ca-certificates openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl git ca-certificates openssl
  else
    die "无法自动安装 curl/git；请先手动安装后重试"
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  echo "正在安装 Docker..."
  local installer
  installer="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
  rm -f "$installer"
}

install_prerequisites
install_docker
systemctl enable --now docker
docker compose version >/dev/null 2>&1 ||
  die "Docker Compose 插件不可用，请安装 docker-compose-plugin 后重试"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "正在更新 Probe Atlas..."
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  die "$INSTALL_DIR 已存在且不是 Probe Atlas Git 仓库"
else
  echo "正在下载 Probe Atlas..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPOSITORY_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

NEW_INSTALL=0
if [[ ! -f .env ]]; then
  NEW_INSTALL=1
  PANEL_PASSWORD="${PANEL_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=')}"
  AGENT_TOKEN="${AGENT_TOKEN:-$(openssl rand -hex 32)}"
  [[ "$AGENT_TOKEN" =~ ^[a-zA-Z0-9._~-]{16,256}$ ]] ||
    die "agent-token 只能包含字母、数字及 . _ ~ -，长度 16–256 位"

  if [[ -n "$DOMAIN" ]]; then
    SITE_ADDRESS="$DOMAIN"
    PUBLIC_URL="https://$DOMAIN"
  else
    PUBLIC_IP="$(curl -4fsS --max-time 8 https://api.ipify.org || true)"
    if [[ -z "$PUBLIC_IP" ]]; then
      PUBLIC_IP="$(hostname -I | awk '{print $1}')"
    fi
    [[ -n "$PUBLIC_IP" ]] || die "无法确定服务器 IP，请通过 --domain 指定域名"
    SITE_ADDRESS="http://$PUBLIC_IP"
    PUBLIC_URL="$SITE_ADDRESS"
  fi

  echo "正在生成面板登录凭据..."
  PANEL_PASSWORD_HASH="$(
    docker run --rm caddy:2-alpine \
      caddy hash-password --plaintext "$PANEL_PASSWORD"
  )"
  TOKENS_JSON="{\"$SERVER_ID\":\"$AGENT_TOKEN\"}"

  umask 077
  {
    printf "SITE_ADDRESS='%s'\n" "$SITE_ADDRESS"
    printf "PUBLIC_URL='%s'\n" "$PUBLIC_URL"
    printf "PANEL_USERNAME='%s'\n" "$PANEL_USERNAME"
    printf "PANEL_PASSWORD_HASH='%s'\n" "$PANEL_PASSWORD_HASH"
    printf "AGENT_TOKENS_JSON='%s'\n" "$TOKENS_JSON"
    printf "WEBHOOK_URL=''\n"
    printf "WEBHOOK_SECRET=''\n"
  } > .env
fi

echo "正在构建并启动服务..."
docker compose up -d --build

chmod 700 deploy/add-agent.sh deploy/install-agent.sh
ln -sf "$INSTALL_DIR/deploy/add-agent.sh" /usr/local/bin/probe-add-agent

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "^Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi

PUBLIC_URL="$(
  sed -n "s/^PUBLIC_URL=['\"]\\(.*\\)['\"]$/\\1/p" .env | head -n 1
)"
AGENT_WS_URL="${PUBLIC_URL/http:/ws:}"
AGENT_WS_URL="${AGENT_WS_URL/https:/wss:}/ws/agent"

echo
echo "Probe Atlas 已启动。"
echo "面板地址：$PUBLIC_URL"
if [[ "$NEW_INSTALL" -eq 1 ]]; then
  echo "面板账号：$PANEL_USERNAME"
  echo "面板密码：$PANEL_PASSWORD"
  echo
  echo "在第一台被监控服务器上执行："
  echo "curl -fsSL $RAW_BASE_URL/deploy/install-agent.sh | sudo bash -s -- --server-url '$AGENT_WS_URL' --server-id '$SERVER_ID' --token '$AGENT_TOKEN'"
else
  echo "检测到已有配置，原有账号和 Agent Token 均已保留。"
fi
echo
echo "以后新增服务器：sudo probe-add-agent <新的-server-id>"
echo "查看运行状态：cd $INSTALL_DIR && docker compose ps"
