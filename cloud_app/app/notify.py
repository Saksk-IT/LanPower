"""WeChat subscription notifications. Credentials never enter pages or logs."""
from __future__ import annotations

from datetime import datetime
import json
import logging
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from sqlalchemy import or_, select, update

from cloud_app.app.models import Device, NotificationConfig, User
from cloud_app.app.scheduled import SCHEDULE_ZONE

logger = logging.getLogger(__name__)


def wechat_request(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = Request(url, data=data, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=10) as response:
        body = response.read(65537)
    if len(body) > 65536:
        raise ValueError("WeChat response too large")
    result = json.loads(body)
    if not isinstance(result, dict):
        raise ValueError("invalid WeChat response")
    return result


class Notifier:
    def __init__(self, platform):
        self.platform = platform
        self.settings = platform.settings
        self.enabled = bool(self.settings.wx_app_id and self.settings.wx_app_secret)
        self._token = ""
        self._expires_at = 0.0
        self._lock = threading.Lock()

    def access_token(self) -> str:
        with self._lock:
            if self._token and time.monotonic() < self._expires_at:
                return self._token
            query = urlencode({"grant_type": "client_credential", "appid": self.settings.wx_app_id,
                               "secret": self.settings.wx_app_secret})
            response = wechat_request("https://api.weixin.qq.com/cgi-bin/token?" + query)
            token = response.get("access_token")
            if response.get("errcode") or not isinstance(token, str) or not token:
                raise ValueError("WeChat token unavailable")
            lifetime = min(7000, max(1, int(response.get("expires_in", 7200)) - 120))
            self._token, self._expires_at = token, time.monotonic() + lifetime
            return token

    def send(self, config: NotificationConfig, device: Device, offline_since: int) -> None:
        payload = {"touser": config.openid, "template_id": config.template_id,
                   "page": "pages/cloud/cloud", "data": {
                       "thing1": {"value": device.name[:20]},
                       "time2": {"value": datetime.fromtimestamp(offline_since, SCHEDULE_ZONE).strftime("%Y-%m-%d %H:%M")}}}
        for attempt in range(2):
            query = urlencode({"access_token": self.access_token()})
            response = wechat_request("https://api.weixin.qq.com/cgi-bin/message/subscribe/send?" + query, payload)
            code = response.get("errcode")
            if code == 0:
                return
            if attempt == 0 and code in (40001, 40014, 42001):
                with self._lock:
                    self._token, self._expires_at = "", 0
                continue
            raise ValueError("WeChat subscription delivery failed")

    def check(self, now: int, stop: threading.Event) -> None:
        if not self.enabled:
            return
        with self.platform.sessions() as db:
            rows = db.execute(select(NotificationConfig, Device)
                .join(Device, NotificationConfig.device_id == Device.id)
                .join(User, NotificationConfig.owner_id == User.id).where(
                    NotificationConfig.enabled.is_(True), Device.revoked_at.is_(None),
                    Device.owner_id == NotificationConfig.owner_id, User.revoked_at.is_(None),
                    or_(NotificationConfig.last_sent_at.is_(None), NotificationConfig.last_sent_at <= now - 3600))).all()
        for config, device in rows:
            if stop.is_set():
                break
            since = device.last_seen_at if device.last_seen_at is not None else device.created_at
            if now - since < config.offline_minutes * 60:
                continue
            claimed = False
            try:
                if self.platform.device_status(config.owner_id, device.id)["state"] == "online":
                    continue
                with self.platform.sessions.begin() as db:
                    result = db.execute(update(NotificationConfig).where(
                        NotificationConfig.id == config.id, NotificationConfig.enabled.is_(True),
                        NotificationConfig.last_sent_at == config.last_sent_at).values(last_sent_at=now))
                claimed = result.rowcount == 1
                if not claimed:
                    continue
                self.send(config, device, since)
            except Exception as error:
                # HTTP errors can contain credential-bearing URLs; never log them.
                logger.warning("离线通知发送失败：%s (%s)", config.id, type(error).__name__)
                if claimed:
                    try:
                        with self.platform.sessions.begin() as db:
                            db.execute(update(NotificationConfig).where(
                                NotificationConfig.id == config.id, NotificationConfig.last_sent_at == now
                            ).values(last_sent_at=config.last_sent_at))
                    except Exception:
                        logger.warning("无法恢复离线通知重试时间：%s", config.id)
