"""LAN-only Windows power controller.

The HTTP API is intentionally small: an authenticated status endpoint and four
power actions. Wake-on-LAN is sent by the iPhone while this process is offline.
"""

from __future__ import annotations

import argparse
import ctypes
import hmac
import html
import io
import ipaddress
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


APP_NAME = "LanPower"
DEFAULT_PORT = 48211
ACTIONS = {"sleep", "hibernate", "restart", "shutdown"}
STATIC_DIR = Path(__file__).resolve().parent / "static"
MIME_TYPES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    token = config.get("token", "")
    if not isinstance(token, str) or len(token) != 64:
        raise ValueError("config token must be 64 hexadecimal characters")
    try:
        bytes.fromhex(token)
    except ValueError as exc:
        raise ValueError("config token must be hexadecimal") from exc
    networks = config.get("allowed_networks", [])
    if not isinstance(networks, list) or not networks:
        raise ValueError("allowed_networks must contain at least one subnet")
    config["allowed_networks"] = [ipaddress.ip_network(item, strict=False) for item in networks]
    port = config.get("port", DEFAULT_PORT)
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("invalid port")
    config["port"] = port
    host_ip = config.get("host_ip", "")
    if not isinstance(host_ip, str) or ipaddress.ip_address(host_ip) not in config["allowed_networks"][0]:
        raise ValueError("host_ip must belong to the first allowed subnet")
    return config


def run_power_action(action: str, dry_run: bool = False) -> None:
    if action not in ACTIONS:
        raise ValueError("unknown power action")
    if dry_run:
        logging.info("DRY RUN power action: %s", action)
        return
    if os.name != "nt":
        raise RuntimeError("power actions require Windows")
    if action == "sleep":
        power_profile = ctypes.WinDLL("PowrProf.dll", use_last_error=True)
        power_profile.SetSuspendState.argtypes = (ctypes.c_bool, ctypes.c_bool, ctypes.c_bool)
        power_profile.SetSuspendState.restype = ctypes.c_bool
        if not power_profile.SetSuspendState(False, False, False):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    shutdown_exe = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "shutdown.exe"
    arguments = {
        "hibernate": ["/h"],
        "restart": ["/r", "/t", "0"],
        "shutdown": ["/s", "/t", "0"],
    }[action]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([str(shutdown_exe), *arguments], creationflags=creationflags)


class PowerServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, config: dict, *, dry_run: bool = False):
        super().__init__(address, PowerHandler)
        self.config = config
        self.dry_run = dry_run
        self.action_lock = threading.Lock()
        self.last_action_at = 0.0


class PowerHandler(BaseHTTPRequestHandler):
    server: PowerServer

    def log_message(self, format_string, *args):
        # Do not log request headers, URL fragments, or the access token.
        logging.info("%s %s", self.client_address[0], format_string % args)

    def _allowed_client(self) -> bool:
        client = ipaddress.ip_address(self.client_address[0])
        return client.is_loopback or any(client in network for network in self.server.config["allowed_networks"])

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        presented = header[len("Bearer "):]
        return hmac.compare_digest(presented, self.server.config["token"])

    def _send(self, status: int, body: bytes, content_type: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; base-uri 'none'; form-action 'none'",
        )
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _path(self) -> str:
        return urlsplit(self.path).path

    def do_GET(self) -> None:
        if not self._allowed_client():
            self._json(HTTPStatus.FORBIDDEN, {"error": "local network only"})
            return
        path = self._path()
        if path == "/api/status":
            if not self._authorized():
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not paired"})
                return
            self._json(HTTPStatus.OK, {"ok": True, "device": platform.node(), "state": "online"})
            return
        if path in ("/setup", "/setup/qr.svg"):
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                self._json(HTTPStatus.FORBIDDEN, {"error": "open setup on the PC"})
                return
            self._serve_setup(path)
            return
        item = MIME_TYPES.get(path)
        if item is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        filename, content_type = item
        try:
            body = (STATIC_DIR / filename).read_bytes()
        except OSError:
            logging.exception("Static asset missing: %s", filename)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "asset missing"})
            return
        self._send(HTTPStatus.OK, body, content_type)

    def _serve_setup(self, path: str) -> None:
        config = self.server.config
        url = f"http://{config['host_ip']}:{config['port']}/#access={config['token']}"
        if path == "/setup/qr.svg":
            try:
                import qrcode
                from qrcode.image.svg import SvgImage

                qr = qrcode.make(url, image_factory=SvgImage, border=2, box_size=8)
                buffer = io.BytesIO()
                qr.save(buffer)
                self._send(HTTPStatus.OK, buffer.getvalue(), "image/svg+xml")
            except ImportError:
                self._json(HTTPStatus.NOT_IMPLEMENTED, {"error": "QR library unavailable"})
            return
        display_url = html.escape(url)
        qr_markup = '<img src="/setup/qr.svg" alt="手机配对二维码" class="qr">'
        body = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LanPower 配对</title>
<link rel="stylesheet" href="/app.css"></head><body><main class="setup">
<div class="setup-card"><p class="eyebrow">仅在这台电脑上显示</p><h1>用 iPhone 扫码配对</h1>
<p>iPhone 连接家中 Wi-Fi，在“电脑电源”微信小程序里点“扫描配对二维码”。配对信息只保存在你的手机微信中。</p>
{qr_markup}<p class="small">网页备用控制页需要配对时，也可以将下方链接复制到手机 Safari：</p>
<code class="pair-url">{display_url}</code><p class="small">请勿把配对链接发给其他人。</p></div>
</main></body></html>"""
        self._send(HTTPStatus.OK, body.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self) -> None:
        if not self._allowed_client():
            self._json(HTTPStatus.FORBIDDEN, {"error": "local network only"})
            return
        if self._path() != "/api/power":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "not paired"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 1 or length > 512:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid body size"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return
        action = payload.get("action") if isinstance(payload, dict) else None
        if action not in ACTIONS:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "unknown action"})
            return
        with self.server.action_lock:
            now = time.monotonic()
            if now - self.server.last_action_at < 15:
                self._json(HTTPStatus.CONFLICT, {"error": "wait before sending another command"})
                return
            self.server.last_action_at = now
        self._json(HTTPStatus.ACCEPTED, {"ok": True, "action": action})

        def execute() -> None:
            try:
                logging.info("Executing power action: %s", action)
                run_power_action(action, self.server.dry_run)
            except Exception:
                logging.exception("Power action failed: %s", action)

        timer = threading.Timer(1.25, execute)
        timer.daemon = True
        timer.start()


def configure_logging(config_path: Path) -> None:
    log_path = config_path.parent / "lanpower.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[RotatingFileHandler(log_path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")],
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="LAN-only Windows power controller")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true", help="acknowledge actions without changing power state")
    args = parser.parse_args()
    config = load_config(args.config)
    configure_logging(args.config)
    with PowerServer(("0.0.0.0", config["port"]), config, dry_run=args.dry_run) as server:
        logging.info("Listening on port %s for %s", config["port"], config["allowed_networks"])
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
