"""SSE streams release every database session before waiting for clients."""
from __future__ import annotations

import asyncio
import json

from starlette.concurrency import run_in_threadpool


async def device_events(request, snapshot, authorized, *, interval: float = 5):
    previous = None
    while not await request.is_disconnected():
        if not await run_in_threadpool(authorized):
            return
        current = await run_in_threadpool(snapshot)
        serialized = json.dumps(current, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if serialized != previous:
            yield f"event: devices\ndata: {serialized}\n\n"
            previous = serialized
        else:
            yield ": keep-alive\n\n"
        await asyncio.sleep(interval)
