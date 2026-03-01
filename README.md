# CKB Node Dashboard

A lightweight, real-time monitoring dashboard for [Nervos CKB](https://www.nervos.org/) nodes.

Built for **Ubuntu 22.04 arm64** — runs great on Orange Pi 3B, Orange Pi 5, Raspberry Pi, and similar SBCs. Also works on x86_64.

![CKB Node Dashboard](https://img.shields.io/badge/CKB-Mainnet-3bc67a?style=flat-square) ![Ubuntu 22.04](https://img.shields.io/badge/Ubuntu-22.04-E95420?style=flat-square&logo=ubuntu) ![arm64](https://img.shields.io/badge/arch-arm64-blue?style=flat-square)

---

## Features

- **Live block height** — polls every 5 seconds, flashes on new block
- **Epoch tracker** — epoch number, block index, animated progress bar
- **Peer list** — peer count with sync status per peer
- **TX pool** — pending, proposed, orphan counts + mempool size
- **Avg block time** — calculated from the last 10 blocks
- **Works on iOS Safari** — proxy architecture avoids cross-origin restrictions
- **Auto-reconnect** — handles node restarts gracefully
- **Zero dependencies** — pure Node.js stdlib, no npm install needed

---

## Requirements

- Ubuntu 22.04 (arm64 or x86_64)
- A running CKB node with RPC accessible (default port 8114)
- Node.js 18+ (installed automatically if missing)

---

## Quick Install

```bash
# Clone the repo
git clone https://github.com/toastmanAu/ckb-node-dashboard.git
cd ckb-node-dashboard

# Run setup (prompts for your node's IP address)
bash setup.sh

# Install as a system service (auto-starts on boot)
sudo bash install.sh
```

Then open **`http://<your-board-ip>:3000`** in any browser on your network.

---

## Setup

The setup script will ask you three questions:

| Question | Default | Notes |
|---|---|---|
| CKB node IP | `127.0.0.1` | Use `127.0.0.1` if node is on the same machine |
| CKB node RPC port | `8114` | Default CKB RPC port |
| Dashboard web port | `3000` | Port to access the dashboard on |

Your answers are saved to `config.json`.

### Node on a different machine?

If your CKB node runs on another machine (e.g. a dedicated node box at `192.168.1.50`), enter that IP when prompted. The dashboard server acts as a proxy so all browsers — including iOS Safari — can reach it without cross-origin issues.

---

## Manual run (no systemd)

```bash
bash setup.sh        # configure once
node src/server.js   # run the dashboard
```

---

## Changing your node IP later

Edit `config.json` (or `/opt/ckb-node-dashboard/config.json` if installed as a service):

```json
{
  "node_host": "192.168.1.50",
  "node_port": 8114,
  "dashboard_port": 3000
}
```

Then restart:
```bash
sudo systemctl restart ckb-dashboard
```

---

## Service management

```bash
sudo systemctl status ckb-dashboard
sudo systemctl restart ckb-dashboard
sudo journalctl -u ckb-dashboard -f
```

---

## CKB Node setup tips

Make sure your CKB node's `ckb.toml` has the RPC listening on the right interface:

```toml
[rpc]
listen_address = "0.0.0.0:8114"
```

If the dashboard is on the same machine as the node, `127.0.0.1:8114` is fine.

---

## Architecture

```
Browser (any device on your network)
    │  HTTP
    ▼
Dashboard server (this machine, port 3000)
    │  HTTP proxy → /rpc
    ▼
CKB node RPC (port 8114)
```

The proxy layer means the browser only ever talks to one IP — solving iOS Safari's local network cross-origin restrictions.

---

## Contributing

PRs welcome. Tested on:
- Orange Pi 3B (RK3566, Ubuntu 22.04 arm64)
- Orange Pi 5 (RK3588S, Ubuntu 22.04 arm64)

---

## License

MIT
