"""Minute scheduler; database claims prevent duplicate runs across workers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
import threading
import time

from sqlalchemy import select, update

from cloud_app.app.models import Device, ScheduledTask, User

logger = logging.getLogger(__name__)
SCHEDULE_ZONE = timezone(timedelta(hours=8), "Asia/Shanghai")
POWER_ACTIONS = frozenset({"sleep", "hibernate", "restart", "shutdown", "wake"})
WEEKDAYS = ("周日", "周一", "周二", "周三", "周四", "周五", "周六")


def next_run(hour: int, minute: int, weekday: int, now: int) -> int:
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and -1 <= weekday <= 6):
        raise ValueError("执行时间无效")
    current = datetime.fromtimestamp(now, SCHEDULE_ZONE)
    candidate = current.replace(hour=hour, minute=minute, second=0, microsecond=0)
    for offset in range(8):
        day = candidate + timedelta(days=offset)
        if day > current and (weekday == -1 or (day.weekday() + 1) % 7 == weekday):
            return int(day.timestamp())
    raise ValueError("无法计算下次执行时间")


def schedule_description(task: ScheduledTask) -> str:
    return f"{'每天' if task.weekday == -1 else '每' + WEEKDAYS[task.weekday]} {task.hour:02d}:{task.minute:02d}"


class Scheduler:
    def __init__(self, platform, notifier=None):
        self.platform = platform
        self.notifier = notifier
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="lanpower-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                logger.exception("计划任务扫描失败")
            self._stop.wait(60)

    def tick(self, now: int | None = None) -> None:
        now = int(time.time()) if now is None else now
        with self.platform.sessions() as db:
            tasks = list(db.scalars(select(ScheduledTask).join(Device, Device.id == ScheduledTask.device_id)
                .join(User, User.id == ScheduledTask.owner_id).where(
                    ScheduledTask.enabled.is_(True), ScheduledTask.next_run_at <= now,
                    Device.owner_id == ScheduledTask.owner_id, Device.revoked_at.is_(None),
                    Device.device_type == "windows", User.revoked_at.is_(None))
                .order_by(ScheduledTask.next_run_at, ScheduledTask.id)))
        for task in tasks:
            if self._stop.is_set():
                break
            try:
                # Claim before dispatch. On a process crash we skip this occurrence,
                # rather than replaying a potentially completed power operation.
                with self.platform.sessions.begin() as db:
                    claimed = db.execute(update(ScheduledTask).where(
                        ScheduledTask.id == task.id, ScheduledTask.enabled.is_(True),
                        ScheduledTask.next_run_at == task.next_run_at,
                        ScheduledTask.owner_id.in_(select(User.id).where(User.revoked_at.is_(None))),
                        ScheduledTask.device_id.in_(select(Device.id).where(
                            Device.owner_id == task.owner_id, Device.revoked_at.is_(None)))).values(
                            last_run_at=now, next_run_at=next_run(task.hour, task.minute, task.weekday, now)))
                if claimed.rowcount != 1:
                    continue
                result = self.platform.issue_command(task.owner_id, task.device_id, task.action)
                if not (result.get("ok") or result.get("accepted")):
                    raise ConnectionError("scheduled command was rejected")
                self.platform.record(task.owner_id, "schedule_fired", task.device_id, result.get("route"))
            except Exception:
                logger.exception("计划任务执行失败：%s", task.id)
                try:
                    self.platform.record(task.owner_id, "schedule_failed", task.device_id)
                except Exception:
                    logger.exception("无法记录计划任务失败")
        if self.notifier is not None and not self._stop.is_set():
            self.notifier.check(now, self._stop)
