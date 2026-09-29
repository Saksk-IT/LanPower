#!/bin/sh
set -eu

BASE=/data/lanpower
for pid_file in /tmp/lanpower-gateway-child.pid /tmp/lanpower-gateway-supervisor.pid; do
    if [ -f "$pid_file" ]; then
        kill "$(cat "$pid_file")" 2>/dev/null || true
        rm -f "$pid_file"
    fi
done
if [ -f "$BASE/.gateway-installed" ] && [ "$(cat "$BASE/.gateway-installed")" = existing ] && [ -f "$BASE/startup.sh.pre-gateway" ]; then
    mv "$BASE/startup.sh.pre-gateway" "$BASE/startup.sh"
    uci set firewall.lanpower_startup=include
    uci set firewall.lanpower_startup.type=script
    uci set firewall.lanpower_startup.path="$BASE/startup.sh"
    uci set firewall.lanpower_startup.enabled=1
    uci set firewall.lanpower_startup.reload=1
else
    uci -q delete firewall.lanpower_startup || true
    rm -f "$BASE/startup.sh"
fi
uci commit firewall
rm -f "$BASE/lanpower-gateway" "$BASE/lanpower-gateway.previous" "$BASE/.gateway-installed"
echo 'Gateway removed; credentials and logs were retained in /data/lanpower'
