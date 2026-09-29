from __future__ import annotations


def select_route(action: str, *, windows_online: bool, gateway_online: bool,
                 linked_gateway: bool = False, windows_lan_online: bool = False,
                 backup_relay_enabled: bool = False, legacy: bool = False) -> str:
    """Choose a route for an explicit action; never wake a PC as a side effect."""
    if action not in {"wake", "status", "sleep", "hibernate", "restart", "shutdown"}:
        raise ValueError("unknown action")
    if action == "wake":
        return "wake_gateway" if gateway_online and linked_gateway else "unavailable"
    if windows_online:
        return "windows_direct"
    if gateway_online and linked_gateway:
        if action == "status" and (legacy or backup_relay_enabled):
            return "gateway_relay"
        if windows_lan_online and (legacy or backup_relay_enabled):
            return "gateway_relay"
    return "unavailable"
