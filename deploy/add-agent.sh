#!/usr/bin/env bash
set -Eeuo pipefail

RAW_BASE_URL="https://raw.githubusercontent.com/wcfbxw/probe-atlas/main"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$INSTALL_DIR/.env"
SERVER_ID="${1:-}"
TOKEN="${2:-}"

die() {
  echo "错误：$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "请使用 sudo 或 root 运行"
[[ -n "$SERVER_ID" ]] ||
  die "用法：sudo probe-add-agent <server-id> [自定义-token]"
[[ "$SERVER_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] ||
  die "server-id 格式无效"
[[ -f "$ENV_FILE" ]] || die "找不到 $ENV_FILE，请先安装服务端"
command -v python3 >/dev/null 2>&1 || die "需要 python3"

if [[ -z "$TOKEN" ]]; then
  TOKEN="$(openssl rand -hex 32)"
fi
[[ "$TOKEN" =~ ^[a-zA-Z0-9._~-]{16,256}$ ]] ||
  die "token 只能包含字母、数字及 . _ ~ -，长度 16–256 位"

python3 - "$ENV_FILE" "$SERVER_ID" "$TOKEN" <<'PY'
import json
import pathlib
import sys

env_path = pathlib.Path(sys.argv[1])
server_id = sys.argv[2]
token = sys.argv[3]
lines = env_path.read_text(encoding="utf-8").splitlines()
updated = False

for index, line in enumerate(lines):
    if not line.startswith("AGENT_TOKENS_JSON="):
        continue
    raw = line.split("=", 1)[1].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        raw = raw[1:-1]
    tokens = json.loads(raw)
    if server_id in tokens:
        raise SystemExit(f"节点 {server_id} 已存在，请更换 server-id")
    tokens[server_id] = token
    value = json.dumps(tokens, ensure_ascii=False, separators=(",", ":"))
    lines[index] = f"AGENT_TOKENS_JSON='{value}'"
    updated = True
    break

if not updated:
    raise SystemExit("AGENT_TOKENS_JSON 不存在")

env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

cd "$INSTALL_DIR"
docker compose up -d --no-deps --force-recreate control

PUBLIC_URL="$(
  sed -n "s/^PUBLIC_URL=['\"]\\(.*\\)['\"]$/\\1/p" "$ENV_FILE" | head -n 1
)"
[[ -n "$PUBLIC_URL" ]] || die "PUBLIC_URL 配置缺失"
AGENT_WS_URL="${PUBLIC_URL/http:/ws:}"
AGENT_WS_URL="${AGENT_WS_URL/https:/wss:}/ws/agent"

echo
echo "节点 $SERVER_ID 已加入服务端。"
echo "请在该节点上执行："
echo "curl -fsSL $RAW_BASE_URL/deploy/install-agent.sh | sudo bash -s -- --server-url '$AGENT_WS_URL' --server-id '$SERVER_ID' --token '$TOKEN'"
