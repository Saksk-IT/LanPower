"""Source checks for password-authenticated native account endpoints."""

import re

from fastapi import HTTPException, Request

from cloud_app.app.settings import Settings


def require_native_origin(request: Request, settings: Settings) -> None:
    origin = request.headers.get("origin")
    cross_site = request.headers.get("sec-fetch-site") == "cross-site"
    # WeChat DevTools removes Origin and cookies from wx.request, while its
    # Chromium transport still labels 127.0.0.1 -> localhost as cross-site.
    # Accept that exact SDK shape only at explicitly configured local HTTP
    # origins. The native endpoint still verifies the password/connection key.
    wechat_local_http = (
        settings.allow_local_http
        and request.url.scheme == "http"
        and f"http://{request.url.netloc}" in settings.browser_origins
        and origin is None
        and not request.headers.get("cookie")
        and request.headers.get("sec-fetch-mode") == "cors"
        and request.headers.get("sec-fetch-dest") == "empty"
        and request.headers.get("content-type", "").split(";", 1)[0].strip().lower() == "application/json"
        and re.fullmatch(r"https://servicewechat\.com/(?:wx[0-9a-f]{16}|touristappid)/devtools/page-frame\.html",
                         request.headers.get("referer", "")) is not None
    )
    if (origin is not None and origin not in settings.browser_origins) or (cross_site and not wechat_local_http):
        raise HTTPException(403, "请求来源不可用")
