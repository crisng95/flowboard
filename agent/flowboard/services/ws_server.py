"""Standalone WebSocket server on :9222 for the Chrome extension bridge.

Kept separate from the FastAPI :8100 app to match flowkit's pattern — the
extension's `background.js` connects to `ws://127.0.0.1:9222` only.
"""
from __future__ import annotations

import asyncio
import json
import logging

import websockets

from flowboard.config import EXTENSION_WS_PORT, WS_HOST
from flowboard.services.flow_client import flow_client

logger = logging.getLogger(__name__)


async def _handler(websocket) -> None:
    flow_client.set_extension(websocket)
    logger.info("extension connected from %s", getattr(websocket, "remote_address", "?"))

    # Hand the extension the secret it needs to authenticate HTTP callbacks.
    try:
        await websocket.send(
            json.dumps({"type": "callback_secret", "secret": flow_client.callback_secret})
        )
    except Exception:  # noqa: BLE001
        logger.exception("failed to send callback_secret")

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("invalid JSON from extension")
                continue
            try:
                await flow_client.handle_message(data)
            except Exception:  # noqa: BLE001
                logger.exception("error handling extension message")
    except websockets.ConnectionClosed:
        pass
    finally:
        flow_client.clear_extension()
        logger.info("extension disconnected")


async def run_ws_server() -> None:
    async with websockets.serve(_handler, WS_HOST, EXTENSION_WS_PORT):
        logger.info("WebSocket server listening on ws://%s:%d", WS_HOST, EXTENSION_WS_PORT)
        await asyncio.Future()  # run forever
