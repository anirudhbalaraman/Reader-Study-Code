"""Worklists, autosave and the two-stage reading workflow."""
from __future__ import annotations

import json
import random

from fastapi import HTTPException

from .config import CONFIG
from .db import db, now
from .imaging import case_ids, clinical_for

STUDY = CONFIG["study"]
MAX_ELAPSED_PER_SAVE = 300  # seconds; guards against a stuck client inflating the timer
ZONES = {"", "PZ", "TZ", "CZ", "AFS"}
LEVELS = {"", "base", "mid", "apex"}
SIDES = {"", "R", "L"}


def empty_annotation() -> dict:
    return {"lesions": [], "overall_pirads": None, "comment": ""}


# ------------------------------------------------------------ worklist ----
def ensure_order(user_id: int) -> list[str]:
    """Returns this reader's case order, adding newly found cases at the end."""
    ids = case_ids()
    with db() as conn:
        rows = conn.execute(
            "SELECT case_id, position FROM case_order WHERE user_id = ? ORDER BY position", (user_id,)
        ).fetchall()
        known = {r["case_id"] for r in rows}
        new = [c for c in ids if c not in known]
        if new:
            if STUDY["randomize_order"]:
                random.SystemRandom().shuffle(new)
            start = (rows[-1]["position"] + 1) if rows else 0
            conn.executemany(
                "INSERT INTO case_order (user_id, case_id, position) VALUES (?, ?, ?)",
                [(user_id, c, start + i) for i, c in enumerate(new)],
            )
            rows = conn.execute(
                "SELECT case_id, position FROM case_order WHERE user_id = ? ORDER BY position", (user_id,)
            ).fetchall()
    available = set(ids)
    return [r["case_id"] for r in rows if r["case_id"] in available]


def worklist(user_id: int) -> list[dict]:
    order = ensure_order(user_id)
    with db() as conn:
        reads = {
            r["case_id"]: r
            for r in conn.execute("SELECT * FROM reads WHERE user_id = ?", (user_id,)).fetchall()
        }
    out = []
    for i, cid in enumerate(order):
        r = reads.get(cid)
        out.append({
            "index": i + 1,
            "case_id": cid,
            "status": r["status"] if r else "not_started",
            "stage": r["stage"] if r else 1,
        })
    return out


# --------------------------------------------------------------- reads ----
def get_read(user_id: int, case_id: str):
    with db() as conn:
        return conn.execute(
            "SELECT * FROM reads WHERE user_id = ? AND case_id = ?", (user_id, case_id)
        ).fetchone()


def _get_or_create(user_id: int, case_id: str):
    r = get_read(user_id, case_id)
    if r:
        return r
    t = now()
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO reads (user_id, case_id, draft_json, started_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, case_id, json.dumps(empty_annotation()), t, t),
        )
    return get_read(user_id, case_id)


def clinical_visible(read) -> bool:
    if not STUDY["two_stage_read"]:
        return True
    return read is not None and (read["stage"] >= 2 or read["status"] == "completed")


def read_state(user_id: int, case_id: str) -> dict:
    if case_id not in case_ids():
        raise HTTPException(404, "Case not found or incomplete.")
    r = _get_or_create(user_id, case_id)
    locked = r["status"] == "completed" and not STUDY["allow_edit_after_submit"]
    ann = json.loads(r["final_json"] or r["draft_json"]) if r["status"] == "completed" else json.loads(r["draft_json"])
    return {
        "case_id": case_id,
        "status": r["status"],
        "stage": r["stage"],
        "locked": locked,
        "annotation": ann,
        "stage1": json.loads(r["stage1_json"]) if r["stage1_json"] else None,
        "clinical": clinical_for(case_id) if clinical_visible(r) else None,
        "stage1_seconds": r["stage1_seconds"],
        "stage2_seconds": r["stage2_seconds"],
    }


