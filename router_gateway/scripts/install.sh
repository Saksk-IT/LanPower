#!/bin/sh
set -eu

BASE=/data/lanpower
SOURCE_BINARY=${1:-/tmp/lanpower-gateway}
SOURCE_CONFIG=${2:-/tmp/gateway.json}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$(uname -m)" != aarch64 ]; then
    echo 'Only AX3000T aarch64 is supported' >&2
    exit 1
fi
if [ ! -f "$SOURCE_BINARY" ] || [ ! -f "$SOURCE_CONFIG" ]; then
    echo 'Usage: install.sh /tmp/lanpower-gateway /tmp/gateway.json' >&2
    exit 1
fi
mkdir -p "$BASE"
chmod 700 "$BASE"

if [ -e "$BASE/gateway.json" ]; then
    echo 'Keeping existing gateway.json; edit it explicitly to rotate credentials'
else
    cp "$SOURCE_CONFIG" "$BASE/gateway.json"
fi
chmod 600 "$BASE/gateway.json"
cp "$SOURCE_BINARY" "$BASE/lanpower-gateway.new"
chmod 700 "$BASE/lanpower-gateway.new"
"$BASE/lanpower-gateway.new" -config "$BASE/gateway.json" -check-config

if [ ! -e "$BASE/.gateway-installed" ]; then
    if [ -e "$BASE/startup.sh" ]; then
        cp "$BASE/startup.sh" "$BASE/startup.sh.pre-gateway"
        echo existing > "$BASE/.gateway-installed"
    else
        echo new > "$BASE/.gateway-installed"
    fi
fi

if [ -f /tmp/lanpower-gateway-child.pid ]; then
    kill "$(cat /tmp/lanpower-gateway-child.pid)" 2>/dev/null || true
fi
if [ -f /tmp/lanpower-gateway-supervisor.pid ]; then
    kill "$(cat /tmp/lanpower-gateway-supervisor.pid)" 2>/dev/null || true
fi
rm -f /tmp/lanpower-gateway-child.pid /tmp/lanpower-gateway-supervisor.pid

if [ -f "$BASE/lanpower-gateway" ]; then
    mv "$BASE/lanpower-gateway" "$BASE/lanpower-gateway.previous"
fi
mv "$BASE/lanpower-gateway.new" "$BASE/lanpower-gateway"
cp "$SCRIPT_DIR/startup.sh" "$BASE/startup.sh"
chmod 700 "$BASE/startup.sh"

uci set firewall.lanpower_startup=include
uci set firewall.lanpower_startup.type=script
uci set firewall.lanpower_startup.path="$BASE/startup.sh"
uci set firewall.lanpower_startup.enabled=1
uci set firewall.lanpower_startup.reload=1
uci commit firewall
"$BASE/startup.sh"
sleep 12
if [ ! -f /tmp/lanpower-gateway-child.pid ] || ! kill -0 "$(cat /tmp/lanpower-gateway-child.pid)" 2>/dev/null; then
    echo 'Gateway failed to start; see /data/lanpower/gateway.log' >&2
    exit 1
fi
echo 'Gateway installed and running'
