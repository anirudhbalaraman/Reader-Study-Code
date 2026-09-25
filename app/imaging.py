"""Case discovery, clinical data and NIfTI volume serving."""
from __future__ import annotations

import csv
import fnmatch
import gzip
import threading
from collections import OrderedDict
from pathlib import Path

import nibabel as nib
import numpy as np

from .config import CONFIG

SEQUENCES = ("t2w", "dwi", "adc")
SEQ_LABELS = {"t2w": "T2W", "dwi": "DWI (high b)", "adc": "ADC"}


# ---------------------------------------------------------------- cases ----
def cases_dir() -> Path:
    return CONFIG["data"]["cases_dir"]


def find_sequence_file(case_path: Path, seq: str) -> Path | None:
    files = sorted(p for p in case_path.iterdir() if p.is_file())
    for pattern in CONFIG["data"]["sequences"].get(seq, []):
        for f in files:
            if fnmatch.fnmatch(f.name.lower(), pattern.lower()):
                return f
    return None


def list_cases() -> list[dict]:
    """Every sub-folder of cases_dir is a case. Sorted by id."""
    root = cases_dir()
    if not root.exists():
        return []
    out = []
    for p in sorted(x for x in root.iterdir() if x.is_dir() and not x.name.startswith(".")):
        files = {s: find_sequence_file(p, s) for s in SEQUENCES}
        out.append({
            "case_id": p.name,
            "files": {s: (f.name if f else None) for s, f in files.items()},
            "complete": all(files.values()),
        })
    return out


def case_ids() -> list[str]:
    return [c["case_id"] for c in list_cases() if c["complete"]]


def case_path(case_id: str) -> Path:
    p = (cases_dir() / case_id).resolve()
    if p.parent != cases_dir().resolve() or not p.is_dir():
        raise FileNotFoundError(case_id)
    return p


# ------------------------------------------------------------- clinical ----
_clinical_cache: dict = {"mtime": None, "data": {}}


def _to_float(v):
    try:
        v = str(v).strip().replace(",", ".")
        return float(v) if v else None
    except ValueError:
        return None


def clinical_table() -> dict:
    path = CONFIG["data"]["clinical_csv"]
    if not path or not Path(path).exists():
        return {}
    mtime = Path(path).stat().st_mtime
    if _clinical_cache["mtime"] == mtime:
        return _clinical_cache["data"]
    data = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        sample = fh.read(4096)
        fh.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        for row in csv.DictReader(fh, dialect=dialect):
            row = {(k or "").strip().lower(): v for k, v in row.items()}
            cid = (row.get("case_id") or row.get("id") or row.get("case") or "").strip()
            if not cid:
                continue
            psa = _to_float(row.get("psa"))
            vol = _to_float(row.get("prostate_volume") or row.get("volume") or row.get("prostate_volume_ml"))
            data[cid] = {
                "psa": psa,
                "prostate_volume": vol,
                "psa_density": round(psa / vol, 3) if psa is not None and vol else None,
            }
    _clinical_cache.update(mtime=mtime, data=data)
    return data


def clinical_for(case_id: str) -> dict:
    return clinical_table().get(case_id, {"psa": None, "prostate_volume": None, "psa_density": None})


# -------------------------------------------------------------- volumes ----
class _LRU:
    def __init__(self, maxsize: int):
        self.maxsize, self.data, self.lock = maxsize, OrderedDict(), threading.Lock()

    def get(self, key, factory):
        with self.lock:
            if key in self.data:
                self.data.move_to_end(key)
                return self.data[key]
        value = factory()
        with self.lock:
            self.data[key] = value
            self.data.move_to_end(key)
            while len(self.data) > self.maxsize:
                self.data.popitem(last=False)
        return value


_volumes = _LRU(12)     # loaded arrays + metadata
_payloads = _LRU(24)    # gzip-compressed voxel bytes


def _load(case_id: str, seq: str) -> dict:
    f = find_sequence_file(case_path(case_id), seq)
    if f is None:
        raise FileNotFoundError(f"{case_id}: no {seq} file")
    img = nib.load(str(f))
    arr = np.asanyarray(img.dataobj)
    arr = np.squeeze(arr) if arr.ndim > 4 else arr
    if arr.ndim == 2:
        arr = arr[:, :, None]
    if arr.ndim == 3:
        arr = arr[..., None]
    arr = np.nan_to_num(arr.astype(np.float32, copy=False))
    frames = []
    for t in range(arr.shape[3]):
        vol = arr[..., t]
        vmin = vol.min()
        # ignore background fill (0, or a negative value such as -1 / -256 in some ADC maps)
        mask = vol != 0
        if vmin < 0 and (vol == vmin).mean() > 0.2:
            mask &= vol != vmin
        nz = vol[mask]
        sample = nz if nz.size > 100 else vol.ravel()
        if sample.size > 2_000_000:
            sample = sample[:: sample.size // 2_000_000 + 1]
        lo, hi = np.percentile(sample, [0.5, 99.5]) if sample.size else (0.0, 1.0)
        if hi <= lo:
            hi = lo + 1
        frames.append({
            "min": float(vol.min()), "max": float(vol.max()),
            "window": float(hi - lo), "level": float((hi + lo) / 2),
        })
    is_int = bool(np.all(np.mod(arr, 1) == 0)) and arr.min() >= -32768 and arr.max() <= 32767
    return {
        "array": arr,
        "meta": {
            "sequence": seq,
            "label": SEQ_LABELS[seq],
            "file": f.name,
            "shape": [int(s) for s in arr.shape[:3]],
            "frames": int(arr.shape[3]),
            "default_frame": int(arr.shape[3] - 1),   # multi-b DWI: highest b is usually last
            "affine": img.affine.astype(float).tolist(),   # voxel (i,j,k) -> RAS mm
            "spacing": [float(z) for z in img.header.get_zooms()[:3]],
            "dtype": "int16" if is_int else "float32",
            "frame_stats": frames,
        },
    }


def volume(case_id: str, seq: str) -> dict:
    if seq not in SEQUENCES:
        raise FileNotFoundError(seq)
    return _volumes.get((case_id, seq), lambda: _load(case_id, seq))


def volume_meta(case_id: str, seq: str) -> dict:
    return volume(case_id, seq)["meta"]


def volume_payload(case_id: str, seq: str, frame: int) -> bytes:
    """gzip-compressed voxels, i-fastest (Fortran) order, little-endian."""
    def build():
        v = volume(case_id, seq)
        fr = max(0, min(frame, v["meta"]["frames"] - 1))
        data = v["array"][..., fr]
        dt = "<i2" if v["meta"]["dtype"] == "int16" else "<f4"
        raw = np.asfortranarray(data.astype(dt)).tobytes(order="F")
        return gzip.compress(raw, compresslevel=4)
    return _payloads.get((case_id, seq, frame), build)
