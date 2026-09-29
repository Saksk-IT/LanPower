#!/bin/sh
set -eu

BASE=${LANPOWER_BASE:-/data/lanpower}
RUN_DIR=${LANPOWER_RUN_DIR:-/tmp}
SOURCE_BINARY=${1:-/tmp/lanpower-gateway}
SOURCE_CONFIG=${2:-/tmp/gateway.json}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ACTIVE="$BASE/lanpower-gateway"
PREVIOUS="$BASE/lanpower-gateway.previous"
CANDIDATE="$BASE/lanpower-gateway.candidate"
STARTUP="$BASE/startup.sh"
STARTUP_BACKUP="$BASE/startup.sh.transaction"
MAINTENANCE="$BASE/maintenance.conf"
SUPERVISOR_PID="$RUN_DIR/lanpower-gateway-supervisor.pid"
CHILD_PID="$RUN_DIR/lanpower-gateway-child.pid"
HEALTH_WAIT=${LANPOWER_HEALTH_WAIT:-20}
HEALTH_STABLE=${LANPOWER_HEALTH_STABLE:-3}
STOP_WAIT=${LANPOWER_STOP_WAIT:-5}
transaction_started=0
had_binary=0
had_startup=0
created_maintenance=0
old_staged=0
new_activated=0

process_alive() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$1" 2>/dev/null || return 1
    if [ -r "/proc/$1/stat" ]; then
        state=$(awk '{print $3}' "/proc/$1/stat")
        [ "$state" != Z ] || return 1
    fi
    return 0
}

stop_gateway() {
    supervisor=
    child=
    [ ! -f "$SUPERVISOR_PID" ] || supervisor=$(cat "$SUPERVISOR_PID")
    [ ! -f "$CHILD_PID" ] || child=$(cat "$CHILD_PID")
    if process_alive "$supervisor"; then kill "$supervisor" 2>/dev/null || true; fi
    if process_alive "$child"; then kill "$child" 2>/dev/null || true; fi
    remaining=$STOP_WAIT
    while [ "$remaining" -gt 0 ]; do
        if ! process_alive "$supervisor" && ! process_alive "$child"; then break; fi
        sleep 1
        remaining=$((remaining - 1))
    done
    if process_alive "$supervisor"; then kill -9 "$supervisor" 2>/dev/null || true; fi
    if process_alive "$child"; then kill -9 "$child" 2>/dev/null || true; fi
    rm -f "$SUPERVISOR_PID" "$CHILD_PID"
    rmdir "$RUN_DIR/lanpower-gateway-starting" 2>/dev/null || true
}

health_check() {
    remaining=$HEALTH_WAIT
    while [ "$remaining" -gt 0 ]; do
        if [ -f "$SUPERVISOR_PID" ] && [ -f "$CHILD_PID" ]; then
            supervisor=$(cat "$SUPERVISOR_PID")
            child=$(cat "$CHILD_PID")
            if process_alive "$supervisor" && process_alive "$child"; then
                sleep "$HEALTH_STABLE"
                if [ -f "$SUPERVISOR_PID" ] && [ -f "$CHILD_PID" ] &&
                    [ "$(cat "$SUPERVISOR_PID")" = "$supervisor" ] &&
                    [ "$(cat "$CHILD_PID")" = "$child" ] &&
                    process_alive "$supervisor" && process_alive "$child"; then
                    return 0
                fi
            fi
        fi
        sleep 1
        remaining=$((remaining - 1))
    done
    return 1
}

restore_option() {
    key=$1
    value=$2
    if [ -n "$value" ]; then
        uci set "firewall.lanpower_startup.$key=$value"
    else
        uci -q delete "firewall.lanpower_startup.$key" || true
    fi
}

restore_startup() {
    if [ "$had_startup" -eq 1 ]; then
        cp -p "$STARTUP_BACKUP" "$STARTUP" || return 1
    else
        rm -f "$STARTUP"
    fi
    if [ -z "$old_section" ]; then
        uci -q delete firewall.lanpower_startup || true
    else
        uci set "firewall.lanpower_startup=$old_section" || return 1
        restore_option type "$old_type" || return 1
        restore_option path "$old_path" || return 1
        restore_option enabled "$old_enabled" || return 1
        restore_option reload "$old_reload" || return 1
    fi
    uci commit firewall
}

