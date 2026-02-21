#!/usr/bin/env bash
# CKB Node Dashboard — install as a systemd service
# Tested on Ubuntu 22.04 arm64 (Orange Pi 3B, Orange Pi 5, etc.)
# Run as root: sudo bash install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="ckb-dashboard"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
INSTALL_DIR="/opt/ckb-node-dashboard"
NODE_USER="${SUDO_USER:-$(logname 2>/dev/null || echo ubuntu)}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [[ "$EUID" -ne 0 ]]; then
  echo -e "${RED}Please run as root: sudo bash install.sh${NC}"
  exit 1
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║    CKB Node Dashboard — Install      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── Check config exists ───────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/config.json" ]]; then
  echo -e "${YELLOW}No config.json found. Running setup first...${NC}"
  sudo -u "$NODE_USER" bash "$SCRIPT_DIR/setup.sh"
fi

# ── Install Node.js if missing ────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[1/4] Installing Node.js..."
  apt-get update -qq
  apt-get install -y -qq curl
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
  apt-get install -y -qq nodejs
  echo -e "      ${GREEN}Node.js $(node --version) installed${NC}"
else
  echo -e "[1/4] Node.js $(node --version) already installed ${GREEN}✓${NC}"
fi

# ── Copy files ────────────────────────────────────────────────────────────────
echo "[2/4] Installing dashboard to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/src/public"
cp -r "$SCRIPT_DIR/src/"   "$INSTALL_DIR/"
cp    "$SCRIPT_DIR/config.json" "$INSTALL_DIR/"
chown -R "$NODE_USER:$NODE_USER" "$INSTALL_DIR"
echo -e "      ${GREEN}Files installed${NC}"

# ── Read dashboard port from config ──────────────────────────────────────────
DASH_PORT=$(python3 -c "import json; print(json.load(open('$INSTALL_DIR/config.json')).get('dashboard_port', 3000))" 2>/dev/null || echo 3000)
NODE_IP=$(python3 -c "import json; print(json.load(open('$INSTALL_DIR/config.json')).get('node_host', '127.0.0.1'))" 2>/dev/null || echo "127.0.0.1")

# ── Create systemd service ────────────────────────────────────────────────────
echo "[3/4] Creating systemd service..."
NODE_BIN=$(command -v node)

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CKB Node Dashboard
After=network.target

[Service]
Type=simple
User=$NODE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
echo -e "      ${GREEN}Service enabled and started${NC}"

# ── Done ──────────────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Installation complete!             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Dashboard: ${CYAN}http://$LOCAL_IP:$DASH_PORT${NC}"
echo -e "  Node RPC:  ${CYAN}http://$NODE_IP:8114${NC}"
echo ""
echo "  Manage:"
echo "    sudo systemctl status $SERVICE_NAME"
echo "    sudo journalctl -u $SERVICE_NAME -f"
echo "    sudo systemctl restart $SERVICE_NAME"
echo ""
echo "  To change node IP later, edit $INSTALL_DIR/config.json"
echo "  then: sudo systemctl restart $SERVICE_NAME"
echo ""
