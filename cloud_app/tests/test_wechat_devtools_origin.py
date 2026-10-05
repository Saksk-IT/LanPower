import secrets

from fastapi.testclient import TestClient
import pytest

from cloud_app.app.main import create_app
from cloud_app.app.settings import Settings
from cloud_app.password import hash_password


PASSWORD = "devtools test password 123!"
DEMO_APP_ID = "wx" + "0" * 16
DEVTOOLS_HEADERS = {
    "Referer": f"https://servicewechat.com/{DEMO_APP_ID}/devtools/page-frame.html",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}


@pytest.fixture
def local_cloud(tmp_path):
    settings = Settings(None, "sqlite:///" + (tmp_path / "platform.db").as_posix(), hash_password(PASSWORD),
                        "http://localhost:8080", additional_origins=("http://192.168.1.8:8080",),
                        allow_registration=True, allow_local_http=True)
    with TestClient(create_app(settings), base_url=settings.public_url) as client:
        yield client


def login_body(**overrides):
    return {"username": "admin", "password": PASSWORD, "client_type": "mobile",
            "connection_key": secrets.token_urlsafe(32), "name": "Test simulator",
            "version": "3.6.7", "protocol_version": "2", **overrides}


@pytest.mark.parametrize("origin", ["http://localhost:8080", "http://192.168.1.8:8080"])
@pytest.mark.parametrize("appid", [DEMO_APP_ID, "touristappid"])
def test_devtools_can_register_and_login_at_configured_local_http(local_cloud, origin, appid):
    headers = {**DEVTOOLS_HEADERS, "Referer": f"https://servicewechat.com/{appid}/devtools/page-frame.html"}
    registered = local_cloud.post(origin + "/api/v2/account/register", headers=headers,
                                 json={"username": "simulator", "password": PASSWORD})
    assert registered.status_code == 200, registered.text
    response = local_cloud.post(origin + "/api/v2/account/login", headers=headers,
                                json=login_body(username="simulator"))
    assert response.status_code == 200, response.text
    assert response.json()["account"]["username"] == "simulator"
    assert response.json()["client_id"]
    assert response.json()["access_token"]


@pytest.mark.parametrize("overrides", [
    {"Origin": "https://evil.example"},
    {"Origin": "null"},
    {"Origin": "http://127.0.0.1:12553"},
    {"Referer": ""},
    {"Referer": "https://evil.example/devtools/page-frame.html"},
    {"Referer": f"https://servicewechat.com.evil.example/{DEMO_APP_ID}/devtools/page-frame.html"},
    {"Referer": f"https://servicewechat.com/{DEMO_APP_ID}/0/page-frame.html"},
    {"Referer": f"https://servicewechat.com/{DEMO_APP_ID}/devtools/page-frame.html?extra=1"},
    {"Referer": f"https://servicewechat.com/{DEMO_APP_ID}/devtools/page-frame.html#extra"},
    {"Referer": f"http://servicewechat.com/{DEMO_APP_ID}/devtools/page-frame.html"},
    {"Referer": "https://servicewechat.com/invalid/devtools/page-frame.html"},
    {"Cookie": "lp_session=browser-session"},
    {"Sec-Fetch-Mode": "navigate"},
    {"Sec-Fetch-Dest": "iframe"},
    {"Content-Type": "text/plain"},
])
def test_devtools_exception_rejects_other_browser_request_shapes(local_cloud, overrides):
    headers = {**DEVTOOLS_HEADERS, **overrides}
    for path in ("/api/v2/account/register", "/api/v2/account/login"):
        response = local_cloud.post(path, headers=headers, json=login_body())
        assert response.status_code == 403, response.text
        assert response.json()["error"] == "请求来源不可用"


@pytest.mark.parametrize("origin", ["http://other.local:8080", "https://localhost:8080"])
def test_devtools_exception_rejects_unconfigured_request_hosts(local_cloud, origin):
    response = local_cloud.post(origin + "/api/v2/account/login", headers=DEVTOOLS_HEADERS, json=login_body())
    assert response.status_code == 403


def test_devtools_exception_requires_explicit_local_http_opt_in(tmp_path):
    settings = Settings(None, "sqlite:///" + (tmp_path / "platform.db").as_posix(), hash_password(PASSWORD),
                        "https://cloud.example.test")
    with TestClient(create_app(settings), base_url=settings.public_url) as client:
        assert client.post("/api/v2/account/login", headers=DEVTOOLS_HEADERS, json=login_body()).status_code == 403


def test_devtools_requests_still_verify_password_and_connection_key(local_cloud):
    response = local_cloud.post("/api/v2/account/login", headers=DEVTOOLS_HEADERS,
                                json=login_body(password="incorrect password"))
    assert response.status_code == 401
    response = local_cloud.post("/api/v2/account/login", headers=DEVTOOLS_HEADERS,
                                json=login_body(connection_key="predictable"))
    assert response.status_code == 400


def test_phone_requests_without_browser_metadata_remain_supported(local_cloud):
    response = local_cloud.post("/api/v2/account/login", json=login_body())
    assert response.status_code == 200


def test_browser_login_keeps_cross_site_protection(local_cloud):
    local_cloud.get("/login")
    response = local_cloud.post("/login", headers=DEVTOOLS_HEADERS, data={"username": "admin", "password": PASSWORD,
                                "auth": local_cloud.cookies["lp_auth"]})
    assert response.status_code == 403
