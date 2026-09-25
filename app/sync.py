"""Pushes results to a Supabase (Postgres) table so they can be viewed from anywhere.

Everything is saved locally first; this worker copies changed rows to the cloud
every few seconds and simply retries later if the internet is down.
Only pseudonymized case IDs, reader usernames, scores, lesion coordinates and
timings are sent. No images, no PSA/volume values.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.parse
import urllib.request

from .config import CONFIG
from .db import db, kv_get, kv_set, now
from .export import _ann, _overall, all_reads, iso

log = logging.getLogger("sync")
CS = CONFIG["cloud_sync"]
_lock = threading.Lock()


def enabled() -> bool:
    return bool(CS["enabled"] and CS["supabase_url"] and CS["supabase_key"])


def _request(method: str, path: str, body=None, extra_headers=None):
    url = CS["supabase_url"].rstrip("/") + "/rest/v1/" + path
    key = CS["supabase_key"]
    headers = {"apikey": key, "Content-Type": "application/json", "Prefer": "return=minimal"}
    if key.startswith("eyJ"):   # legacy service_role JWT; new sb_secret_ keys go in apikey only
        headers["Authorization"] = f"Bearer {key}"
    headers.update(extra_headers or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status


def cloud_row(r) -> dict:
    s1, fin = _ann(r["stage1_json"]), _ann(r["final_json"])
    return {
        "study_id": CONFIG["study"]["id"],
        "reader": r["username"],
        "case_id": r["case_id"],
        "status": r["status"],
        "stage": r["stage"],
        "image_only_pirads": _overall(s1),
        "final_pirads": _overall(fin),
        "image_only_read": s1,
        "final_read": fin,
        "draft": _ann(r["draft_json"]) if CS["include_drafts"] and r["status"] != "completed" else None,
        "stage1_seconds": round(r["stage1_seconds"], 1),
        "stage2_seconds": round(r["stage2_seconds"], 1),
        "started_at": iso(r["started_at"]),
        "stage1_submitted_at": iso(r["stage1_submitted_at"]),
        "completed_at": iso(r["completed_at"]),
        "updated_at": iso(r["updated_at"]),
    }


def queue_delete(username: str, case_id: str) -> None:
    pending = json.loads(kv_get("pending_cloud_deletes", "[]"))
    pending.append([username, case_id])
    kv_set("pending_cloud_deletes", json.dumps(pending))


def pending_count() -> int:
    with db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM reads WHERE synced_at IS NULL OR updated_at > synced_at"
        ).fetchone()
    return row["n"]


def sync_once() -> dict:
    if not enabled():
        return {"enabled": False}
    with _lock:
        kv_set("sync_last_attempt", now())
        try:
            # deletions (reads reset by the admin)
            pending = json.loads(kv_get("pending_cloud_deletes", "[]"))
            for reader, case_id in list(pending):
                q = urllib.parse.urlencode({
                    "study_id": f"eq.{CONFIG['study']['id']}", "reader": f"eq.{reader}", "case_id": f"eq.{case_id}",
                })
                _request("DELETE", f"{CS['table']}?{q}")
                pending.remove([reader, case_id])
                kv_set("pending_cloud_deletes", json.dumps(pending))

            rows = all_reads("WHERE r.synced_at IS NULL OR r.updated_at > r.synced_at")
            if not CS["include_drafts"]:
                rows = [r for r in rows if r["stage1_json"] or r["final_json"]]
            for i in range(0, len(rows), 200):
                batch = rows[i:i + 200]
                _request(
                    "POST",
                    f"{CS['table']}?on_conflict=study_id,reader,case_id",
                    [cloud_row(r) for r in batch],
                    {"Prefer": "resolution=merge-duplicates,return=minimal"},
                )
                with db() as conn:
                    conn.executemany(
                        "UPDATE reads SET synced_at = ? WHERE id = ? AND updated_at = ?",
                        [(r["updated_at"], r["id"], r["updated_at"]) for r in batch],
                    )
            kv_set("sync_last_ok", now())
            kv_set("sync_last_error", "")
            return {"enabled": True, "pushed": len(rows)}
        except Exception as e:  # network down, bad key, ...
            msg = f"{type(e).__name__}: {e}"
            if hasattr(e, "read"):
                try:
                    msg += " - " + e.read().decode()[:300]
                except Exception:
                    pass
            kv_set("sync_last_error", msg)
            log.warning("cloud sync failed: %s", msg)
            return {"enabled": True, "error": msg}


def status() -> dict:
    return {
        "enabled": enabled(),
        "configured_but_missing_key": bool(CS["enabled"] and not CS["supabase_key"]),
        "last_attempt": iso(float(kv_get("sync_last_attempt") or 0)),
        "last_ok": iso(float(kv_get("sync_last_ok") or 0)),
        "last_error": kv_get("sync_last_error") or "",
        "pending_rows": pending_count() if enabled() else None,
    }


def start_background_worker() -> None:
    if not enabled():
        log.info("cloud sync disabled")
        return

    def loop():
        while True:
            sync_once()
            time.sleep(max(5, int(CS["interval_seconds"])))

    threading.Thread(target=loop, name="cloud-sync", daemon=True).start()