rollback() {
    stop_gateway
    if [ "$had_binary" -eq 1 ]; then
        if [ "$old_staged" -eq 1 ]; then
            [ -f "$PREVIOUS" ] || return 1
            mv "$PREVIOUS" "$ACTIVE" || return 1
        fi
    elif [ "$new_activated" -eq 1 ]; then
        rm -f "$ACTIVE"
    fi
    restore_startup || return 1
    if [ "$created_maintenance" -eq 1 ]; then rm -f "$MAINTENANCE"; fi
    if [ "$had_binary" -eq 1 ]; then
        [ "$had_startup" -eq 1 ] || return 1
        "$STARTUP" || return 1
        health_check || return 1
    fi
    return 0
}

on_exit() {
    status=$1
    trap - 0
    set +e
    if [ "$status" -ne 0 ] && [ "$transaction_started" -eq 1 ]; then
        if rollback; then
            if [ "$had_binary" -eq 1 ]; then
                echo 'upgrade failed and rolled back' >&2
            else
                echo 'installation failed; no previous Gateway to restore' >&2
            fi
        else
            echo 'upgrade failed; automatic rollback incomplete, inspect Gateway startup' >&2
        fi
    fi
    rm -f "$CANDIDATE" "$STARTUP_BACKUP"
    exit "$status"
}
trap 'on_exit $?' 0

if [ "$(uname -m)" != aarch64 ]; then
    echo 'Only AX3000T aarch64 is supported' >&2
    exit 1
fi
if [ ! -f "$SOURCE_BINARY" ] || [ ! -f "$SOURCE_CONFIG" ]; then
    echo 'Usage: install.sh /tmp/lanpower-gateway /tmp/gateway.json' >&2
    exit 1
fi
mkdir -p "$BASE" "$RUN_DIR"
chmod 700 "$BASE"
if [ ! -f "$BASE/gateway.json" ]; then
    cp "$SOURCE_CONFIG" "$BASE/gateway.json"
fi
chmod 600 "$BASE/gateway.json"
cp "$SOURCE_BINARY" "$CANDIDATE"
chmod 700 "$CANDIDATE"
"$CANDIDATE" -config "$BASE/gateway.json" -check-config

if [ -f "$ACTIVE" ]; then had_binary=1; fi
if [ -f "$STARTUP" ]; then
    had_startup=1
    cp -p "$STARTUP" "$STARTUP_BACKUP"
fi
old_section=$(uci -q get firewall.lanpower_startup 2>/dev/null || true)
old_type=$(uci -q get firewall.lanpower_startup.type 2>/dev/null || true)
old_path=$(uci -q get firewall.lanpower_startup.path 2>/dev/null || true)
old_enabled=$(uci -q get firewall.lanpower_startup.enabled 2>/dev/null || true)
old_reload=$(uci -q get firewall.lanpower_startup.reload 2>/dev/null || true)

if [ ! -f "$MAINTENANCE" ]; then
    if [ "$had_binary" -eq 1 ] && [ "$had_startup" -eq 1 ] &&
        grep -q '^[[:space:]]*nvram set ssh_en=1' "$STARTUP_BACKUP"; then
        echo maintenance_ssh=true > "$MAINTENANCE"
        echo 'Migrated existing SSH recovery to maintenance_ssh=true; review before reboot'
    else
        echo maintenance_ssh=false > "$MAINTENANCE"
        if [ "$had_startup" -eq 1 ] && grep -q '^[[:space:]]*nvram set ssh_en=1' "$STARTUP_BACKUP"; then
            echo 'First install defaults to maintenance_ssh=false; opt in before reboot if LAN SSH recovery is needed'
        fi
    fi
    chmod 600 "$MAINTENANCE"
    created_maintenance=1
fi

transaction_started=1
stop_gateway
if [ "$had_binary" -eq 1 ]; then
    rm -f "$PREVIOUS"
    mv "$ACTIVE" "$PREVIOUS"
    old_staged=1
fi
mv "$CANDIDATE" "$ACTIVE"
new_activated=1
cp "$SCRIPT_DIR/startup.sh" "$STARTUP"
chmod 700 "$STARTUP"
uci set firewall.lanpower_startup=include
uci set firewall.lanpower_startup.type=script
uci set "firewall.lanpower_startup.path=$STARTUP"
uci set firewall.lanpower_startup.enabled=1
uci set firewall.lanpower_startup.reload=1
uci commit firewall
"$STARTUP"
if ! health_check; then
    echo 'New Gateway failed process health check' >&2
    exit 1
fi

if [ ! -f "$BASE/.gateway-installed" ]; then
    if [ "$had_binary" -eq 0 ] && [ "$had_startup" -eq 1 ]; then
        cp -p "$STARTUP_BACKUP" "$BASE/startup.sh.pre-gateway"
        echo existing > "$BASE/.gateway-installed"
    else
        echo new > "$BASE/.gateway-installed"
    fi
fi
transaction_started=0
echo 'Gateway installed and running'
