"""Flattens reads into case-level and lesion-level tables (CSV export + cloud sync)."""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone

from .config import CONFIG
from .db import db
from .imaging import clinical_for


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None


def all_reads(where: str = "", params: tuple = ()) -> list:
    with db() as conn:
        return conn.execute(
            f"""SELECT r.*, u.username, u.full_name FROM reads r JOIN users u ON u.id = r.user_id
                {where} ORDER BY u.username, r.case_id""",
            params,
        ).fetchall()


def _ann(s):
    return json.loads(s) if s else None


def _overall(ann):
    if not ann:
        return None
    scores = [l.get("pirads") for l in ann.get("lesions", []) if l.get("pirads")]
    return max(scores) if scores else ann.get("overall_pirads")


def case_row(r) -> dict:
    s1, fin = _ann(r["stage1_json"]), _ann(r["final_json"])
    clin = clinical_for(r["case_id"])
    return {
        "study_id": CONFIG["study"]["id"],
        "reader": r["username"],
        "reader_name": r["full_name"],
        "case_id": r["case_id"],
        "status": r["status"],
        "stage": r["stage"],
        "image_only_pirads": _overall(s1),
        "image_only_n_lesions": len(s1["lesions"]) if s1 else None,
        "final_pirads": _overall(fin),
        "final_n_lesions": len(fin["lesions"]) if fin else None,
        "final_comment": fin.get("comment") if fin else None,
        "stage1_seconds": round(r["stage1_seconds"], 1),
        "stage2_seconds": round(r["stage2_seconds"], 1),
        "total_seconds": round(r["stage1_seconds"] + r["stage2_seconds"], 1),
        "psa": clin.get("psa"),
        "prostate_volume": clin.get("prostate_volume"),
        "psa_density": clin.get("psa_density"),
        "started_at": iso(r["started_at"]),
        "stage1_submitted_at": iso(r["stage1_submitted_at"]),
        "completed_at": iso(r["completed_at"]),
        "updated_at": iso(r["updated_at"]),
    }


def lesion_rows(r) -> list[dict]:
    out = []
    for stage_name, ann in (("image_only", _ann(r["stage1_json"])), ("final", _ann(r["final_json"]))):
        if not ann:
            continue
        for l in ann.get("lesions", []):
            ras, ijk = l.get("ras") or [None] * 3, (l.get("ijk_t2") or []) + [None] * 3
            out.append({
                "study_id": CONFIG["study"]["id"],
                "reader": r["username"],
                "case_id": r["case_id"],
                "read_stage": stage_name,
                "lesion": l.get("id"),
                "pirads": l.get("pirads"),
                "zone": l.get("zone"),
                "level": l.get("level"),
                "side": l.get("side"),
                "ras_x": ras[0], "ras_y": ras[1], "ras_z": ras[2],
                "t2_i": ijk[0], "t2_j": ijk[1], "t2_k": ijk[2],
                "placed_on": l.get("placed_on"),
                "comment": l.get("comment"),
            })
    return out


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return buf.getvalue()


def cases_csv() -> str:
    return to_csv([case_row(r) for r in all_reads()])


def lesions_csv() -> str:
    return to_csv([row for r in all_reads() for row in lesion_rows(r)])


def raw_json() -> str:
    out = []
    for r in all_reads():
        d = case_row(r)
        d["image_only_read"] = _ann(r["stage1_json"])
        d["final_read"] = _ann(r["final_json"])
        d["draft"] = _ann(r["draft_json"])
        out.append(d)
    return json.dumps(out, indent=2)
