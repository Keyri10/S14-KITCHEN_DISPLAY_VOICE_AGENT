"""Broadcast kitchen events to connected /ws/kitchen clients."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket

_clients: set[WebSocket] = set()


def add_client(ws: WebSocket) -> None:
    _clients.add(ws)


def remove_client(ws: WebSocket) -> None:
    _clients.discard(ws)


async def broadcast(event: dict[str, Any]) -> None:
    dead: list[WebSocket] = []
    for ws in list(_clients):
        try:
            await ws.send_json(event)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.discard(ws)


async def notify_new_order(order: dict[str, Any]) -> None:
    await broadcast({"type": "order_new", "order": order})


async def notify_order_updated(order: dict[str, Any]) -> None:
    await broadcast({"type": "order_updated", "order": order})
