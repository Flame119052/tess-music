CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  install TEXT NOT NULL,
  kind TEXT NOT NULL,
  tess TEXT, spotify TEXT, macos TEXT,
  status TEXT,
  body TEXT
);
CREATE INDEX IF NOT EXISTS reports_install ON reports(install, at);
CREATE INDEX IF NOT EXISTS reports_at ON reports(at);
CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL);
-- The newest rescue serial Macs should wake for. One row, written only by the owner's rescue tool.
CREATE TABLE IF NOT EXISTS wake (id INTEGER PRIMARY KEY CHECK (id = 1), serial INTEGER NOT NULL);
-- Support reports, from the one support bot people message. A row is everything needed to file an issue: what the
-- person said, what the bot worked out, the priority and areas it suggests, and the finished write-up. `person` is the
-- token's label, never a Telegram id or a name, and `issue` records which GitHub issue it became.
CREATE TABLE IF NOT EXISTS support_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  person TEXT,
  install TEXT,
  tess TEXT, spotify TEXT, macos TEXT,
  priority TEXT NOT NULL,
  areas TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  words TEXT,
  diagnosis TEXT,
  body TEXT,
  issue TEXT,
  filed_at INTEGER,
  recording TEXT
);
CREATE INDEX IF NOT EXISTS support_reports_at ON support_reports(at);
-- One row per approved poster. Only the SHA-256 of a token is stored, so this table cannot leak one; revoking is a
-- one-line update and the token stops working on the next request.
CREATE TABLE IF NOT EXISTS support_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  sha TEXT NOT NULL UNIQUE,
  added INTEGER NOT NULL,
  revoked INTEGER
);

-- Titles of open issues, so the bot can check "is this already known" without a GitHub login. Public data, refreshed by
-- the owner's tooling (`node tools/reports.mjs support titles`), never written by the Worker.
CREATE TABLE IF NOT EXISTS issue_titles (
  n INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  updated INTEGER NOT NULL
);
