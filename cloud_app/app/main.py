from __future__ import annotations

from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime
import hmac
import ipaddress
from pathlib import Path
import secrets
import threading
import time
import json
from io import BytesIO

import qrcode
from qrcode.image.svg import SvgPathImage
from markupsafe import Markup

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import and_, delete, func, select
from starlette.concurrency import run_in_threadpool
from webauthn.helpers.exceptions import WebAuthnException

from cloud_app.app.auth import SESSION_SECONDS, create_session, current_session, digest, parse_form, read_limited, require_csrf
from cloud_app.app.automation import owned_device, register_automation_routes
from cloud_app.app.database import make_engine, migrate, session_factory
from cloud_app.app.identity import BootstrapCode, Identity
from cloud_app.app.enrollment import EnrollmentError
from cloud_app.app.models import AuditLog, Device, NotificationConfig, User
from cloud_app.app.clients import CLIENT_ACTIONS
from cloud_app.app.events import device_events
from cloud_app.app.notify import Notifier
from cloud_app.app.scheduled import SCHEDULE_ZONE, Scheduler, schedule_description
from cloud_app.app.platform import ADMIN_ID, Platform
from cloud_app.app.settings import Settings
from cloud_app.password import verify_password

VERSION = "1.7.2"
PROTOCOL_VERSION = "2"
ROOT = Path(__file__).resolve().parents[1]
templates = Jinja2Templates(directory=str(ROOT / "templates"))
ACTION_LABELS = {"status": "查看状态", "sleep": "睡眠", "hibernate": "休眠", "restart": "重启", "shutdown": "关机", "wake": "开机"}
ROUTE_LABELS = {"gateway_relay": "网关连接", "wake_gateway": "唤醒网关", "windows_direct": "云端直连"}
STATE_LABELS = {"accepted": "已接收", "transitioning": "正在执行", "completed": "已完成", "failed": "未完成"}
EVENT_LABELS = {"login": "登录", "login_failed": "登录失败", "logout": "退出登录", "setup_completed": "完成初始化", "device_renamed": "设备改名", "command_issued": "已发送命令", "enrollment_created": "创建配对码", "device_enrolled": "设备已连接", "device_revoked": "设备已移除", "refresh_rotated": "设备凭据已更新", "refresh_reuse": "设备凭据异常", "passkey_registered": "添加 Passkey", "passkey_login": "Passkey 登录", "recovery_created": "生成恢复码", "recovery_used": "使用恢复码"}
EVENT_LABELS.update({"enrollment_approved": "允许设备连接", "enrollment_denied": "拒绝设备连接"})
EVENT_LABELS.update({"client_enrollment_created": "创建客户端二维码", "client_enrolled": "客户端已授权",
                     "client_revoked": "客户端已移除", "client_refresh_rotated": "客户端凭据已更新",
                     "client_refresh_reuse": "客户端凭据异常"})
EVENT_LABELS.update({"gateway_linked": "关联唤醒网关", "gateway_unlinked": "移除网关关联"})
EVENT_LABELS.update({"device_credential_failed": "设备授权失败", "client_credential_failed": "客户端授权失败"})
EVENT_LABELS.update({"schedule_created": "创建计划任务", "schedule_deleted": "删除计划任务",
                     "schedule_fired": "计划任务已执行", "schedule_failed": "计划任务执行失败",
                     "schedule_toggled": "切换计划任务状态", "device_grouped": "修改设备分组",
                     "notification_saved": "保存离线通知", "notification_deleted": "删除离线通知",
                     "notification_toggled": "切换离线通知状态"})
templates.env.filters["action_label"] = lambda value: ACTION_LABELS.get(value, value)
templates.env.filters["route_label"] = lambda value: ROUTE_LABELS.get(value, value)
templates.env.filters["state_label"] = lambda value: STATE_LABELS.get(value, value)
templates.env.filters["event_label"] = lambda value: EVENT_LABELS.get(value, value)


def relative_time(value: int | None) -> str:
    if value is None: return "暂无记录"
    elapsed = max(0, int(time.time()) - value)
    if elapsed < 60: return "刚刚"
    if elapsed < 3600: return f"{elapsed // 60} 分钟前"
    if elapsed < 86400: return f"{elapsed // 3600} 小时前"
    return f"{elapsed // 86400} 天前"


templates.env.filters["relative_time"] = relative_time
templates.env.filters["absolute_time"] = lambda value: (datetime.fromtimestamp(value, SCHEDULE_ZONE)
    .strftime("%Y-%m-%d %H:%M") if value is not None else "–")
