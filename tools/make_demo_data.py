"""Creates synthetic bpMRI phantoms so you can try the app without patient data.

    python tools/make_demo_data.py            # writes data/demo_cases + data/demo_clinical.csv

Then point config.yaml -> data.cases_dir / clinical_csv at those paths.
"""
import csv
import math
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "demo_cases"
rng = np.random.default_rng(7)


def affine(shape, spacing, tilt_deg=0.0, center=(0, -10, 20)):
    """Voxel->RAS affine for an axial acquisition, optionally tilted about the L-R axis."""
    t = math.radians(tilt_deg)
    rot = np.array([[1, 0, 0], [0, math.cos(t), -math.sin(t)], [0, math.sin(t), math.cos(t)]])
    # typical scanner (LPS -> RAS) layout: i goes to patient left (-R), j goes posterior (-A)
    base = np.diag([-1.0, -1.0, 1.0]) @ np.diag(spacing)
    m = rot @ base
    a = np.eye(4)
    a[:3, :3] = m
    half = (np.array(shape) - 1) / 2
    a[:3, 3] = np.array(center) - m @ half
    return a


def world_grid(shape, aff):
    i, j, k = np.meshgrid(*[np.arange(s) for s in shape], indexing="ij")
    vox = np.stack([i, j, k, np.ones_like(i)], -1).reshape(-1, 4).T
    w = (aff @ vox)[:3].T.reshape(*shape, 3)
    return w


def phantom(w, lesion, gland_r):
    c = np.array([0, -10, 20])
    d = (w - c) / np.array(gland_r)
    gland = (d ** 2).sum(-1) < 1
    tz = (((w - (c + [0, 4, 0])) / (np.array(gland_r) * 0.55)) ** 2).sum(-1) < 1
    body = (((w - [0, 0, 20]) / [140, 110, 400]) ** 2).sum(-1) < 1
    rect = (((w - (c + [0, -gland_r[1] - 14, 0])) / [16, 10, 60]) ** 2).sum(-1) < 1
    bone = ((((np.abs(w[..., 0]) - 80) / 25) ** 2 + ((w[..., 1] + 5) / 25) ** 2) < 1)
    les = np.zeros(w.shape[:3], bool)
    if lesion is not None:
        les = (((w - lesion["pos"]) / lesion["r"]) ** 2).sum(-1) < 1
    return body, gland, tz, rect, bone, les


def make_case(cid, lesion, tilt):
    gland_r = (rng.uniform(20, 28), rng.uniform(15, 20), rng.uniform(18, 24))
    case = OUT / cid
    case.mkdir(parents=True, exist_ok=True)

    # T2W: high in-plane resolution, tilted (oblique) acquisition
    shp = (256, 256, 24)
    aff = affine(shp, (0.6, 0.6, 3.0), tilt)
    body, gland, tz, rect, bone, les = phantom(world_grid(shp, aff), lesion, gland_r)
    t2 = np.where(body, 380, 5).astype(float)
    t2[gland] = 700            # peripheral zone: bright on T2
    t2[gland & tz] = 420       # transition zone: intermediate
    t2[rect] = 160
    t2[bone] = 250
    t2[les] = 260              # lesion: dark on T2
    t2 = t2 * (1 + 0.08 * rng.standard_normal(shp)) + 10 * rng.standard_normal(shp)
    nib.save(nib.Nifti1Image(np.clip(t2, 0, 4000).astype(np.int16), aff), case / "t2w.nii.gz")

    # DWI: lower resolution, 3 b-values in a 4D file (b50, b800, b1400), not tilted
    shp_d = (110, 110, 20)
    aff_d = affine(shp_d, (1.6, 1.6, 3.6), 0.0)
    body, gland, tz, rect, bone, les = phantom(world_grid(shp_d, aff_d), lesion, gland_r)
    adc = np.where(body, 1400, 0).astype(float)
    adc[gland] = 1700
    adc[gland & tz] = 1250
    adc[rect] = 900
    adc[bone] = 600
    adc[les] = 700 if lesion else 0
    adc = adc * (1 + 0.06 * rng.standard_normal(shp_d))
    s0 = np.where(body, 900, 3).astype(float)
    dwi = np.stack([s0 * np.exp(-b * adc * 1e-6) for b in (50, 800, 1400)], -1)
    dwi = dwi * (1 + 0.1 * rng.standard_normal(dwi.shape)) + 4 * np.abs(rng.standard_normal(dwi.shape))
    nib.save(nib.Nifti1Image(dwi.astype(np.int16), aff_d), case / "dwi.nii.gz")
    nib.save(nib.Nifti1Image(np.clip(adc, 0, 4000).astype(np.float32), aff_d), case / "adc.nii.gz")
    vol = 4 / 3 * math.pi * np.prod(gland_r) / 1000
    return round(vol, 1)


def main(n=6):
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for idx in range(1, n + 1):
        cid = f"RS-{idx:03d}"
        lesion = None
        if idx % 3 != 0:
            lesion = {"pos": np.array([rng.choice([-1, 1]) * rng.uniform(7, 12), -10 - rng.uniform(8, 10), 20 + rng.uniform(-5, 5)]),
                      "r": np.array([5, 4, 5]) * rng.uniform(0.8, 1.3)}
        vol = make_case(cid, lesion, tilt=rng.uniform(-15, 15))
        psa = round(float(rng.uniform(3, 18)), 1)
        rows.append({"case_id": cid, "psa": psa, "prostate_volume": vol})
        print("wrote", cid, "lesion" if lesion is not None else "no lesion")
    with open(ROOT / "data" / "demo_clinical.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["case_id", "psa", "prostate_volume"])
        w.writeheader()
        w.writerows(rows)
    print("wrote data/demo_clinical.csv")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 6)
