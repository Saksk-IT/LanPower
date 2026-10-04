import pytest
from cloud_app.app.remote import ProtocolError, validate_request

@pytest.mark.parametrize("method", ["skills/list", "plugin/list"])
def test_bounded_native_catalog_pagination(method):
    payload = {"id": "page", "method": method, "params": {"cwd": "D:/Fixture", "limit": 24, "refresh": True}}
    assert validate_request(payload) == method
    payload["params"]["cursor"] = "opaque:24"
    assert validate_request(payload) == method
    for invalid in (25, 0, True):
        payload["params"]["limit"] = invalid
        with pytest.raises(ProtocolError): validate_request(payload)

@pytest.mark.parametrize("method", ["skills/list", "plugin/list"])
def test_catalog_refresh_must_be_boolean(method):
    with pytest.raises(ProtocolError):
        validate_request({"id": "page", "method": method, "params": {"refresh": "true"}})
