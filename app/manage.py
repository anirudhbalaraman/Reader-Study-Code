"""Command-line helpers.

    python -m app.manage create-admin <username>      # asks for a password
    python -m app.manage reset-password <username>
    python -m app.manage list-users
    python -m app.manage check-data                   # verifies every case can be loaded
    python -m app.manage sync-now
"""
from __future__ import annotations

import getpass
import sys

from .db import db, init_db


def _ask_password() -> str:
    p1 = getpass.getpass("Password: ")
    p2 = getpass.getpass("Repeat password: ")
    if p1 != p2:
        sys.exit("Passwords do not match.")
    return p1


def main(argv: list[str]) -> None:
    init_db()
    if not argv:
        print(__doc__)
        return
    cmd, args = argv[0], argv[1:]

    if cmd == "create-admin":
        from .auth import create_user
        if not args:
            sys.exit("usage: create-admin <username> [full name]")
        with db() as conn:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (args[0],)).fetchone()
            if row:
                conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (row["id"],))
                print(f"Existing user '{args[0]}' is now an admin.")
                return
        create_user(args[0], _ask_password(), " ".join(args[1:]), is_admin=True)
        print(f"Admin '{args[0]}' created.")

    elif cmd == "reset-password":
        from .auth import set_password
        with db() as conn:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (args[0],)).fetchone()
        if not row:
            sys.exit("No such user.")
        set_password(row["id"], _ask_password())
        print("Password changed.")

    elif cmd == "list-users":
        with db() as conn:
            for r in conn.execute("SELECT username, full_name, is_admin FROM users ORDER BY username"):
                print(f"{r['username']:<24} {'admin' if r['is_admin'] else 'reader':<7} {r['full_name']}")

    elif cmd == "check-data":
        from . import imaging
        cases = imaging.list_cases()
        clinical = imaging.clinical_table()
        print(f"Cases folder: {imaging.cases_dir()}  ({len(cases)} folders, {len(clinical)} clinical rows)")
        bad = 0
        for c in cases:
            problems = [s for s, f in c["files"].items() if not f]
            if not problems:
                for s in imaging.SEQUENCES:
                    try:
                        m = imaging.volume_meta(c["case_id"], s)
                        c["files"][s] += f" {m['shape']}x{m['frames']}"
                    except Exception as e:  # noqa: BLE001
                        problems.append(f"{s} unreadable ({e})")
            if c["case_id"] not in clinical:
                problems.append("no PSA/volume row")
            bad += bool(problems)
            status = "OK " if not problems else "!! "
            print(status, c["case_id"], "|", " | ".join(f"{k}: {v}" for k, v in c["files"].items()),
                  ("  <- " + ", ".join(problems)) if problems else "")
        print(f"\n{len(cases) - bad} OK, {bad} with problems.")

    elif cmd == "sync-now":
        from . import sync
        print(sync.sync_once())
        print(sync.status())

    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
