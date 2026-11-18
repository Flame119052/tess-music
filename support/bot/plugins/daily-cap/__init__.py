"""Hard daily reply and token budget for the Tess support bot.

Hermes has no built-in daily reply/token cap (only a per-run wall clock), so this plugin checks and increments a
shared daily cap plus a smaller per-person cap inside ``pre_llm_call`` before any model inference runs.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger(__name__)

DEFAULT_DAILY_REPLY_CAP = 40
DEFAULT_DAILY_USER_CAP = 20
DEFAULT_DAILY_TOKEN_CAP = 0

_GLOBAL_LIMIT_MSG = (
    "I've reached today's reply limit, so I have to pause until tomorrow. "
    "It resets at 00:00 UTC."
)
_USER_LIMIT_MSG = (
    "You've reached today's message limit for this bot, so I have to pause until tomorrow. "
    "It resets at 00:00 UTC."
)
_TOKEN_LIMIT_MSG = (
    "I've reached today's usage limit, so I have to pause until tomorrow. "
    "It resets at 00:00 UTC."
)
_FAIL_CLOSED_MSG = (
    "I'm paused right now because my daily usage check couldn't be read. "
    "Please try again tomorrow or ask Krish to check the bot."
)


def _profile_dir() -> Path:
    # This file lives at <profile>/plugins/daily-cap/__init__.py.
    return Path(__file__).resolve().parents[2]


def _state_path() -> Path:
    override = os.environ.get("TESS_DAILY_CAP_FILE", "").strip()
    if override:
        return Path(override)
    return _profile_dir() / "cache" / "daily-cap.json"


def _int_env(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("daily-cap: ignoring invalid integer for %s=%r; using default %d", name, raw, default)
        return default
    if value < minimum:
        logger.warning("daily-cap: %s=%d below %d; using default %d", name, value, minimum, default)
        return default
    return value


def _today_utc() -> str:
    override = os.environ.get("TESS_CAP_TODAY", "").strip()
    if override:
        return override
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _fresh_state(today: str) -> dict[str, Any]:
    return {"date": today, "replies": 0, "tokens": 0, "users": {}}


def _validate_state(data: Any, today: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("daily-cap state must be a JSON object")
    date = data.get("date")
    if not isinstance(date, str) or not date:
        raise ValueError("daily-cap state missing date")
    if date != today:
        return _fresh_state(today)
    replies = data.get("replies", 0)
    tokens = data.get("tokens", 0)
    users_raw = data.get("users", {})
    if (
        isinstance(replies, bool)
        or not isinstance(replies, int)
        or replies < 0
        or isinstance(tokens, bool)
        or not isinstance(tokens, int)
        or tokens < 0
        or not isinstance(users_raw, dict)
    ):
        raise ValueError("daily-cap state has invalid counters")
    users: dict[str, int] = {}
    for k, v in users_raw.items():
        if not isinstance(k, str) or isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise ValueError("daily-cap state has invalid user counter")
        users[k] = v
    return {"date": date, "replies": replies, "tokens": tokens, "users": users}


@contextmanager
def _locked_state(state_path: Path) -> Iterator[None]:
    parent = state_path.parent
    if parent.is_symlink():
        raise OSError(f"refusing symlinked cache directory: {parent}")
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state_path.is_symlink():
        raise OSError(f"refusing symlinked cap state file: {state_path}")
    lock_path = state_path.with_suffix(".lock")
    if lock_path.is_symlink():
        raise OSError(f"refusing symlinked cap lock file: {lock_path}")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _load_state(state_path: Path, today: str) -> dict[str, Any]:
    if not state_path.exists():
        return _fresh_state(today)
    if state_path.is_symlink() or not state_path.is_file():
        raise OSError(f"refusing non-regular cap state file: {state_path}")
    raw = state_path.read_text(encoding="utf-8")
    return _validate_state(json.loads(raw), today)


def _write_state(state_path: Path, state: dict[str, Any]) -> None:
    parent = state_path.parent
    fd, tmp_name = tempfile.mkstemp(prefix=".daily-cap-", suffix=".tmp", dir=str(parent))
    try:
        os.chmod(tmp_name, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, state_path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def pre_llm_call(sender_id: str = "", **kwargs: Any) -> dict[str, str] | None:
    """Block a turn before any LLM call once today's global or per-person cap is hit."""
    global_cap = _int_env("TESS_DAILY_REPLY_CAP", DEFAULT_DAILY_REPLY_CAP, minimum=0)
    user_cap = _int_env("TESS_DAILY_USER_CAP", DEFAULT_DAILY_USER_CAP, minimum=0)
    token_cap = _int_env("TESS_DAILY_TOKEN_CAP", DEFAULT_DAILY_TOKEN_CAP, minimum=0)
    uid = str(sender_id or "").strip() or "unknown"
    today = _today_utc()
    state_path = _state_path()

    try:
        with _locked_state(state_path):
            state = _load_state(state_path, today)
            if token_cap > 0 and state["tokens"] >= token_cap:
                return {"action": "block", "message": _TOKEN_LIMIT_MSG}
            if state["replies"] >= global_cap:
                return {"action": "block", "message": _GLOBAL_LIMIT_MSG}
            user_replies = state["users"].get(uid, 0)
            if user_replies >= user_cap:
                return {"action": "block", "message": _USER_LIMIT_MSG}

            state["replies"] += 1
            state["users"][uid] = user_replies + 1
            _write_state(state_path, state)
            return None
    except Exception as exc:
        logger.warning("daily-cap failed closed in pre_llm_call: %s", exc)
        return {"action": "block", "message": _FAIL_CLOSED_MSG}


def _extract_tokens(usage: Any) -> int:
    if not isinstance(usage, dict):
        return 0
    total = usage.get("total_tokens")
    if isinstance(total, int) and not isinstance(total, bool) and total > 0:
        return total
    inp = usage.get("input_tokens")
    if not isinstance(inp, int) or isinstance(inp, bool):
        inp = usage.get("prompt_tokens")
    out = usage.get("output_tokens")
    if not isinstance(out, int) or isinstance(out, bool):
        out = usage.get("completion_tokens")
    in_n = inp if isinstance(inp, int) and not isinstance(inp, bool) and inp > 0 else 0
    out_n = out if isinstance(out, int) and not isinstance(out, bool) and out > 0 else 0
    return in_n + out_n


def post_api_request(usage: Any = None, **kwargs: Any) -> None:
    """Record reported API token usage for optional daily token budgeting."""
    delta = _extract_tokens(usage)
    if delta <= 0:
        return
    today = _today_utc()
    state_path = _state_path()
    try:
        with _locked_state(state_path):
            state = _load_state(state_path, today)
            state["tokens"] = int(state.get("tokens", 0)) + delta
            _write_state(state_path, state)
    except Exception as exc:
        logger.warning("daily-cap failed to record token usage: %s", exc)


def register(ctx: Any) -> None:
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_api_request", post_api_request)
