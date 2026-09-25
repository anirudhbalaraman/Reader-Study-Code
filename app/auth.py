"""Accounts and cookie sessions (no external dependencies)."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets

from typing import Optional

from fastapi import Cookie, HTTPException

from .db import db, now

SESSION_COOKIE = "rs_session"
SESSION_DAYS = 30
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return f"pbkdf2_sha256$200000${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt, digest = stored.split("$")
        test = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iters)).hex()
        return hmac.compare_digest(test, digest)
    except ValueError:
        return False


def validate_new_account(username: str, password: str) -> None:
    if not USERNAME_RE.match(username or ""):
        raise HTTPException(400, "Username: 3-32 characters, letters, digits, dot, dash or underscore.")
    if len(password or "") < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")


def create_user(username: str, password: str, full_name: str = "", is_admin: bool = False) -> int:
    validate_new_account(username, password)
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise HTTPException(409, "That username is already taken.")
        cur = conn.execute(
            "INSERT INTO users (username, full_name, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
            (username, full_name.strip(), hash_password(password), int(is_admin), now()),
        )
        return cur.lastrowid


def set_password(user_id: int, password: str) -> None:
    if len(password or "") < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")
    with db() as conn:
        conn.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(password), user_id))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def authenticate(username: str, password: str):
    with db() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row or not verify_password(password, row["pw_hash"]):
        raise HTTPException(401, "Wrong username or password.")
    return row


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    t = now()
    with db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, t, t + SESSION_DAYS * 86400),
        )
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (t,))
    return token


def delete_session(token: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def current_user(rs_session: Optional[str] = Cookie(default=None)):
    if not rs_session:
        raise HTTPException(401, "Not logged in.")
    with db() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
            (rs_session, now()),
        ).fetchone()
        if not row:
            raise HTTPException(401, "Session expired, please log in again.")
        conn.execute("UPDATE users SET last_seen = ? WHERE id = ?", (now(), row["id"]))
    return dict(row)


def admin_user(rs_session: Optional[str] = Cookie(default=None)):
    user = current_user(rs_session)
    if not user["is_admin"]:
        raise HTTPException(403, "Admin only.")
    return user