templates.env.filters["schedule_description"] = schedule_description


class LoginLimiter:
    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._ceremonies: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def blocked(self, address: str) -> bool:
        with self._lock:
            attempts = self._failures[address]
            while attempts and attempts[0] < time.monotonic() - 300:
                attempts.popleft()
            return len(attempts) >= 5

    def fail(self, address: str) -> None:
        with self._lock:
            self._failures[address].append(time.monotonic())

    def clear(self, address: str) -> None:
        with self._lock:
            self._failures.pop(address, None)

    def allow_ceremony(self, address: str) -> bool:
        with self._lock:
            attempts = self._ceremonies[address]
            while attempts and attempts[0] < time.monotonic() - 300:
                attempts.popleft()
            if len(attempts) >= 20:
                return False
            attempts.append(time.monotonic())
            return True


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_environment()
    settings.validate()
    migrate(settings.database_url)
    engine = make_engine(settings.database_url)
    platform = Platform(settings, session_factory(engine))
    identity = Identity(platform.sessions, settings.public_url)
    bootstrap = BootstrapCode(settings.database_url,
                              enabled=settings.admin_password_hash is None and not identity.initialized(ADMIN_ID))
    if identity.initialized(ADMIN_ID):
        bootstrap.disable()
    limiter = LoginLimiter()
    enrollment_limiter = LoginLimiter()
    notifier = Notifier(platform)
    scheduler = Scheduler(platform, notifier)

    @asynccontextmanager
    async def lifespan(_app):
        scheduler.start()
        try:
            yield
        finally:
            await run_in_threadpool(scheduler.stop)
            engine.dispose()

    app = FastAPI(title="LanPower Cloud", version=VERSION, docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    app.state.platform = platform
    app.state.identity = identity
    app.state.bootstrap = bootstrap
    app.state.engine = engine
    app.state.scheduler = scheduler
    app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, error: HTTPException):
        return JSONResponse({"error": error.detail}, status_code=error.status_code)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    def web_session(request: Request):
        with platform.sessions() as db:
            return current_session(request, db)

    def browser_guard(request: Request):
        session = web_session(request)
        if session is None:
            return None, RedirectResponse("/login", status_code=303)
        return session, None

    def page(request: Request, name: str, session, **context):
        status = context.pop("status", 200)
        base = {"request": request, "page": name, "csrf": request.cookies.get("lp_csrf", ""),
                "version": VERSION, "public_url": settings.public_url, "action_labels": ACTION_LABELS}
        base.update(context)
        return templates.TemplateResponse(request, name + ".html", base, status_code=status)

    def session_response(path: str, owner_id: str, *, payload: dict | None = None) -> Response:
        with platform.sessions() as db:
            owner = db.get(User, owner_id)
            if owner is None or owner.revoked_at is not None:
                raise HTTPException(401, "unauthorized")
            token, csrf = create_session(db, owner)
        response = (JSONResponse({"redirect": path, **payload}) if payload is not None
                    else RedirectResponse(path, status_code=303))
        response.set_cookie("lp_session", token, max_age=SESSION_SECONDS, secure=True, httponly=True, samesite="strict")
        response.set_cookie("lp_csrf", csrf, max_age=SESSION_SECONDS, secure=True, httponly=True, samesite="strict")
        response.delete_cookie("lp_auth", secure=True, httponly=True, samesite="strict")
        return response

    def json_csrf(request: Request, session) -> None:
        require_csrf(request, session, {"csrf": request.headers.get("x-csrf-token", "")})

    def session_owner(request: Request):
        session, redirect = browser_guard(request)
        if redirect:
            raise HTTPException(401, "unauthorized")
        return session

    def client_owner(request: Request, *, mutation: bool = False, action: str | None = None) -> str:
        authorization = request.headers.get("authorization")
        if authorization is not None:
            if not authorization.startswith("Bearer "):
                raise HTTPException(401, "unauthorized")
            try:
                owner_id, client_id = platform.mobile.authorize(authorization[7:])
            except PermissionError as error:
                raise HTTPException(401, str(error)) from error
            if action is not None and not platform.mobile.permits(client_id, action):
                raise HTTPException(403, f"此客户端无权执行“{ACTION_LABELS.get(action, action)}”操作")
            return owner_id
        session = session_owner(request)
        if mutation:
            json_csrf(request, session)
        return session.owner_id

    def setup_available() -> bool:
        # Check persisted state on every request, including across worker restarts.
        return bootstrap.enabled and not identity.initialized(ADMIN_ID)

    def auth_page(request: Request, name: str = "login", *, error: bool = False, status: int = 200):
        token = request.cookies.get("lp_auth", "")
        if len(token) != 43 or not token.isascii() or not all(c.isalnum() or c in "_-" for c in token):
            token = secrets.token_urlsafe(32)
        response = page(request, name, None, auth_token=token, error=error, status=status,
                        passkey_enabled=identity.has_passkey(ADMIN_ID),
                        password_enabled=settings.admin_password_hash is not None)
        response.set_cookie("lp_auth", token, max_age=600, secure=True, httponly=True, samesite="strict")
        return response

    def auth_binding(request: Request, supplied: str | None = None) -> str:
        cookie = request.cookies.get("lp_auth", "")
        supplied = supplied if supplied is not None else request.headers.get("x-auth-token", "")
        origin = request.headers.get("origin")
        if (len(cookie) != 43 or len(supplied) > 128 or
                not hmac.compare_digest(digest(cookie), digest(supplied)) or
                # Referrer-Policy: no-referrer can produce Origin: null on native
                # form posts. The page token and SameSite cookie still bind them.
                (origin not in (None, "null", settings.public_url.rstrip("/"))) or
                request.headers.get("sec-fetch-site") == "cross-site"):
            raise HTTPException(403, "请刷新页面后重试")
        return cookie

    def login_address(request: Request, *, ceremony: bool = False) -> str:
        address = request.client.host if request.client else "unknown"
        if limiter.blocked(address) or (ceremony and not limiter.allow_ceremony(address)):
            raise HTTPException(429, "尝试次数过多，请在 5 分钟后重试")
        return address

    def failed_login(address: str) -> None:
        limiter.fail(address)
        platform.record(ADMIN_ID, "login_failed")

    def registration_proof(request: Request, payload: dict) -> tuple[str, str, bool]:
        if "setup_code" in payload:
            if not setup_available():
                raise HTTPException(404, "初始化已关闭")
            binding = auth_binding(request)
            address = login_address(request)
            code = payload["setup_code"]
            if not isinstance(code, str) or not bootstrap.verify(code):
                failed_login(address)
                raise HTTPException(401, "初始化验证码无效")
            return ADMIN_ID, binding, True
        session = session_owner(request)
        json_csrf(request, session)
        return session.owner_id, session.token_hash, False

    def credential_payload(payload: dict) -> tuple[str, dict]:
        challenge_id, credential = payload.get("challenge_id"), payload.get("credential")
        if not isinstance(challenge_id, str) or len(challenge_id) != 36 or not isinstance(credential, dict):
            raise HTTPException(400, "验证内容无效，请重试")
        return challenge_id, credential

    def authorized(request: Request, role: str) -> None:
        if settings.legacy is None:
            raise HTTPException(404, "legacy gateway not configured")
        secret = settings.legacy.gateway_secret if role == "gateway" else settings.legacy.client_secret
        if not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + secret):
            raise HTTPException(401, "unauthorized")

    async def json_body(request: Request, limit: int = 4096) -> dict:
        if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
            raise HTTPException(400, "invalid JSON")
        header_length = request.headers.get("content-length")
        if header_length is not None:
            try:
                length = int(header_length)
            except ValueError as error:
                raise HTTPException(400, "invalid body size") from error
            if length < 2 or length > limit:
                raise HTTPException(400, "invalid body size")
        try:
            body = await read_limited(request, limit)
            if len(body) < 2:
                raise HTTPException(400, "invalid body size")
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise HTTPException(400, "invalid JSON") from exc
        if not isinstance(payload, dict):
            raise HTTPException(400, "body must be an object")
        return payload

    def relay_error(error: Exception) -> HTTPException:
        if isinstance(error, ConnectionError): return HTTPException(503, str(error))
        if isinstance(error, BlockingIOError): return HTTPException(429, str(error))
        return HTTPException(400, str(error))

    def device_identity(request: Request, device_type: str | None = "windows") -> tuple[str, str]:
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "device unauthorized")
        try:
            return platform.tokens.authorize(authorization[7:], expected_type=device_type)
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "version": VERSION, "protocol_version": PROTOCOL_VERSION}

    @app.post("/api/v1/gateway/heartbeat")
    async def v1_heartbeat(request: Request):
        authorized(request, "gateway")
        payload = await json_body(request)
        try:
            await run_in_threadpool(platform.relay.heartbeat, payload)
        except ValueError as error:
            raise relay_error(error) from error
        with platform.sessions.begin() as db:
            gateway = db.get(Device, platform.gateway_id)
            gateway.version = payload["version"]
            gateway.last_seen_at = int(time.time())
        return {"ok": True}

    @app.get("/api/v1/gateway/commands")
    def v1_poll(request: Request, gateway_id: str = ""):
        authorized(request, "gateway")
        if gateway_id != settings.legacy.gateway_id:
            raise HTTPException(400, "invalid gateway")
        return {"command": platform.relay.poll()}

    @app.post("/api/v1/gateway/results")
    async def v1_result(request: Request):
        authorized(request, "gateway")
        payload = await json_body(request)
        try:
            await run_in_threadpool(platform.relay.result, payload)
        except ValueError as error:
            raise relay_error(error) from error
        return {"ok": True}

    @app.get("/api/v1/client/status")
    def v1_status(request: Request, gateway_id: str = ""):
        authorized(request, "client")
        if gateway_id != settings.legacy.gateway_id:
            raise HTTPException(400, "invalid gateway")
        return platform.relay.status()

    @app.post("/api/v1/client/commands")
    async def v1_command(request: Request):
        authorized(request, "client")
        payload = await json_body(request)
        if set(payload) != {"gateway_id", "action"} or payload["gateway_id"] != settings.legacy.gateway_id or not isinstance(payload["action"], str):
            raise HTTPException(400, "invalid command request")
        try:
            command = await run_in_threadpool(platform.relay.issue, payload["action"])
            return await run_in_threadpool(platform.relay.wait_result, command["command_id"])
        except (ValueError, ConnectionError, BlockingIOError) as error:
            raise relay_error(error) from error

    @app.get("/")
    def home(request: Request):
        if setup_available(): return RedirectResponse("/setup", status_code=303)
        return RedirectResponse("/dashboard" if web_session(request) else "/login", status_code=303)

    @app.get("/setup")
    def setup_page(request: Request):
        if not setup_available(): raise HTTPException(404, "初始化已关闭")
        return auth_page(request, "setup")

    @app.get("/login")
    def login_page(request: Request):
        if setup_available(): return RedirectResponse("/setup", status_code=303)
        if web_session(request): return RedirectResponse("/dashboard", status_code=303)
        return auth_page(request)

    @app.post("/login")
    async def login(request: Request):
        if settings.admin_password_hash is None:
            raise HTTPException(404, "密码登录未启用")
        address = request.client.host if request.client else "unknown"
        if limiter.blocked(address):
            return auth_page(request, error=True, status=429)
        form = await parse_form(request)
        auth_binding(request, form.get("auth", ""))
        username, password = form.get("username", ""), form.get("password", "")
        with platform.sessions() as db:
            owner = db.scalar(select(User).where(User.username == username, User.revoked_at.is_(None)))
            valid = verify_password(password, owner.password_hash if owner else settings.admin_password_hash or "")
            if not owner or not valid:
                failed_login(address)
                return auth_page(request, error=True, status=401)
        limiter.clear(address)
        platform.record(owner.id, "login")
        return session_response("/dashboard", owner.id)

    @app.post("/api/v2/auth/passkeys/register/options")
    async def passkey_register_options(request: Request):
        payload = await json_body(request)
        owner_id, binding, setup = registration_proof(request, payload)
        login_address(request, ceremony=True)
        try:
            return identity.registration_options(owner_id, binding, setup=setup)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.post("/api/v2/auth/passkeys/register/verify")
    async def passkey_register_verify(request: Request):
        payload = await json_body(request, limit=65536)
        owner_id, binding, setup = registration_proof(request, payload)
        address = login_address(request)
        challenge_id, credential = credential_payload(payload)
        try:
            codes = identity.finish_registration(owner_id, challenge_id, credential, binding, setup=setup)
        except (ValueError, WebAuthnException) as error:
            failed_login(address)
            raise HTTPException(400, "Passkey 验证失败，请重新开始") from error
        limiter.clear(address)
        bootstrap.disable()
        return session_response("/settings" if not setup else "/dashboard", owner_id,
                                payload={"recovery_codes": codes})

    @app.post("/api/v2/auth/passkeys/login/options")
    async def passkey_login_options(request: Request):
        binding = auth_binding(request)
        login_address(request, ceremony=True)
        await json_body(request)
        try:
            return identity.authentication_options(ADMIN_ID, binding)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.post("/api/v2/auth/passkeys/login/verify")
    async def passkey_login_verify(request: Request):
        binding = auth_binding(request)
        address = login_address(request)
        challenge_id, credential = credential_payload(await json_body(request, limit=65536))
        try:
            owner_id = identity.finish_authentication(ADMIN_ID, challenge_id, credential, binding)
        except (ValueError, WebAuthnException) as error:
            failed_login(address)
            raise HTTPException(401, "Passkey 登录失败，请重试") from error
        limiter.clear(address)
        return session_response("/dashboard", owner_id, payload={})

    @app.post("/api/v2/auth/recovery")
    async def recovery_login(request: Request):
        auth_binding(request)
        address = login_address(request)
        payload = await json_body(request)
        code = payload.get("code")
        if not isinstance(code, str) or len(code) > 128 or not identity.use_recovery_code(ADMIN_ID, code):
            failed_login(address)
            raise HTTPException(401, "恢复码无效或已使用")
        limiter.clear(address)
        return session_response("/settings", ADMIN_ID, payload={})

    @app.post("/logout")
    async def logout(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        form = await parse_form(request)
        require_csrf(request, session, form)
        with platform.sessions.begin() as db:
            db.delete(db.merge(session))
        platform.record(session.owner_id, "logout")
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie("lp_session")
        response.delete_cookie("lp_csrf")
        return response

    @app.get("/dashboard")
    def dashboard(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        devices = platform.devices(session.owner_id)
        return page(request, "dashboard", session, devices=devices,
                    device_names={device.id: device.name for device in devices},
                    statuses={device.id: platform.device_status(session.owner_id, device.id) for device in devices},
                    presence=platform.presence(), commands=platform.recent_commands(session.owner_id))

    @app.get("/devices")
    def devices_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        devices = platform.devices(session.owner_id)
        return page(request, "devices", session, devices=devices,
                    statuses={device.id: platform.device_status(session.owner_id, device.id) for device in devices})

    @app.get("/devices/enroll")
    def enroll_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return RedirectResponse("/enroll", status_code=303)

    @app.get("/enroll")
    def approve_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return page(request, "approve", session, device=None, user_code="", message="", error="")

    @app.post("/enroll/lookup")
    async def approve_lookup(request: Request):
        session = session_owner(request)
        form = await parse_form(request)
        require_csrf(request, session, form)
        if not enrollment_limiter.allow_ceremony(session.owner_id):
            raise HTTPException(429, "查询次数过多，请稍后重试")
        code = form.get("user_code", "")
        try:
            device = platform.enrollment.lookup(code)
            return page(request, "approve", session, device=device, user_code=code, message="", error="")
        except ValueError as error:
            return page(request, "approve", session, device=None, user_code="", message="", error=str(error), status=400)

    @app.post("/enroll/decision")
    async def approve_decision(request: Request):
        session = session_owner(request)
        form = await parse_form(request)
        require_csrf(request, session, form)
        if not enrollment_limiter.allow_ceremony(session.owner_id):
            raise HTTPException(429, "尝试次数过多，请稍后重试")
        decision = form.get("decision")
        if decision not in {"approve", "deny"}:
            raise HTTPException(400, "请选择允许或拒绝")
        try:
            platform.enrollment.decide(session.owner_id, form.get("user_code", ""), approved=decision == "approve")
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return page(request, "approve", session, device=None, user_code="", error="",
                    message="已允许连接，请返回设备等待完成。" if decision == "approve" else "已拒绝此设备。")

    @app.post("/devices/enroll")
    async def enroll_code(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        form = await parse_form(request)
        require_csrf(request, session, form)
        code = platform.windows.create_enrollment(session.owner_id)
        return page(request, "enroll", session, code=code)

    @app.post("/devices/{device_id}/rename")
    async def rename(request: Request, device_id: str):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        form = await parse_form(request)
        require_csrf(request, session, form)
        name = form.get("name", "").strip()
        if not 1 <= len(name) <= 100:
            raise HTTPException(400, "invalid name")
        with platform.sessions.begin() as db:
            device = db.scalar(select(Device).where(Device.id == device_id, Device.owner_id == session.owner_id, Device.revoked_at.is_(None)))
            if device is None: raise HTTPException(404, "device unavailable")
            device.name = name
            destination = "/gateways" if device.device_type == "gateway" else "/devices"
        platform.record(session.owner_id, "device_renamed", device_id)
        return RedirectResponse(destination, status_code=303)

    @app.post("/devices/{device_id}/revoke")
    async def revoke_device(request: Request, device_id: str):
        session = session_owner(request)
        form = await parse_form(request)
        require_csrf(request, session, form)
        device = platform.device(session.owner_id, device_id)
        destination = "/gateways" if device and device.device_type == "gateway" else "/devices"
        try:
            platform.windows.revoke_device(session.owner_id, device_id)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return RedirectResponse(destination, status_code=303)

    @app.get("/gateways")
    def gateways_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        devices = platform.devices(session.owner_id)
        selected = next((device for device in devices if device.device_type == "windows"
                         and device.id == request.query_params.get("computer")), None)
        return page(request, "gateways", session, devices=devices, links=platform.links(session.owner_id),
                    selected_computer=selected,
                    statuses={device.id: platform.device_status(session.owner_id, device.id) for device in devices})

    @app.post("/gateways/{gateway_id}/links")
    async def gateway_link(request: Request, gateway_id: str):
        session = session_owner(request)
        form = await parse_form(request)
        require_csrf(request, session, form)
        if form.get("operation", "save") not in {"save", "remove"}:
            raise HTTPException(400, "invalid operation")
        try:
            platform.gateway.link(session.owner_id, gateway_id, form.get("windows_id", ""),
                                  backup=form.get("backup") == "on", remove=form.get("operation") == "remove")
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return RedirectResponse("/gateways?computer=" + form.get("windows_id", ""), status_code=303)

    @app.get("/clients")
    def clients_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return page(request, "clients", session, clients=platform.mobile.list(session.owner_id),
                    legacy_clients=platform.clients(session.owner_id), pairing=None)

    @app.post("/clients/enroll")
    async def client_enrollment(request: Request):
        session = session_owner(request)
        form = await parse_form(request)
        require_csrf(request, session, form)
        if not enrollment_limiter.allow_ceremony(session.owner_id):
            raise HTTPException(429, "尝试次数过多，请稍后重试")
        try:
            actions = ([action for action in CLIENT_ACTIONS if form.get("allow_" + action) == "on"]
                       if form.get("scopes_present") == "1" else None)
            code = platform.mobile.create_enrollment(session.owner_id, form.get("name", ""), actions)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        pairing = settings.public_url.rstrip("/") + "/#lanpower-client=" + code
        svg = BytesIO()
        qrcode.make(pairing, image_factory=SvgPathImage, border=4, box_size=6).save(svg)
        return page(request, "clients", session, clients=platform.mobile.list(session.owner_id),
                    legacy_clients=platform.clients(session.owner_id), pairing=pairing,
                    pairing_svg=Markup(svg.getvalue().decode("utf-8")))

    @app.post("/clients/{client_id}/revoke")
    async def revoke_client(request: Request, client_id: str):
        session = session_owner(request)
        require_csrf(request, session, await parse_form(request))
        try:
            platform.mobile.revoke(session.owner_id, client_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from error
        return RedirectResponse("/clients", status_code=303)

    @app.post("/api/v2/clients/enroll")
    async def mobile_enroll(request: Request):
        if not enrollment_limiter.allow_ceremony(request.client.host if request.client else "unknown"):
            raise HTTPException(429, "enrollment rate limit")
        try:
            return platform.mobile.enroll(await json_body(request))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.post("/api/v2/clients/token")
    async def mobile_token(request: Request):
        try:
            return platform.mobile.refresh(await json_body(request))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.post("/api/v2/clients/renew")
    async def mobile_renew(request: Request):
        try:
            return platform.mobile.renew(await json_body(request))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.post("/api/v2/clients/revoke")
    def mobile_revoke(request: Request):
        authorization = request.headers.get("authorization", "")
        try:
            owner_id, client_id = platform.mobile.authorize(authorization[7:] if authorization.startswith("Bearer ") else "")
            platform.mobile.revoke(owner_id, client_id)
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error
        except ValueError as error:
            raise HTTPException(404, str(error)) from error
        return {"ok": True}

    @app.get("/activity")
    def activity_page(request: Request, event: str = "", page_number: int = Query(1, alias="page", ge=1)):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        filters = [AuditLog.owner_id == session.owner_id]
        if event:
            filters.append(AuditLog.event == event)
        with platform.sessions() as db:
            total = db.scalar(select(func.count()).select_from(AuditLog).where(*filters))
            total_pages = max(1, (total + 49) // 50)
            page_number = min(page_number, total_pages)
            events = db.execute(select(AuditLog, Device.name.label("device_name"))
                .outerjoin(Device, and_(Device.id == AuditLog.target_device_id, Device.owner_id == session.owner_id))
                .where(*filters).order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
                .offset((page_number - 1) * 50).limit(50)).all()
        return page(request, "activity", session, events=events, selected_event=event,
                    event_labels=EVENT_LABELS, page_number=page_number, total_pages=total_pages, total=total,
                    device_names={device.id: device.name for device in platform.devices(session.owner_id)},
                    commands=platform.recent_commands(session.owner_id))

    @app.get("/settings")
    def settings_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        with platform.sessions() as db:
            notifications = db.execute(select(NotificationConfig, Device.name.label("device_name"))
                .join(Device, Device.id == NotificationConfig.device_id)
                .where(NotificationConfig.owner_id == session.owner_id, Device.owner_id == session.owner_id)
                .order_by(Device.name, NotificationConfig.id)).all()
        return page(request, "settings", session, passkeys=identity.passkeys(session.owner_id),
                    recovery_count=identity.recovery_count(session.owner_id)[1],
                    password_enabled=settings.admin_password_hash is not None,
                    devices=platform.devices(session.owner_id), notifications=notifications,
                    notifications_enabled=notifier.enabled)

    @app.get("/system")
    def system_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return RedirectResponse("/settings#service", status_code=303)

    @app.post("/devices/{device_id}/commands")
    async def web_command(request: Request, device_id: str):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        form = await parse_form(request)
        require_csrf(request, session, form)
        action = form.get("action", "")
        if action not in {"wake", "status", "sleep", "hibernate", "restart", "shutdown"}:
            raise HTTPException(400, "unknown action")
        try:
            result = await run_in_threadpool(platform.issue_command, session.owner_id, device_id, action)
        except (ValueError, ConnectionError, BlockingIOError) as error:
            return page(request, "result", session, success=False, pending=False, action=action, route="", message=str(error), command_id=None)
        pending = result.get("accepted", False) and result.get("state") == "accepted"
        return page(request, "result", session, success=result.get("ok", False), pending=pending, action=action,
                    route=result["route"], message=result.get("error", ""), command_id=result.get("command_id"))

    @app.post("/api/v2/windows/enroll")
    async def windows_enroll(request: Request):
        payload = await json_body(request)
        try:
            return platform.windows.enroll(payload)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.post("/api/v2/enroll/start")
    async def enroll_start(request: Request):
        address = request.client.host if request.client else "unknown"
        if not enrollment_limiter.allow_ceremony(address):
            raise HTTPException(429, "enrollment rate limit")
        try:
            return platform.enrollment.start(await json_body(request))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.post("/api/v2/enroll/token")
    async def enroll_exchange(request: Request):
        try:
            return platform.enrollment.exchange(await json_body(request))
        except EnrollmentError as error:
            raise HTTPException(429 if str(error) == "slow_down" else 400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.post("/api/v2/devices/revoke")
    def device_disconnect(request: Request):
        # A device may only remove its own identity. Browser/client credentials
        # cannot call this endpoint and no caller-supplied target is accepted.
        owner_id, device_id = device_identity(request, None)
        try:
            platform.windows.revoke_device(owner_id, device_id)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return {"ok": True}

    @app.post("/api/v2/devices/token")
    async def device_token(request: Request):
        try:
            return platform.tokens.refresh(await json_body(request))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.post("/api/v2/devices/renew")
    async def device_renew(request: Request):
        try:
            return platform.tokens.renew(await json_body(request), expected_type="gateway")
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.post("/api/v2/windows/token")
    async def windows_token(request: Request):
        payload = await json_body(request)
        try:
            return platform.windows.refresh(payload)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.post("/api/v2/windows/heartbeat")
    async def windows_heartbeat(request: Request):
        owner_id, device_id = device_identity(request)
        payload = await json_body(request)
        try:
            platform.windows.heartbeat(device_id, payload)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error
        status = platform.device_status(owner_id, device_id)
        return {"ok": True, "wake_available": status["wake_available"], "wake_gateway": status["wake_gateway"],
                "presence_protocol": 1, "wake_setup_protocol": 1, "wake_setup_message": status["wake_setup_message"]}

    @app.get("/api/v2/windows/commands")
    def windows_commands(request: Request):
        _owner_id, device_id = device_identity(request)
        return {"command": platform.windows.poll(device_id)}

    @app.post("/api/v2/windows/results")
    async def windows_results(request: Request):
        _owner_id, device_id = device_identity(request)
        payload = await json_body(request)
        try:
            platform.windows.result(device_id, payload)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return {"ok": True}

    @app.get("/api/v2/devices")
    def api_devices(request: Request):
        owner_id = client_owner(request)
        return [platform.device_status(owner_id, device.id) for device in platform.devices(owner_id)]

    @app.post("/api/v2/gateway/heartbeat")
    async def gateway_heartbeat(request: Request):
        owner_id, device_id = device_identity(request, "gateway")
        try:
            platform.gateway.heartbeat(owner_id, device_id, await json_body(request, limit=8192))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error
        return {"ok": True}

    @app.get("/api/v2/gateway/commands")
    def gateway_commands(request: Request):
        _, device_id = device_identity(request, "gateway")
        return {"command": platform.gateway.poll(device_id)}

    @app.post("/api/v2/gateway/wake-setup")
    async def gateway_wake_setup(request: Request):
        owner_id, device_id = device_identity(request, "gateway")
        try:
            targets = platform.gateway.sync_wake_setup(owner_id, device_id, await json_body(request, limit=8192))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error
        return {"targets": targets}

    @app.post("/api/v2/gateway/results")
    async def gateway_results(request: Request):
        _, device_id = device_identity(request, "gateway")
        try:
            platform.gateway.result(device_id, await json_body(request))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return {"ok": True}

    @app.get("/api/v2/devices/{device_id}")
    def api_device(request: Request, device_id: str):
        owner_id = client_owner(request)
        try:
            return platform.device_status(owner_id, device_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from error

    @app.get("/api/v2/events/devices")
    async def events(request: Request):
        session = session_owner(request)

        def snapshot():
            statuses = []
            for device in platform.devices(session.owner_id):
                try:
                    statuses.append(platform.device_status(session.owner_id, device.id))
                except ValueError:
                    # A device can be revoked between listing and reading it.
                    continue
            return statuses

        return StreamingResponse(device_events(request, snapshot, lambda: web_session(request) is not None),
            media_type="text/event-stream", headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"})

    @app.get("/api/v2/devices/{device_id}/online")
    def device_online(request: Request, device_id: str):
        owner_id = client_owner(request)
        try:
            status = platform.device_status(owner_id, device_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from error
        return {"online": status["state"] == "online", "last_seen": status["last_seen_at"], "state": status["state"]}

    @app.get("/api/v2/devices/{device_id}/remote-desktop")
    def remote_desktop(request: Request, device_id: str):
        session = session_owner(request)
        with platform.sessions() as db:
            owned_device(db, session.owner_id, device_id, windows=True)
        try:
            status = platform.device_status(session.owner_id, device_id)
        except ValueError as error:
            raise HTTPException(404, "设备不可用") from error
        if status["state"] != "online":
            raise HTTPException(409, "电脑已离线，请等待上线后重试")
        try:
            # Accept only an IP literal; device metadata must never inject RDP settings.
            raw_ip = status.get("lan_ip")
            if not isinstance(raw_ip, str) or "%" in raw_ip:
                raise ValueError("invalid address")
            address = ipaddress.ip_address(raw_ip)
        except ValueError as error:
            raise HTTPException(409, "电脑尚未上报有效的局域网 IP，请稍后重试") from error
        host = f"[{address}]" if address.version == 6 else str(address)
        content = (f"full address:s:{host}:3389\r\n"
                   "prompt for credentials:i:1\r\n"
                   "authentication level:i:2\r\n")
        return Response(content.encode("utf-16"), media_type="application/x-rdp",
                        headers={"Content-Disposition": 'attachment; filename="LanPower.rdp"',
                                 "Cache-Control": "no-store"})

    @app.post("/api/v2/devices/{device_id}/commands")
    async def api_command(request: Request, device_id: str):
        owner_id = client_owner(request, mutation=True)
        payload = await json_body(request)
        if set(payload) != {"action"} or not isinstance(payload["action"], str) or payload["action"] not in ACTION_LABELS:
            raise HTTPException(400, "invalid command request")
        if request.headers.get("authorization") is not None:
            client_owner(request, action=payload["action"])
        try:
            return await run_in_threadpool(platform.issue_command, owner_id, device_id, payload["action"])
        except (ValueError, ConnectionError, BlockingIOError) as error:
            raise relay_error(error) from error

    @app.get("/api/v2/commands/{command_id}")
    def api_command_result(request: Request, command_id: str):
        owner_id = client_owner(request)
        try:
            return platform.windows.command_result(owner_id, command_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from error

    register_automation_routes(app, platform, session_owner, browser_guard, page)
    return app
