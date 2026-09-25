"""Download the results from Supabase to CSV files - run this anywhere (e.g. at home).

    export SUPABASE_URL=https://YOUR-PROJECT.supabase.co
    export SUPABASE_SERVICE_KEY=...        # same key as on the clinic PC
    python tools/fetch_cloud_results.py    # writes cloud_cases.csv and cloud_lesions.csv

Only uses the Python standard library.
"""
import csv
import json
import os
import urllib.request

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_KEY"]


def get(path):
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def write(name, rows):
    with open(name, "w", newline="") as fh:
        if rows:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow({k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in r.items()})
    print(f"{name}: {len(rows)} rows")


cases = get("pirads_reads?select=study_id,reader,case_id,status,stage,image_only_pirads,final_pirads,"
            "stage1_seconds,stage2_seconds,started_at,stage1_submitted_at,completed_at,updated_at&order=reader,case_id")
write("cloud_cases.csv", cases)
write("cloud_lesions.csv", get("pirads_lesions?select=*&order=reader,case_id,read_stage,lesion"))
