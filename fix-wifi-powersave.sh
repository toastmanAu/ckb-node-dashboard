#!/usr/bin/env bash
# fix-wifi-powersave.sh — Disable WiFi power management on Orange Pi 3B (Armbian/Ubuntu)
# Prevents random WiFi disconnects caused by the driver sleeping the interface.
# Safe to run multiple times (idempotent).
#
# Usage:
#   sudo bash fix-wifi-powersave.sh
#
# Tested on: Orange Pi 3B, RK3566, BSP 5.10.x kernel, Armbian / Ubuntu
# Also works on: Orange Pi 5, Raspberry Pi (any model with WiFi)

set -e

# ── Detect WiFi interface ────────────────────────────────────────────────────
IFACE=$(iw dev 2>/dev/null | awk '/Interface/{print $2}' | head -1)
if [ -z "$IFACE" ]; then
    echo "❌ No WiFi interface found. Is WiFi hardware present?"
    exit 1
fi
echo "📡 WiFi interface: $IFACE"

# ── 1. Disable power save immediately (takes effect now, no reboot needed) ──
echo "⚡ Disabling power save on $IFACE..."
iw dev "$IFACE" set power_save off
iw dev "$IFACE" get power_save

# ── 2. modprobe.d — persist across reboots (driver param) ───────────────────
MODPROBE_CONF="/etc/modprobe.d/wifi-no-powersave.conf"
echo "📝 Writing $MODPROBE_CONF..."
cat > "$MODPROBE_CONF" << 'EOF'
# Disable WiFi power saving — prevents random disconnects
options 8821cs rtw_power_mgnt=0 rtw_enusbss=0
options 8852bs rtw_power_mgnt=0
options cfg80211 ieee80211_regdom=AU
EOF
echo "   Done."

# ── 3. udev rule — re-apply on every interface up event ─────────────────────
UDEV_RULE="/etc/udev/rules.d/70-wifi-no-powersave.rules"
echo "📝 Writing $UDEV_RULE..."
cat > "$UDEV_RULE" << EOF
# Disable WiFi power save whenever the interface comes up
ACTION=="add", SUBSYSTEM=="net", KERNEL=="$IFACE", RUN+="/usr/sbin/iw dev $IFACE set power_save off"
EOF
echo "   Done."

# ── 4. NetworkManager override (if NM is running) ───────────────────────────
if systemctl is-active --quiet NetworkManager 2>/dev/null; then
    NM_CONF="/etc/NetworkManager/conf.d/wifi-no-powersave.conf"
    echo "📝 Writing $NM_CONF (NetworkManager override)..."
    cat > "$NM_CONF" << 'EOF'
[connection]
wifi.powersave = 2
EOF
    echo "   Done. Reloading NetworkManager..."
    nmcli general reload || true
fi

# ── 5. Reload udev rules ────────────────────────────────────────────────────
echo "🔄 Reloading udev rules..."
udevadm control --reload-rules
udevadm trigger

# ── 6. Verify current state ─────────────────────────────────────────────────
echo ""
echo "✅ WiFi power save fix applied."
echo "   Current power_save state:"
iw dev "$IFACE" get power_save

echo ""
echo "📋 Summary of changes:"
echo "   • Power save disabled immediately on $IFACE"
echo "   • $MODPROBE_CONF — driver-level param (survives reboot)"
echo "   • $UDEV_RULE — re-applies on interface up"
if systemctl is-active --quiet NetworkManager 2>/dev/null; then
    echo "   • $NM_CONF — NetworkManager override"
fi
echo ""
echo "No reboot required. Changes are permanent."
