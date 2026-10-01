"""Browser management for scheduled power operations and offline alerts."""
from __future__ import annotations

import re
import time
import uuid

from fastapi import HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from cloud_app.app.auth import parse_form, require_csrf
from cloud_app.app.models import AuditLog, Device, NotificationConfig, ScheduledTask
from cloud_app.app.scheduled import POWER_ACTIONS, WEEKDAYS, next_run


def integer(form, key, lower, upper, default=None):
    try:
        value = int(form.get(key, default))
    except (ValueError, TypeError):
        raise HTTPException(400, "请填写有效的时间参数") from None
    if not lower <= value <= upper:
        raise HTTPException(400, "时间参数超出允许范围")
    return value


def record(db, owner_id, event, device_id):
    db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event=event,
                    target_device_id=device_id, created_at=int(time.time())))


def owned_device(db, owner_id, device_id, *, windows=False):
    device = db.scalar(select(Device).where(Device.id == device_id, Device.owner_id == owner_id,
                                             Device.revoked_at.is_(None)))
    if device is None or (windows and device.device_type != "windows"):
        raise HTTPException(404, "设备不可用")
    return device


def owned_row(db, model, owner_id, row_id):
    row = db.scalar(select(model).where(model.id == row_id, model.owner_id == owner_id))
    if row is None:
        raise HTTPException(404, "配置不存在")
    return row


def register_automation_routes(app, platform, session_owner, browser_guard, page):
    @app.get("/schedules")
    def schedules(request: Request):
        session, redirect = browser_guard(request)
        if redirect:
            return redirect
        with platform.sessions() as db:
            tasks = db.execute(select(ScheduledTask, Device.name.label("device_name"), Device.revoked_at)
                .join(Device, Device.id == ScheduledTask.device_id)
                .where(ScheduledTask.owner_id == session.owner_id, Device.owner_id == session.owner_id)
                .order_by(ScheduledTask.next_run_at, ScheduledTask.id)).all()
        return page(request, "schedules", session, tasks=tasks, weekdays=WEEKDAYS,
                    devices=[device for device in platform.devices(session.owner_id) if device.device_type == "windows"])

    @app.post("/schedules")
    async def create_schedule(request: Request):
        session = session_owner(request)
        form = await parse_form(request)
        require_csrf(request, session, form)
        action = form.get("action", "")
        if action not in POWER_ACTIONS:
            raise HTTPException(400, "请选择有效的电源操作")
        hour, minute, weekday = (integer(form, "hour", 0, 23), integer(form, "minute", 0, 59),
                                 integer(form, "weekday", -1, 6, "-1"))
        label = form.get("label", "").strip()
        if len(label) > 100:
            raise HTTPException(400, "备注最多 100 个字")
        now = int(time.time())
        with platform.sessions.begin() as db:
            device = owned_device(db, session.owner_id, form.get("device_id", ""), windows=True)
            db.add(ScheduledTask(id=str(uuid.uuid4()), owner_id=session.owner_id, device_id=device.id,
                action=action, hour=hour, minute=minute, weekday=weekday, enabled=True, label=label,
                created_at=now, next_run_at=next_run(hour, minute, weekday, now)))
            record(db, session.owner_id, "schedule_created", device.id)
        return RedirectResponse("/schedules", status_code=303)

    @app.post("/schedules/{task_id}/toggle")
    async def toggle_schedule(request: Request, task_id: str):
        session = session_owner(request)
        require_csrf(request, session, await parse_form(request))
        with platform.sessions.begin() as db:
            task = owned_row(db, ScheduledTask, session.owner_id, task_id)
            if not task.enabled:
                owned_device(db, session.owner_id, task.device_id, windows=True)
            task.enabled = not task.enabled
            task.next_run_at = next_run(task.hour, task.minute, task.weekday, int(time.time()))
            record(db, session.owner_id, "schedule_toggled", task.device_id)
        return RedirectResponse("/schedules", status_code=303)

    @app.post("/schedules/{task_id}/delete")
    async def delete_schedule(request: Request, task_id: str):
        session = session_owner(request)
        require_csrf(request, session, await parse_form(request))
        with platform.sessions.begin() as db:
            task = owned_row(db, ScheduledTask, session.owner_id, task_id)
            record(db, session.owner_id, "schedule_deleted", task.device_id)
            db.delete(task)
        return RedirectResponse("/schedules", status_code=303)

    @app.post("/settings/notifications")
    async def save_notification(request: Request):
        session = session_owner(request)
        form = await parse_form(request)
        require_csrf(request, session, form)
        openid, template_id = form.get("openid", "").strip(), form.get("template_id", "").strip()
        if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) for value in (openid, template_id)):
            raise HTTPException(400, "请填写有效的微信 openid 和模板 ID")
        threshold = integer(form, "offline_minutes", 1, 10080, "5")
        with platform.sessions.begin() as db:
            device = owned_device(db, session.owner_id, form.get("device_id", ""))
            row = db.scalar(select(NotificationConfig).where(NotificationConfig.owner_id == session.owner_id,
                NotificationConfig.device_id == device.id, NotificationConfig.openid == openid,
                NotificationConfig.template_id == template_id))
            if row is None:
                row = NotificationConfig(id=str(uuid.uuid4()), owner_id=session.owner_id, device_id=device.id,
                    openid=openid, template_id=template_id)
                db.add(row)
            row.offline_minutes, row.enabled = threshold, form.get("enabled") == "on"
            record(db, session.owner_id, "notification_saved", device.id)
        return RedirectResponse("/settings#notifications", status_code=303)

    @app.post("/settings/notifications/{config_id}/toggle")
    async def toggle_notification(request: Request, config_id: str):
        session = session_owner(request)
        require_csrf(request, session, await parse_form(request))
        with platform.sessions.begin() as db:
            row = owned_row(db, NotificationConfig, session.owner_id, config_id)
            if not row.enabled:
                owned_device(db, session.owner_id, row.device_id)
            row.enabled = not row.enabled
            record(db, session.owner_id, "notification_toggled", row.device_id)
        return RedirectResponse("/settings#notifications", status_code=303)

    @app.post("/settings/notifications/{config_id}/delete")
    async def delete_notification(request: Request, config_id: str):
        session = session_owner(request)
        require_csrf(request, session, await parse_form(request))
        with platform.sessions.begin() as db:
            row = owned_row(db, NotificationConfig, session.owner_id, config_id)
            record(db, session.owner_id, "notification_deleted", row.device_id)
            db.delete(row)
        return RedirectResponse("/settings#notifications", status_code=303)
