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
