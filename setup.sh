#!/usr/bin/env bash
# CKB Node Dashboard — interactive setup
# Generates config.json with your node's connection details.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       CKB Node Dashboard Setup       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── Node host ─────────────────────────────────────────────────────────────────
echo -e "${YELLOW}Where is your CKB node?${NC}"
echo "  • Same machine as this dashboard → enter: 127.0.0.1"
echo "  • Another machine on the network → enter its local IP (e.g. 192.168.1.50)"
echo ""
read -rp "CKB node IP address [127.0.0.1]: " NODE_HOST
NODE_HOST="${NODE_HOST:-127.0.0.1}"

# ── Node port ─────────────────────────────────────────────────────────────────
read -rp "CKB node RPC port [8114]: " NODE_PORT
NODE_PORT="${NODE_PORT:-8114}"

# ── Dashboard port ────────────────────────────────────────────────────────────
read -rp "Dashboard web port [8080]: " DASH_PORT
DASH_PORT="${DASH_PORT:-8080}"

# ── Verify node is reachable ──────────────────────────────────────────────────
echo ""
echo -n "Testing connection to $NODE_HOST:$NODE_PORT ... "
RESULT=$(curl -s --max-time 5 "http://$NODE_HOST:$NODE_PORT" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"get_blockchain_info","params":[],"id":1}' 2>/dev/null || echo "")

if echo "$RESULT" | grep -q '"result"'; then
  CHAIN=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['chain'])" 2>/dev/null || echo "ckb")
  echo -e "${GREEN}OK${NC} (chain: $CHAIN)"
else
  echo -e "${YELLOW}WARNING: Could not reach node at $NODE_HOST:$NODE_PORT${NC}"
  echo "Make sure your CKB node is running and the RPC port is accessible."
  read -rp "Continue anyway? [y/N]: " CONT
  [[ "$CONT" =~ ^[Yy]$ ]] || exit 1
fi

# ── Write config ──────────────────────────────────────────────────────────────
cat > "$CONFIG" <<EOF
{
  "node_host": "$NODE_HOST",
  "node_port": $NODE_PORT,
  "dashboard_port": $DASH_PORT
}
EOF

echo ""
echo -e "${GREEN}Config saved to config.json${NC}"
echo ""
echo -e "  Node:      ${CYAN}http://$NODE_HOST:$NODE_PORT${NC}"
echo -e "  Dashboard: ${CYAN}http://$(hostname -I | awk '{print $1}'):$DASH_PORT${NC}"
echo ""
echo "Start the dashboard:"
echo "  node src/server.js"
echo ""
echo "Or to run as a system service:"
echo "  sudo bash install.sh"
echo ""
