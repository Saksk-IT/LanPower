#!/bin/sh

BASE=/data/lanpower
PID=/tmp/lanpower-gateway-supervisor.pid
CHILD=/tmp/lanpower-gateway-child.pid
STARTING=/tmp/lanpower-gateway-starting

# Keep the router's already validated LAN-only SSH recovery behavior.
if [ ! -e /tmp/lanpower-ssh-ready ]; then
    nvram set ssh_en=1 2>/dev/null
    nvram commit 2>/dev/null
    sed -i 's/channel=.*/channel="debug"/g' /etc/init.d/dropbear 2>/dev/null
    /etc/init.d/dropbear start 2>/dev/null
    touch /tmp/lanpower-ssh-ready
fi

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    exit 0
fi
mkdir "$STARTING" 2>/dev/null || exit 0
trap 'rmdir "$STARTING" 2>/dev/null' EXIT
(
    sleep 10
    while :; do
        "$BASE/lanpower-gateway" -config "$BASE/gateway.json" &
        child=$!
        echo "$child" > "$CHILD"
        wait "$child"
        rm -f "$CHILD"
        sleep 5
    done
) </dev/null >/dev/null 2>&1 &
echo "$!" > "$PID"
