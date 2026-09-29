import pytest

from cloud_app.app.routing import select_route


@pytest.mark.parametrize("action,windows,gateway,linked,lan,backup,legacy,expected", [
    ("shutdown", True, True, True, True, False, False, "windows_direct"),
    ("wake", False, True, True, False, False, False, "wake_gateway"),
    ("shutdown", True, False, False, False, False, False, "windows_direct"),
    ("wake", False, False, True, False, False, False, "unavailable"),
    ("shutdown", False, True, True, True, True, False, "gateway_relay"),
    ("shutdown", False, True, True, False, True, False, "unavailable"),
    ("shutdown", False, True, False, True, True, False, "unavailable"),
    ("status", False, True, True, False, False, True, "gateway_relay"),
])
def test_routes(action, windows, gateway, linked, lan, backup, legacy, expected):
    assert select_route(action, windows_online=windows, gateway_online=gateway,
                        linked_gateway=linked, windows_lan_online=lan,
                        backup_relay_enabled=backup, legacy=legacy) == expected
