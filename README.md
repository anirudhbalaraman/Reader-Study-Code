# PI-RADS bpMRI Reader Study

A small web app for a PI-RADS reader study. It runs on one PC in the clinic, and radiologists use it in a web browser. The viewer looks and works like 3D Slicer's slice views.

- **Viewer:** T2W, DWI (high b) and ADC side by side, with Slicer-style colored view bars (R/Y/G), linked slices, window/level, zoom, pan, crosshair and a Data Probe that shows ADC values. You can pick axial, sagittal or coronal for any view. DWI and ADC are resliced into the T2W plane, so all views stay aligned.
- **Annotation:** the reader clicks a point on each lesion and gives it a PI-RADS score (2–5). Zone (PZ/TZ/CZ/AFS), level, side and a comment are optional. The overall case score is the highest lesion score. If no lesion is marked, the reader picks PI-RADS 1 or 2.
- **Two-stage read:** stage 1 uses the images only. After stage 1 is submitted, PSA, prostate volume and PSA density are shown, and the reader can revise the read. Both reads are stored.
- **Study controls:** each reader gets their own random case order. Active reading time is recorded per stage (the timer pauses when the reader is idle or the tab is hidden). Submitted cases are locked.
- **Accounts:** readers create their own account with a study access code. Everything saves automatically, so a reader can log out at any time and continue later.
- **Admin page:** progress per reader and per case, reopening or resetting a case, password resets, and CSV/JSON export.
- **Storage:** everything is saved in a local SQLite file first. If you turn it on, results are also copied to a Supabase table (EU region) that you can open from anywhere. **Images and PSA/volume values never leave the clinic.**

---

## 1. Data layout

```
data/
  cases/
    RS-001/  t2w.nii.gz  dwi.nii.gz  adc.nii.gz
    RS-002/  ...
  clinical.csv
```

- **Folder names are the case IDs.** They are shown to readers and synced to the cloud, so they must be pseudonyms (no names or MRNs).
- File names can differ. Edit the glob patterns under `data.sequences` in `config.yaml` (for example, `*hbv*.nii*` for the DWI).
- **DWI:** use a 3D high-b image (or a calculated b1400). A 4D file with several b-values also works. The last volume is shown by default, and the reader can switch under *Display*.
- `clinical.csv` (comma, semicolon or tab separated):

  ```
  case_id,psa,prostate_volume
  RS-001,6.4,42
  ```

Check your data with `./manage.sh check-data`. It lists every case, missing files and missing PSA rows.

## 2. Run it on your Mac (development)

```bash
cd ~/Projects/pirads-reader-study
python3 tools/make_demo_data.py        # optional: 6 synthetic cases in data/demo_cases
./run.sh                               # first run: creates .venv, installs packages, creates config.yaml
```

To use the demo data, set `cases_dir: "data/demo_cases"` and `clinical_csv: "data/demo_clinical.csv"` in `config.yaml`. Then, in a second terminal:

```bash
./manage.sh create-admin anirudh "Anirudh"     # asks for a password
```

Open http://localhost:8000. Readers sign up with the `signup_code` from `config.yaml`. Admins also see an **Admin** link in the menu (http://localhost:8000/admin).

Requires Python 3.9 or newer. On a Mac, `brew install python` gets a current version if needed.

## 3. Move it to the clinic Linux PC

The Mac-to-Linux move is not a problem. The app is plain Python (FastAPI, nibabel, numpy) with a browser front-end and no compiled parts of its own. The same code runs on both systems unchanged.

1. Copy the project folder, without `.venv/` and `data/`, for example with `git clone` or `rsync`. Put it at `/opt/pirads-reader-study`.
2. Put the NIfTI files and `clinical.csv` under `data/` on that PC, or point `config.yaml` at their location.
3. Install and start the app:
   ```bash
   sudo apt install python3 python3-venv      # Ubuntu/Debian
   ./run.sh                                   # test once in the foreground, then Ctrl+C
   ./manage.sh create-admin anirudh
   ```
