import secrets
import string
from typing import TYPE_CHECKING

from sqlmodel import select

if TYPE_CHECKING:
    from sqlmodel import Session

_ALPHABET = string.digits + "abcdefghijklmnopqrstuvwxyz"
_MAX_ATTEMPTS = 16


def generate_short_id(length: int = 4) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def generate_unique_short_id(session: "Session", board_id: int, length: int = 4) -> str:
    """Generate a short_id unique within a board. Retries on collision."""
    from flowboard.db.models import Node

    for _ in range(_MAX_ATTEMPTS):
        candidate = generate_short_id(length)
        existing = session.exec(
            select(Node).where(Node.board_id == board_id, Node.short_id == candidate)
        ).first()
        if existing is None:
            return candidate
    raise RuntimeError(
        f"short_id space exhausted after {_MAX_ATTEMPTS} attempts for board {board_id}"
    )