def _clean_annotation(ann: dict) -> dict:
    if not isinstance(ann, dict):
        raise HTTPException(400, "Bad annotation.")
    lesions = []
    for i, l in enumerate(ann.get("lesions") or []):
        ras = l.get("ras")
        if not (isinstance(ras, list) and len(ras) == 3):
            raise HTTPException(400, "Lesion without a position.")
        p = l.get("pirads")
        lesions.append({
            "id": str(l.get("id") or f"L{i + 1}")[:16],
            "pirads": int(p) if p not in (None, "") else None,
            "zone": l.get("zone") if l.get("zone") in ZONES else "",
            "level": l.get("level") if l.get("level") in LEVELS else "",
            "side": l.get("side") if l.get("side") in SIDES else "",
            "comment": str(l.get("comment") or "")[:500],
            "ras": [round(float(v), 2) for v in ras],
            "ijk_t2": [round(float(v), 2) for v in (l.get("ijk_t2") or [])][:3],
            "placed_on": str(l.get("placed_on") or "")[:8],
        })
    if len(lesions) > STUDY["max_lesions"]:
        raise HTTPException(400, f"At most {STUDY['max_lesions']} lesions per case.")
    op = ann.get("overall_pirads")
    return {
        "lesions": lesions,
        "overall_pirads": int(op) if op not in (None, "") else None,
        "comment": str(ann.get("comment") or "")[:2000],
    }


def overall_score(ann: dict):
    scores = [l["pirads"] for l in ann["lesions"] if l["pirads"]]
    return max(scores) if scores else ann.get("overall_pirads")


def _validate_for_submit(ann: dict) -> None:
    allowed = set(STUDY["lesion_scores"])
    for l in ann["lesions"]:
        if l["pirads"] not in allowed:
            raise HTTPException(400, f"Lesion {l['id']}: choose a PI-RADS score.")
    if not ann["lesions"] and ann["overall_pirads"] not in (1, 2):
        raise HTTPException(400, "No lesion marked: choose PI-RADS 1 or 2 for the case.")


def _check_editable(r):
    if r["status"] == "completed" and not STUDY["allow_edit_after_submit"]:
        raise HTTPException(409, "This case is already submitted.")


def _elapsed(v) -> float:
    try:
        return max(0.0, min(float(v or 0), MAX_ELAPSED_PER_SAVE)) if STUDY["record_reading_time"] else 0.0
    except (TypeError, ValueError):
        return 0.0


def autosave(user_id: int, case_id: str, annotation: dict, elapsed) -> dict:
    r = _get_or_create(user_id, case_id)
    _check_editable(r)
    ann = _clean_annotation(annotation)
    col = "stage1_seconds" if r["stage"] == 1 else "stage2_seconds"
    with db() as conn:
        conn.execute(
            f"UPDATE reads SET draft_json = ?, {col} = {col} + ?, updated_at = ? WHERE id = ?",
            (json.dumps(ann), _elapsed(elapsed), now(), r["id"]),
        )
    return {"ok": True, "saved_at": now()}


def submit(user_id: int, case_id: str, annotation: dict, elapsed) -> dict:
    r = _get_or_create(user_id, case_id)
    _check_editable(r)
    ann = _clean_annotation(annotation)
    _validate_for_submit(ann)
    ann["overall_pirads"] = overall_score(ann)
    t, el = now(), _elapsed(elapsed)
    with db() as conn:
        if STUDY["two_stage_read"] and r["stage"] == 1:
            conn.execute(
                """UPDATE reads SET stage = 2, stage1_json = ?, draft_json = ?,
                   stage1_seconds = stage1_seconds + ?, stage1_submitted_at = ?, updated_at = ? WHERE id = ?""",
                (json.dumps(ann), json.dumps(ann), el, t, t, r["id"]),
            )
        else:
            col = "stage1_seconds" if r["stage"] == 1 else "stage2_seconds"
            conn.execute(
                f"""UPDATE reads SET status = 'completed', final_json = ?, draft_json = ?,
                    {col} = {col} + ?, completed_at = ?, updated_at = ? WHERE id = ?""",
                (json.dumps(ann), json.dumps(ann), el, t, t, r["id"]),
            )
    return read_state(user_id, case_id)


def reopen(user_id: int, case_id: str) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE reads SET status = 'in_progress', completed_at = NULL, updated_at = ? WHERE user_id = ? AND case_id = ?",
            (now(), user_id, case_id),
        )


def reset(user_id: int, case_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM reads WHERE user_id = ? AND case_id = ?", (user_id, case_id))
