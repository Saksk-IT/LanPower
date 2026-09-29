"""Exercise WebAuthn with real P-256 signatures and CBOR, without verifier mocks."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import secrets
import time

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from cloud_app.app.auth import digest
from cloud_app.app.identity import encode
from cloud_app.app.main import create_app
from cloud_app.app.models import AuditLog, AuthChallenge, Passkey, RecoveryCode, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.app.settings import Settings
from cloud_app.tests.test_platform import login, make_client

ORIGIN = "https://power.example.com"
REGISTER = "/api/v2/auth/passkeys/register"
LOGIN = "/api/v2/auth/passkeys/login"


class Authenticator:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.id = secrets.token_bytes(32)

    def credential(self, ceremony, *, register=False, origin=ORIGIN, rp="power.example.com", uv=True, count=0):
        client_data = json.dumps({"type": "webauthn.create" if register else "webauthn.get",
                                  "challenge": ceremony["options"]["challenge"],
                                  "origin": origin, "crossOrigin": False}).encode()
        flags = 1 | (4 if uv else 0) | (64 if register else 0)
        auth_data = sha256(rp.encode()).digest() + bytes([flags]) + count.to_bytes(4, "big")
        response = {"clientDataJSON": encode(client_data)}
        if register:
            public_key = self.key.public_key().public_numbers()
            cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: public_key.x.to_bytes(32, "big"),
                               -3: public_key.y.to_bytes(32, "big")})
            auth_data += bytes(16) + len(self.id).to_bytes(2, "big") + self.id + cose
            response["attestationObject"] = encode(cbor2.dumps({"fmt": "none", "authData": auth_data, "attStmt": {}}))
        else:
            response["authenticatorData"] = encode(auth_data)
            response["signature"] = encode(self.key.sign(auth_data + sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())))
            response["userHandle"] = None
        return {"id": encode(self.id), "rawId": encode(self.id), "type": "public-key", "response": response}


@pytest.fixture
def cloud(tmp_path):
    settings = Settings(None, "sqlite:///" + (tmp_path / "platform.db").as_posix(), None, ORIGIN)
    app = create_app(settings)
    with TestClient(app, base_url=ORIGIN) as client:
        yield client, app, settings
    app.state.engine.dispose()


def anonymous_headers(client, path="/login"):
    client.get(path)
    return {"X-Auth-Token": client.cookies["lp_auth"], "Origin": ORIGIN}


def start_setup(client, app):
    headers = anonymous_headers(client, "/setup")
    proof = {"setup_code": app.state.bootstrap.path.read_text()}
    response = client.post(REGISTER + "/options", headers=headers, json=proof)
    assert response.status_code == 200, response.text
    return headers, proof, response.json()


def setup(client, app, authenticator=None):
    authenticator = authenticator or Authenticator()
    headers, proof, ceremony = start_setup(client, app)
    response = client.post(REGISTER + "/verify", headers=headers, json={**proof,
        "challenge_id": ceremony["challenge_id"], "credential": authenticator.credential(ceremony, register=True)})
    assert response.status_code == 200, response.text
    return authenticator, response.json()["recovery_codes"]


def logout(client):
    return client.post("/logout", data={"csrf": client.cookies["lp_csrf"]}, follow_redirects=False)


def test_setup_passkey_login_and_one_time_recovery(cloud):
    client, app, settings = cloud
    assert client.get("/", follow_redirects=False).headers["location"] == "/setup"
    assert client.post("/login", data={"username": "admin", "password": "anything"}).status_code == 404
    authenticator, codes = setup(client, app)
    assert len(codes) == len(set(codes)) == 10
    assert not app.state.bootstrap.path.exists()
    assert client.get("/setup").status_code == 404
    assert client.get("/dashboard").status_code == 200
    assert "还有 10 个恢复码可用" in client.get("/settings").text
    assert all(code not in client.get("/settings").text for code in codes)
    with app.state.platform.sessions() as db:
        rows = list(db.scalars(select(RecoveryCode)))
        assert {row.code_hash for row in rows} == {digest(code.replace("-", "")) for code in codes}
        assert db.get(User, ADMIN_ID).identity_initialized_at is not None

    csrf = client.cookies["lp_csrf"]
    old_session = client.cookies["lp_session"]
    assert logout(client).status_code == 303
    headers = anonymous_headers(client)
    ceremony = client.post(LOGIN + "/options", headers=headers, json={}).json()
    payload = {"challenge_id": ceremony["challenge_id"], "credential": authenticator.credential(ceremony, count=1)}
    response = client.post(LOGIN + "/verify", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    cookies = response.headers["set-cookie"]
    assert all(flag in cookies for flag in ("Secure", "HttpOnly", "SameSite=strict"))
    assert client.cookies["lp_session"] != old_session
    assert client.cookies["lp_csrf"] != csrf
    active_session = client.cookies["lp_session"]
    with TestClient(app, base_url=ORIGIN) as recovery_client:
        recovery_headers = anonymous_headers(recovery_client)
        response = recovery_client.post("/api/v2/auth/recovery", headers=recovery_headers, json={"code": codes[0].lower()})
        assert response.status_code == 200
        assert client.get("/dashboard", follow_redirects=False).status_code == 303
        assert recovery_client.cookies["lp_session"] != active_session
        logout(recovery_client)
        recovery_headers = anonymous_headers(recovery_client)
        assert recovery_client.post("/api/v2/auth/recovery", headers=recovery_headers, json={"code": codes[0]}).status_code == 401
    with app.state.platform.sessions() as db:
        events = list(db.scalars(select(AuditLog.event)))
        assert {"setup_completed", "passkey_registered", "passkey_login", "recovery_created", "recovery_used"} <= set(events)
        assert events.count("setup_completed") == events.count("recovery_created") == events.count("recovery_used") == 1
    assert app.state.identity.recovery_count(ADMIN_ID) == (10, 9)
    restarted = create_app(settings)
    try:
        with TestClient(restarted, base_url=ORIGIN) as fresh:
            assert fresh.get("/setup").status_code == 404
            assert not restarted.state.bootstrap.path.exists()
    finally:
        restarted.state.engine.dispose()


@pytest.mark.parametrize("field,value", [("origin", "https://other.example.com"), ("rp", "other.example.com"), ("uv", False)])
def test_registration_rejects_wrong_origin_rp_or_absent_user_verification(cloud, field, value):
    client, app, _settings = cloud
    headers, proof, ceremony = start_setup(client, app)
    credential = Authenticator().credential(ceremony, register=True, **{field: value})
    response = client.post(REGISTER + "/verify", headers=headers, json={**proof, "challenge_id": ceremony["challenge_id"], "credential": credential})
    assert response.status_code == 400
    assert not app.state.identity.initialized(ADMIN_ID)
    assert app.state.identity.recovery_count(ADMIN_ID) == (0, 0)
    assert client.get("/setup").status_code == 200


def test_challenge_browser_binding_expiry_and_replay(cloud):
    client, app, _settings = cloud
    authenticator, _codes = setup(client, app)
    logout(client)
    headers = anonymous_headers(client)
    ceremony = client.post(LOGIN + "/options", headers=headers, json={}).json()
    payload = {"challenge_id": ceremony["challenge_id"], "credential": authenticator.credential(ceremony, count=1)}
    with TestClient(app, base_url=ORIGIN) as other:
        other_headers = anonymous_headers(other)
        assert other.post(LOGIN + "/verify", headers=other_headers, json=payload).status_code == 401
    assert client.post(LOGIN + "/verify", headers=headers, json=payload).status_code == 200
    # Keep the original anonymous cookie to exercise replay independently of the CSRF guard.
    client.cookies.set("lp_auth", headers["X-Auth-Token"], domain="power.example.com", path="/")
    assert client.post(LOGIN + "/verify", headers=headers, json=payload).status_code == 401
    ceremony = client.post(LOGIN + "/options", headers=headers, json={}).json()
    with app.state.platform.sessions.begin() as db:
        db.get(AuthChallenge, ceremony["challenge_id"]).expires_at = int(time.time()) - 1
    assert client.post(LOGIN + "/verify", headers=headers, json={"challenge_id": ceremony["challenge_id"],
        "credential": authenticator.credential(ceremony, count=2)}).status_code == 401


@pytest.mark.parametrize("invalid", ["signature", "counter", "challenge", "origin", "uv", "unknown_key"])
def test_login_rejects_invalid_assertions(cloud, invalid):
    client, app, _settings = cloud
    authenticator, _codes = setup(client, app)
    logout(client)
    headers = anonymous_headers(client)
    ceremony = client.post(LOGIN + "/options", headers=headers, json={}).json()
    if invalid == "unknown_key":
        authenticator = Authenticator()
    kwargs = {"origin": "https://other.example.com"} if invalid == "origin" else {"uv": False} if invalid == "uv" else {}
    if invalid == "challenge":
        ceremony["options"]["challenge"] = encode(secrets.token_bytes(32))
    credential = authenticator.credential(ceremony, count=1, **kwargs)
    if invalid == "signature":
        credential["response"]["signature"] = encode(b"invalid signature")
    if invalid == "counter":
        with app.state.platform.sessions.begin() as db:
            db.get(Passkey, encode(authenticator.id)).sign_count = 1
    response = client.post(LOGIN + "/verify", headers=headers, json={"challenge_id": ceremony["challenge_id"], "credential": credential})
    assert response.status_code == 401, response.text
    assert client.get("/dashboard", follow_redirects=False).status_code == 303


def test_setup_proof_csrf_rate_limit_and_disabled_route(cloud):
    client, app, _settings = cloud
    headers = anonymous_headers(client, "/setup")
    proof = {"setup_code": app.state.bootstrap.path.read_text()}
    assert client.post(REGISTER + "/options", json=proof).status_code == 403
    assert client.post(REGISTER + "/options", headers={**headers, "Origin": "https://other.example.com"}, json=proof).status_code == 403
    assert client.post(REGISTER + "/options", headers=headers, json={}).status_code == 401
    for _ in range(5):
        assert client.post(REGISTER + "/options", headers=headers, json={"setup_code": "无效的初始化验证码"}).status_code == 401
    assert client.post(REGISTER + "/options", headers=headers, json=proof).status_code == 429
    assert client.post("/api/v2/auth/recovery", headers=headers, json={"code": "A" * 32}).status_code == 429


def test_legacy_admin_adds_passkey_with_session_csrf_and_keeps_password(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    try:
        assert client.get("/setup").status_code == 404
        csrf = login(client)
        assert client.post(REGISTER + "/options", json={}).status_code == 403
        headers = {"X-CSRF-Token": csrf}
        ceremony = client.post(REGISTER + "/options", headers=headers, json={}).json()
        authenticator = Authenticator()
        response = client.post(REGISTER + "/verify", headers=headers, json={"challenge_id": ceremony["challenge_id"],
            "credential": authenticator.credential(ceremony, register=True)})
        assert response.status_code == 200, response.text
        assert len(response.json()["recovery_codes"]) == 10
        headers["X-CSRF-Token"] = client.cookies["lp_csrf"]
        second = Authenticator()
        ceremony = client.post(REGISTER + "/options", headers=headers, json={}).json()
        assert ceremony["options"]["excludeCredentials"][0]["id"] == encode(authenticator.id)
        response = client.post(REGISTER + "/verify", headers=headers, json={"challenge_id": ceremony["challenge_id"],
            "credential": second.credential(ceremony, register=True)})
        assert response.status_code == 200
        assert response.json()["recovery_codes"] == []
        assert app.state.identity.recovery_count(ADMIN_ID) == (10, 10)
        logout(client)
        assert login(client)
    finally:
        client.close()
        app.state.engine.dispose()


def test_revoked_owner_cannot_keep_web_session_or_use_recovery(cloud):
    client, app, _settings = cloud
    _authenticator, codes = setup(client, app)
    with app.state.platform.sessions.begin() as db:
        db.get(User, ADMIN_ID).revoked_at = int(time.time())
    assert client.get("/api/v2/devices").status_code == 401
    headers = anonymous_headers(client)
    assert client.post("/api/v2/auth/recovery", headers=headers, json={"code": codes[0]}).status_code == 401
    assert app.state.identity.recovery_count(ADMIN_ID) == (10, 10)


def test_parallel_setup_and_recovery_are_single_use(cloud):
    client, app, _settings = cloud
    _headers, _proof, ceremony = start_setup(client, app)
    binding = client.cookies["lp_auth"]
    second = app.state.identity.registration_options(ADMIN_ID, binding, setup=True)
    def finish(options):
        try:
            return app.state.identity.finish_registration(ADMIN_ID, options["challenge_id"],
                Authenticator().credential(options, register=True), binding, setup=True)
        except ValueError:
            return []
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(finish, [ceremony, second]))
    assert sorted(map(len, outcomes)) == [0, 10]
    assert len(app.state.identity.passkeys(ADMIN_ID)) == 1
    code = next(codes for codes in outcomes if codes)[0]
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: app.state.identity.use_recovery_code(ADMIN_ID, code), range(2)))
    assert sorted(outcomes) == [False, True]


@pytest.mark.parametrize("credential", [{}, {"id": []}, {"id": "a", "type": "public-key", "rawId": "a", "response": None}])
def test_malformed_credential_returns_client_error(cloud, credential):
    client, app, _settings = cloud
    headers, proof, ceremony = start_setup(client, app)
    assert client.post(REGISTER + "/verify", headers=headers, json={**proof,
        "challenge_id": ceremony["challenge_id"], "credential": credential}).status_code == 400
