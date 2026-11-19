"""Write one visit note into the current session folder, and refuse tools that can rewrite the profile.

Hermes loads this from the profile directory (``$HERMES_HOME/plugins/tess-notes`` once the
profile is running). The model calls ``tess_save_note``. It cannot pass a path.
``pre_tool_call`` blocks ``skill_manage`` and the other tools that can write a file or
create a skill, a catalog, or a project. ``skills_list`` and ``skill_view`` stay available.
"""

import json
import os
import re
from pathlib import Path

NAMES = {
    "words": "words.txt",
    "title": "title.txt",
    "summary": "summary.txt",
    "doctor": "doctor.txt",
}
MAX_BYTES = 64 * 1024

# File tools, skill writes, and the desktop catalog/project tools. The matching toolsets
# are also disabled in config.yaml; this hook is the check that still runs if one is turned back on.
_BLOCKED_TOOLS = frozenset({
    "skill_manage",
    "read_file",
    "write_file",
    "patch",
    "search_files",
    "manage_catalog",
    "desktop_project",
    "execute_code",
})
_ALLOWED_DOLLARS = frozenset({"HERMES_HOME", "HOME"})
_DOLLAR_NAME = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)")


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
    """The newest real session directory. A link, or a folder outside the profile, is refused."""
    home_path = profile_home(home)
    root = home_path / "cache" / "support" / "sessions"
    cursor = home_path
    for name in ("cache", "support", "sessions"):
        cursor = cursor / name
        if cursor.is_symlink():
            raise ValueError("refusing to follow a link")
    try:
        real_root = root.resolve()
    except OSError as exc:
        raise ValueError("there is no session folder yet") from exc
    if not real_root.is_relative_to(home_path):
        raise ValueError("the session root is outside the profile")
    if not real_root.is_dir():
        raise ValueError("there is no session folder yet")
    found = []
    for child in real_root.iterdir():
        if child.is_symlink() or not child.is_dir():
            continue
        real = child.resolve()
        if not real.is_relative_to(real_root) or real.parent != real_root:
            continue
        marker = real / "session.json"
        if marker.is_symlink() or not marker.is_file():
            continue
        found.append(real)
    if not found:
        raise ValueError("there is no session folder yet")
    return max(found, key=lambda path: path.stat().st_mtime)


def _write_note(dest, raw):
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(dest, flags, 0o600)
    except OSError as exc:
        raise ValueError("refusing to follow a link") from exc
    try:
        view = memoryview(raw)
        while view:
            wrote = os.write(fd, view)
            if wrote <= 0:
                raise ValueError("could not write the note")
            view = view[wrote:]
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


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
    _write_note(dest, raw)
    return {"ok": True, "file": NAMES[kind]}


def _strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        out = []
        for item in value.values():
            out.extend(_strings(item))
        return out
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            out.extend(_strings(item))
        return out
    return []


def _bad_dollar(text):
    """True when the command expands any ``$`` other than ``$HERMES_HOME`` and ``$HOME``."""
    i = 0
    while True:
        j = text.find("$", i)
        if j < 0:
            return False
        if j > 0 and text[j - 1] == "\\":
            i = j + 1
            continue
        match = _DOLLAR_NAME.match(text[j + 1:])
        if not match:
            return True
        name = match.group(1) or match.group(2)
        if name not in _ALLOWED_DOLLARS:
            return True
        i = j + 1 + match.end()


def pre_tool_call(tool_name="", args=None, **kwargs):
    """Block skill and file writes, and any shell variable other than the two the skills use."""
    del kwargs
    name = str(tool_name or "").strip()
    if name in _BLOCKED_TOOLS:
        return {"action": "block", "message": "That tool cannot write files on this Mac."}
    if name == "terminal":
        for text in _strings(args or {}):
            if _bad_dollar(text):
                return {
                    "action": "block",
                    "message": "Only $HERMES_HOME and $HOME may appear in a command.",
                }
    return None


def register(ctx):
    schema = {
        "name": "tess_save_note",
        "description": (
            "Save what the person typed, a plain title, a short summary, or a doctor note into "
            "this visit's session folder. kind is words, title, summary or doctor. It writes only "
            "that one file, only inside the current session, and it refuses any other name or path."
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
    ctx.register_hook("pre_tool_call", pre_tool_call)
