from __future__ import annotations

from collections import defaultdict, deque
import hmac
from pathlib import Path
import threading
import time
import json

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from cloud_app.app.auth import SESSION_SECONDS, create_session, current_session, parse_form, read_limited, require_csrf
from cloud_app.app.database import make_engine, migrate, session_factory
from cloud_app.app.models import Device, User
from cloud_app.app.platform import ADMIN_ID, Platform
from cloud_app.app.settings import Settings
from cloud_app.password import verify_password

VERSION = "1.4.0"
ROOT = Path(__file__).resolve().parents[1]
templates = Jinja2Templates(directory=str(ROOT / "templates"))
ACTION_LABELS = {"status": "查看状态", "sleep": "睡眠", "hibernate": "休眠", "restart": "重启", "shutdown": "关机", "wake": "开机"}
ROUTE_LABELS = {"gateway_relay": "网关连接", "wake_gateway": "唤醒网关", "windows_direct": "云端直连"}
STATE_LABELS = {"accepted": "已接收", "transitioning": "正在执行", "completed": "已完成", "failed": "未完成"}
EVENT_LABELS = {"login": "登录", "login_failed": "登录失败", "logout": "退出登录", "device_renamed": "设备改名", "command_issued": "已发送命令", "enrollment_created": "创建配对码", "device_enrolled": "设备已连接", "device_revoked": "设备已移除", "refresh_rotated": "设备凭据已更新", "refresh_reuse": "设备凭据异常"}
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


class LoginLimiter:
    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = defaultdict(deque)
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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_environment()
    settings.validate()
    migrate(settings.database_url)
    engine = make_engine(settings.database_url)
    platform = Platform(settings, session_factory(engine))
    limiter = LoginLimiter()
    app = FastAPI(title="LanPower Cloud", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.platform = platform
    app.state.engine = engine
    app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, error: HTTPException):
        return JSONResponse({"error": error.detail}, status_code=error.status_code)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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
                "version": VERSION, "public_url": settings.public_url}
        base.update(context)
        return templates.TemplateResponse(request, name + ".html", base, status_code=status)

    def authorized(request: Request, role: str) -> None:
        if settings.legacy is None:
            raise HTTPException(404, "legacy gateway not configured")
        secret = settings.legacy.gateway_secret if role == "gateway" else settings.legacy.client_secret
        if not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + secret):
            raise HTTPException(401, "unauthorized")

    async def json_body(request: Request) -> dict:
        if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
            raise HTTPException(400, "invalid JSON")
        header_length = request.headers.get("content-length")
        if header_length is not None:
            try:
                length = int(header_length)
            except ValueError as error:
                raise HTTPException(400, "invalid body size") from error
            if length < 2 or length > 4096:
                raise HTTPException(400, "invalid body size")
        try:
            body = await read_limited(request, 4096)
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

    def device_identity(request: Request) -> tuple[str, str]:
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "device unauthorized")
        try:
            return platform.windows.authorize(authorization[7:])
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "version": VERSION}

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
        return RedirectResponse("/dashboard" if web_session(request) else "/login", status_code=303)

    @app.get("/login")
    def login_page(request: Request):
        if web_session(request): return RedirectResponse("/dashboard", status_code=303)
        return page(request, "login", None, error=False)

    @app.post("/login")
    async def login(request: Request):
        address = request.client.host if request.client else "unknown"
        if limiter.blocked(address):
            return page(request, "login", None, error=True, status=429)
        form = await parse_form(request)
        username, password = form.get("username", ""), form.get("password", "")
        with platform.sessions() as db:
            owner = db.scalar(select(User).where(User.username == username, User.revoked_at.is_(None)))
            valid = verify_password(password, owner.password_hash if owner else settings.admin_password_hash)
            if not owner or not valid:
                limiter.fail(address)
                platform.record(ADMIN_ID, "login_failed")
                return page(request, "login", None, error=True, status=401)
            token, csrf = create_session(db, owner)
        limiter.clear(address)
        platform.record(owner.id, "login")
        response = RedirectResponse("/dashboard", status_code=303)
        response.set_cookie("lp_session", token, max_age=SESSION_SECONDS, secure=True, httponly=True, samesite="strict")
        response.set_cookie("lp_csrf", csrf, max_age=SESSION_SECONDS, secure=True, httponly=True, samesite="strict")
        return response

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
        return page(request, "enroll", session, code=None)

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
        platform.record(session.owner_id, "device_renamed", device_id)
        return RedirectResponse("/devices", status_code=303)

    @app.get("/gateways")
    def gateways_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return page(request, "gateways", session, devices=platform.devices(session.owner_id), presence=platform.presence(),
                    gateway_id=platform.gateway_id, windows_id=platform.windows_id)

    @app.get("/clients")
    def clients_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return page(request, "clients", session, clients=platform.clients(session.owner_id))

    @app.get("/activity")
    def activity_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return page(request, "activity", session, events=platform.audit(session.owner_id),
                    commands=platform.recent_commands(session.owner_id))

    @app.get("/settings")
    def settings_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return page(request, "settings", session)

    @app.get("/system")
    def system_page(request: Request):
        session, redirect = browser_guard(request)
        if redirect: return redirect
        return page(request, "system", session, presence=platform.presence())

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
        _owner_id, device_id = device_identity(request)
        payload = await json_body(request)
        try:
            platform.windows.heartbeat(device_id, payload)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except PermissionError as error:
            raise HTTPException(401, str(error)) from error
        return {"ok": True}

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
        session = web_session(request)
        if session is None: raise HTTPException(401, "unauthorized")
        return [platform.device_status(session.owner_id, device.id) for device in platform.devices(session.owner_id)]

    @app.get("/api/v2/devices/{device_id}")
    def api_device(request: Request, device_id: str):
        session = web_session(request)
        if session is None: raise HTTPException(401, "unauthorized")
        try:
            return platform.device_status(session.owner_id, device_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from error

    @app.post("/api/v2/devices/{device_id}/commands")
    async def api_command(request: Request, device_id: str):
        session = web_session(request)
        if session is None: raise HTTPException(401, "unauthorized")
        token = request.headers.get("x-csrf-token", "")
        require_csrf(request, session, {"csrf": token})
        payload = await json_body(request)
        if set(payload) != {"action"} or not isinstance(payload["action"], str):
            raise HTTPException(400, "invalid command request")
        try:
            return await run_in_threadpool(platform.issue_command, session.owner_id, device_id, payload["action"])
        except (ValueError, ConnectionError, BlockingIOError) as error:
            raise relay_error(error) from error

    @app.get("/api/v2/commands/{command_id}")
    def api_command_result(request: Request, command_id: str):
        session = web_session(request)
        if session is None: raise HTTPException(401, "unauthorized")
        try:
            return platform.windows.command_result(session.owner_id, command_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from error

    return app
