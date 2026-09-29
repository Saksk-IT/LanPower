#!/bin/sh

BASE=${LANPOWER_BASE:-/data/lanpower}
RUN_DIR=${LANPOWER_RUN_DIR:-/tmp}
PID="$RUN_DIR/lanpower-gateway-supervisor.pid"
CHILD="$RUN_DIR/lanpower-gateway-child.pid"
STARTING="$RUN_DIR/lanpower-gateway-starting"
BIN="$BASE/lanpower-gateway"
CONFIG="$BASE/gateway.json"
MAINTENANCE="$BASE/maintenance.conf"
START_DELAY=${LANPOWER_START_DELAY:-10}
RESTART_DELAY=${LANPOWER_RESTART_DELAY:-5}

if [ "${1:-}" = --supervise ]; then
    child=
    delay=
    cleanup() {
        trap - 0 TERM INT
        if [ -n "$delay" ]; then
            kill "$delay" 2>/dev/null || true
            wait "$delay" 2>/dev/null || true
        fi
        if [ -n "$child" ]; then
            kill "$child" 2>/dev/null || true
            wait "$child" 2>/dev/null || true
        fi
        if [ -f "$PID" ] && [ "$(cat "$PID")" = "$$" ]; then
            rm -f "$PID" "$CHILD"
        fi
    }
    trap 'exit 0' TERM INT
    trap cleanup 0
    sleep "$START_DELAY" &
    delay=$!
    wait "$delay" 2>/dev/null || true
    delay=
    while :; do
        "$BIN" -config "$CONFIG" &
        child=$!
        echo "$child" > "$CHILD"
        wait "$child" 2>/dev/null || true
        child=
        rm -f "$CHILD"
        sleep "$RESTART_DELAY" &
        delay=$!
        wait "$delay" 2>/dev/null || true
        delay=
    done
fi

# New installations leave SSH alone. Existing Gateway installations with the
# legacy SSH startup are migrated by install.sh to maintenance_ssh=true.
if [ -f "$MAINTENANCE" ] && grep -qx 'maintenance_ssh=true' "$MAINTENANCE"; then
    SSH_READY="$RUN_DIR/lanpower-ssh-ready"
    DROPBEAR_INIT=${LANPOWER_DROPBEAR_INIT:-/etc/init.d/dropbear}
    if [ ! -e "$SSH_READY" ]; then
        nvram set ssh_en=1 2>/dev/null || true
        nvram commit 2>/dev/null || true
        sed -i 's/channel=.*/channel="debug"/g' "$DROPBEAR_INIT" 2>/dev/null || true
        "$DROPBEAR_INIT" start 2>/dev/null || true
        touch "$SSH_READY"
    fi
fi

mkdir "$STARTING" 2>/dev/null || exit 0
trap 'rmdir "$STARTING" 2>/dev/null || true' 0
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    exit 0
fi
sh "$BASE/startup.sh" --supervise </dev/null >/dev/null 2>&1 &
echo "$!" > "$PID"
