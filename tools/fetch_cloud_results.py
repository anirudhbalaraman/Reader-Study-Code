"""Check progress and download the results from Supabase - run this anywhere (e.g. on your laptop).

    export SUPABASE_URL=https://YOUR-PROJECT.supabase.co
    export SUPABASE_SERVICE_KEY=sb_secret_...     # same secret key as on the clinic PC
    python3 tools/fetch_cloud_results.py          # prints progress, writes cloud_cases.csv + cloud_lesions.csv

Only uses the Python standard library.
"""
import collections
import csv
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not URL or not KEY:
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY first (see the top of this file).")


def get(path):
    headers = {"apikey": KEY}
    if KEY.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {KEY}"
    rows, offset = [], 0
    while True:   # page through results (the API returns at most 1000 rows per request)
        req = urllib.request.Request(f"{URL}/rest/v1/{path}&limit=1000&offset={offset}", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                page = json.loads(r.read())
        except urllib.error.HTTPError as e:
            sys.exit(f"Supabase error {e.code}: {e.read().decode()[:300]}")
        rows += page
        if len(page) < 1000:
            return rows
        offset += 1000


def write(name, rows):
    with open(name, "w", newline="") as fh:
        if rows:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow({k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in r.items()})
    print(f"wrote {name} ({len(rows)} rows)")


cases = get("pirads_reads?select=study_id,reader,case_id,status,stage,image_only_pirads,final_pirads,"
            "stage1_seconds,stage2_seconds,started_at,stage1_submitted_at,completed_at,updated_at&order=reader,case_id")

# progress summary
per = collections.defaultdict(collections.Counter)
last = {}
for r in cases:
    per[r["reader"]][r["status"]] += 1
    last[r["reader"]] = max(last.get(r["reader"], ""), r["updated_at"] or "")
print(f"\n{'reader':<20}{'completed':>10}{'in progress':>13}   last activity (UTC)")
for reader in sorted(per):
    c = per[reader]
    print(f"{reader:<20}{c['completed']:>10}{c['in_progress']:>13}   {last[reader][:16].replace('T', ' ')}")
print()

write("cloud_cases.csv", cases)
write("cloud_lesions.csv", get("pirads_lesions?select=*&order=reader,case_id,read_stage,lesion"))
