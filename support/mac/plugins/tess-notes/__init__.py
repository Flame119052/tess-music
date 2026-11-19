"""Write one visit note into the current session folder.

Hermes loads this from the profile directory (``$HERMES_HOME/plugins/tess-notes`` once the
profile is running). The model calls ``tess_save_note``. It cannot pass a path.
"""

import json
import os
from pathlib import Path

NAMES = {
    "words": "words.txt",
    "title": "title.txt",
    "summary": "summary.txt",
    "doctor": "doctor.txt",
}
MAX_BYTES = 64 * 1024


def profile_home(home=None):
    raw = home if home is not None else os.environ.get("HERMES_HOME", "")
    raw = str(raw or "").strip()
    if not raw:
        raise ValueError("HERMES_HOME is not set")
    path = Path(raw).expanduser().resolve()
    if not path.is_dir():
        raise ValueError("HERMES_HOME is not a directory")
    return path


def current_session(home=None):
    """The newest real session directory. A link, or a folder outside the session root, is skipped."""
    root = profile_home(home) / "cache" / "support" / "sessions"
    try:
        real_root = root.resolve()
    except OSError as exc:
        raise ValueError("there is no session folder yet") from exc
    if not real_root.is_dir():
        raise ValueError("there is no session folder yet")
    found = []
    for child in real_root.iterdir():
        if child.is_symlink() or not child.is_dir():
            continue
        real = child.resolve()
        if real.parent != real_root:
            continue
        marker = real / "session.json"
        if marker.is_symlink() or not marker.is_file():
            continue
        found.append(real)
    if not found:
        raise ValueError("there is no session folder yet")
    return max(found, key=lambda path: path.stat().st_mtime)


def save_note(kind, text, home=None):
    if kind not in NAMES:
        raise ValueError("kind must be words, title, summary or doctor")
    if not isinstance(text, str) or text == "":
        raise ValueError("text must be the note itself")
    raw = text.encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise ValueError(f"that note is {len(raw)} bytes; the limit is {MAX_BYTES}")
    session = current_session(home)
    dest = session / NAMES[kind]
    if dest.is_symlink():
        raise ValueError("refusing to follow a link")
    if dest.resolve().parent != session:
        raise ValueError("refusing a path outside the session folder")
    dest.write_bytes(raw)
    return {"ok": True, "file": NAMES[kind]}


def register(ctx):
    schema = {
        "name": "tess_save_note",
        "description": (
            "Save what the person typed, a plain title, or a short summary into this visit's "
            "session folder. kind is words, title, summary or doctor. It writes only that one "
            "file, only inside the current session, and it refuses any other name or path."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["words", "title", "summary", "doctor"],
                    "description": "Which note: words, title, summary or doctor.",
                },
                "text": {
                    "type": "string",
                    "description": "The note as plain text. Not a path.",
                },
            },
            "required": ["kind", "text"],
        },
    }

    def handle(params, **kwargs):
        del kwargs
        try:
            if not isinstance(params, dict):
                raise ValueError("kind and text are required")
            result = save_note(params.get("kind"), params.get("text"))
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc)})
        return json.dumps(result)

    ctx.register_tool(
        name="tess_save_note",
        toolset="tess_support",
        schema=schema,
        handler=handle,
    )
