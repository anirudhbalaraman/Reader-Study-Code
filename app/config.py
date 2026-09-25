"""Loads config.yaml (falls back to config.example.yaml) and resolves paths."""
from __future__ import annotations

import copy
import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

DEFAULTS = {
    "study": {
        "id": "pirads-study",
        "title": "PI-RADS Reader Study",
        "signup_code": "",
        "randomize_order": True,
        "two_stage_read": True,
        "record_reading_time": True,
        "idle_timeout_seconds": 120,
        "allow_edit_after_submit": False,
        "lesion_scores": [2, 3, 4, 5],
        "max_lesions": 4,
    },
    "data": {
        "cases_dir": "data/cases",
        "sequences": {
            "t2w": ["t2w.nii.gz", "t2w.nii", "*t2*.nii*"],
            "dwi": ["dwi.nii.gz", "dwi.nii", "*hbv*.nii*", "*dwi*.nii*"],
            "adc": ["adc.nii.gz", "adc.nii", "*adc*.nii*"],
        },
        "clinical_csv": "data/clinical.csv",
    },
    "database": {"path": "data/reader_study.sqlite3"},
    "server": {"host": "0.0.0.0", "port": 8000},
    "cloud_sync": {
        "enabled": False,
        "supabase_url": "",
        "supabase_key": "",
        "table": "pirads_reads",
        "interval_seconds": 30,
        "include_drafts": True,
    },
}


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def _resolve(p: str) -> Path:
    path = Path(os.path.expanduser(p))
    return path if path.is_absolute() else (ROOT / path)


def load_config() -> dict:
    env_path = os.environ.get("READER_STUDY_CONFIG")
    candidates = [Path(env_path)] if env_path else [ROOT / "config.yaml", ROOT / "config.example.yaml"]
    raw: dict = {}
    for c in candidates:
        if c.exists():
            raw = yaml.safe_load(c.read_text()) or {}
            break
    cfg = _merge(DEFAULTS, raw)
    cfg["data"]["cases_dir"] = _resolve(cfg["data"]["cases_dir"])
    cfg["data"]["clinical_csv"] = _resolve(cfg["data"]["clinical_csv"]) if cfg["data"]["clinical_csv"] else None
    cfg["database"]["path"] = _resolve(cfg["database"]["path"])
    if not cfg["cloud_sync"].get("supabase_key"):
        cfg["cloud_sync"]["supabase_key"] = os.environ.get("SUPABASE_SERVICE_KEY", "")
    return cfg


CONFIG = load_config()
