"""SQLite storage. One file, safe to copy for backups (WAL mode)."""
from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .config import CONFIG

DB_PATH: Path = CONFIG["database"]["path"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL COLLATE NOCASE,
    full_name   TEXT NOT NULL DEFAULT '',
    pw_hash     TEXT NOT NULL,
    is_admin    INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL,
    last_seen   REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  REAL NOT NULL,
    expires_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS case_order (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    case_id     TEXT NOT NULL,
    position    INTEGER NOT NULL,
    PRIMARY KEY (user_id, case_id)
);
CREATE TABLE IF NOT EXISTS reads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    case_id             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'in_progress',   -- in_progress | completed
    stage               INTEGER NOT NULL DEFAULT 1,            -- 1 = images only, 2 = with clinical info
    draft_json          TEXT,                                  -- current (autosaved) annotation
    stage1_json         TEXT,                                  -- frozen image-only read
    final_json          TEXT,                                  -- frozen final read
    stage1_seconds      REAL NOT NULL DEFAULT 0,
    stage2_seconds      REAL NOT NULL DEFAULT 0,
    started_at          REAL NOT NULL,
    stage1_submitted_at REAL,
    completed_at        REAL,
    updated_at          REAL NOT NULL,
    synced_at           REAL,
    UNIQUE (user_id, case_id)
);
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)


def now() -> float:
    return time.time()


def kv_get(key: str, default=None):
    with db() as conn:
        row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def kv_set(key: str, value) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, None if value is None else str(value)),
        )