4. Start it automatically at boot: see `deploy/pirads-reader.service`. Set `User=` and the paths, then run `sudo systemctl enable --now pirads-reader`.
5. Let the other clinic PCs reach it: `sudo ufw allow 8000/tcp`, if the firewall is on. Readers then open `http://<clinic-pc-name-or-IP>:8000`. If they read on the server PC itself, they use `http://localhost:8000`.
6. Stop the PC from going to sleep while the study runs.

Linux-specific things to watch:

- File names are case-sensitive on Linux (`RS-001` and `rs-001` are different folders). The file-name patterns already ignore case.
- Recreate `.venv` on the Linux PC. Don't copy it from the Mac.
- As an alternative, `deploy/docker-compose.yml` runs the same container on both systems.

## 4. Cloud copy of the results (optional)

1. Create a free project at https://supabase.com and choose an **EU (Frankfurt)** region.
2. Open **SQL Editor**, paste `supabase/schema.sql` and click **Run**. This creates the table `pirads_reads` and the lesion view `pirads_lesions`, with row-level security turned on.
3. Copy the **secret** key (`sb_secret_…`, or the legacy `service_role` key) from Project Settings → API Keys. Put it in `config.yaml` (`cloud_sync.supabase_key`) or in the environment variable `SUPABASE_SERVICE_KEY`. Set `enabled: true` and `supabase_url`.
4. Restart the app. The admin page shows the sync status. Changed rows are pushed every 30 s. If the internet is down, the app keeps working and syncs later.

To view the results from anywhere, open the Supabase Table Editor, or run `python tools/fetch_cloud_results.py` to download CSVs.

What gets synced: study ID, reader username, case ID, status, scores, lesion coordinates (mm), zone/level/side/comments and timings. What does not: images, PSA, volume and patient identifiers.

**Before you enable sync, check with your data-protection officer and ethics board.** Pseudonymized study data is still personal data under GDPR, so the cloud copy needs to be covered by your approval. The local-only mode needs no approval for cloud use.

## 5. Results

Export from the admin page, with one row per reader and case (or per lesion):

| File | Contents |
|---|---|
| `*_cases.csv` | image-only and final PI-RADS, number of lesions, reading time per stage, PSA/volume/PSAD, timestamps |
| `*_lesions.csv` | each lesion in each stage: PI-RADS, zone, level, side, RAS (mm) and T2W voxel coordinates (i, j, k), the sequence it was placed on |
| `*_all.json` | everything, including unfinished drafts |

Lesion coordinates are world (RAS) mm from the NIfTI affine, plus the matching T2W voxel indices. You can compare them directly with your ground-truth masks.

**Backups:** copy `data/reader_study.sqlite3` (for example, a nightly cron job copying it to a network share). This file holds all the annotations.

## 6. Viewer controls

| Action | Mouse / key |
|---|---|
| Change slice | scroll wheel, ↑/↓, or the slider in the view bar |
| Window/level | left-drag (← → contrast, ↑ ↓ brightness) |
| Zoom | right-drag, or Ctrl/Cmd + scroll, or trackpad pinch |
| Pan | middle-drag, or Shift + left-drag |
| Crosshair | C to show; Shift + move the mouse to position it |
| Place lesion | P (or the toolbar button), then click; drag the point to move it |
| Maximize a view | double-click it, or the ⤢ button |
| Reset view | R |

## 7. Configuration (`config.yaml`)

| Key | Meaning |
|---|---|
| `study.signup_code` | code readers need to create an account (`""` = anyone on the network) |
| `study.randomize_order` | random case order per reader |
| `study.two_stage_read` | hide PSA/volume until the image-only read is submitted |
| `study.lesion_scores`, `max_lesions` | allowed lesion scores, lesions per case |
| `study.allow_edit_after_submit` | let readers change submitted cases |
| `study.idle_timeout_seconds` | the reading-time clock pauses after this much inactivity |
| `server.port` | default 8000 |

## Project layout

```
app/main.py        web API and pages          app/reads.py    worklist, autosave, 2-stage logic
app/imaging.py     NIfTI loading/serving      app/sync.py     Supabase sync worker
app/auth.py        accounts, sessions         app/export.py   CSV/JSON export
app/static/        reader.html, admin.html, js/viewer.js (the slice viewer), js/reader.js
supabase/schema.sql   deploy/   tools/
```
