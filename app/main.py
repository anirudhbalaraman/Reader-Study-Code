"""FastAPI application: pages, reader API, admin API."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import export, imaging, reads, sync
from .auth import (SESSION_COOKIE, SESSION_DAYS, admin_user, authenticate, create_session, create_user,
                   current_user, delete_session, set_password)
from .config import CONFIG, ROOT
from .db import db, init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
STATIC = ROOT / "app" / "static"
STUDY = CONFIG["study"]

@asynccontextmanager
async def lifespan(_app):
    init_db()
    sync.start_background_worker()
    logging.getLogger("app").info(
        "cases dir: %s (%d complete cases)", CONFIG["data"]["cases_dir"], len(imaging.case_ids())
    )
    yield


app = FastAPI(title=STUDY["title"], docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_cache_api(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/api/") and "volume" not in request.url.path:
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ---------------------------------------------------------------- pages ----
def _page(name):
    return FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
def index():
    return _page("index.html")


@app.get("/reader", include_in_schema=False)
def reader_page():
    return _page("reader.html")


@app.get("/admin", include_in_schema=False)
def admin_page():
    return _page("admin.html")


# ------------------------------------------------------------- accounts ----
def _login_response(user_id: int, is_admin: bool):
    token = create_session(user_id)
    resp = JSONResponse({"ok": True, "is_admin": bool(is_admin)})
    resp.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax")
    return resp


@app.get("/api/study")
def study_info():
    return {
        "title": STUDY["title"],
        "study_id": STUDY["id"],
        "signup_code_required": bool(STUDY["signup_code"]),
        "two_stage_read": STUDY["two_stage_read"],
        "record_reading_time": STUDY["record_reading_time"],
        "idle_timeout_seconds": STUDY["idle_timeout_seconds"],
        "lesion_scores": STUDY["lesion_scores"],
        "max_lesions": STUDY["max_lesions"],
        "allow_edit_after_submit": STUDY["allow_edit_after_submit"],
    }


@app.post("/api/signup")
def signup(payload: dict = Body(...)):
    if STUDY["signup_code"] and (payload.get("signup_code") or "").strip() != str(STUDY["signup_code"]):
        raise HTTPException(403, "Wrong study access code. Ask the study coordinator.")
    uid = create_user(
        (payload.get("username") or "").strip(), payload.get("password") or "", payload.get("full_name") or ""
    )
    return _login_response(uid, False)


@app.post("/api/login")
def login(payload: dict = Body(...)):
    user = authenticate((payload.get("username") or "").strip(), payload.get("password") or "")
    return _login_response(user["id"], user["is_admin"])


@app.post("/api/logout")
def logout(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        delete_session(token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.get("/api/session")
def session_check(request: Request):
    try:
        user = current_user(request.cookies.get(SESSION_COOKIE))
        return {"logged_in": True, "is_admin": bool(user["is_admin"])}
    except HTTPException:
        return {"logged_in": False}


@app.get("/api/me")
def me(user=Depends(current_user)):
    return {"username": user["username"], "full_name": user["full_name"], "is_admin": bool(user["is_admin"])}


@app.post("/api/me/password")
def change_password(payload: dict = Body(...), user=Depends(current_user)):
    authenticate(user["username"], payload.get("old_password") or "")
    set_password(user["id"], payload.get("new_password") or "")
    return _login_response(user["id"], user["is_admin"])


# --------------------------------------------------------------- reader ----
@app.get("/api/worklist")
def get_worklist(user=Depends(current_user)):
    return reads.worklist(user["id"])


@app.get("/api/cases/{case_id}")
def get_case(case_id: str, user=Depends(current_user)):
    state = reads.read_state(user["id"], case_id)
    try:
        state["volumes"] = {s: imaging.volume_meta(case_id, s) for s in imaging.SEQUENCES}
    except Exception as e:
        raise HTTPException(500, f"Could not load images for {case_id}: {e}")
    wl = reads.worklist(user["id"])
    idx = next((w["index"] for w in wl if w["case_id"] == case_id), None)
    state["position"] = {"index": idx, "total": len(wl)}
    return state


@app.get("/api/cases/{case_id}/volume/{seq}")
def get_volume(case_id: str, seq: str, frame: int = -1, user=Depends(current_user)):
    try:
        meta = imaging.volume_meta(case_id, seq)
        fr = meta["default_frame"] if frame < 0 else frame
        payload = imaging.volume_payload(case_id, seq, fr)
    except FileNotFoundError:
        raise HTTPException(404, "Volume not found.")
    return Response(
        payload,
        media_type="application/octet-stream",
        headers={"Content-Encoding": "gzip", "Cache-Control": "private, max-age=3600"},
    )


@app.put("/api/reads/{case_id}")
def save_read(case_id: str, payload: dict = Body(...), user=Depends(current_user)):
    if case_id not in imaging.case_ids():
        raise HTTPException(404, "Case not found.")
    return reads.autosave(user["id"], case_id, payload.get("annotation") or {}, payload.get("elapsed_seconds"))


@app.post("/api/reads/{case_id}/submit")
def submit_read(case_id: str, payload: dict = Body(...), user=Depends(current_user)):
    if case_id not in imaging.case_ids():
        raise HTTPException(404, "Case not found.")
    return reads.submit(user["id"], case_id, payload.get("annotation") or {}, payload.get("elapsed_seconds"))


# ---------------------------------------------------------------- admin ----
@app.get("/api/admin/overview")
def admin_overview(admin=Depends(admin_user)):
    cases = imaging.list_cases()
    clinical = imaging.clinical_table()
    for c in cases:
        c["has_clinical"] = c["case_id"] in clinical
    n_complete = sum(c["complete"] for c in cases)
    with db() as conn:
        users = conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()
        stats = {
            r["user_id"]: r
            for r in conn.execute(
                """SELECT user_id,
                          SUM(status = 'completed') AS completed,
                          SUM(status = 'in_progress') AS in_progress,
                          SUM(stage1_seconds + stage2_seconds) AS seconds,
                          MAX(updated_at) AS last_activity
                   FROM reads GROUP BY user_id"""
            ).fetchall()
        }
        reads_rows = conn.execute(
            "SELECT r.user_id, r.case_id, r.status, r.stage FROM reads r"
        ).fetchall()
    readers = []
    for u in users:
        s = stats.get(u["id"])
        readers.append({
            "id": u["id"], "username": u["username"], "full_name": u["full_name"],
            "is_admin": bool(u["is_admin"]),
            "created_at": export.iso(u["created_at"]), "last_seen": export.iso(u["last_seen"]),
            "completed": (s["completed"] or 0) if s else 0,
            "in_progress": (s["in_progress"] or 0) if s else 0,
            "total_cases": n_complete,
            "reading_minutes": round((s["seconds"] or 0) / 60, 1) if s else 0,
            "last_activity": export.iso(s["last_activity"]) if s else None,
        })
    return {
        "study": study_info(),
        "cases": cases,
        "readers": readers,
        "reads": [dict(r) for r in reads_rows],
        "sync": sync.status(),
    }


@app.post("/api/admin/users/{user_id}/password")
def admin_set_password(user_id: int, payload: dict = Body(...), admin=Depends(admin_user)):
    set_password(user_id, payload.get("password") or "")
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/admin")
def admin_set_admin(user_id: int, payload: dict = Body(...), admin=Depends(admin_user)):
    if user_id == admin["id"] and not payload.get("is_admin"):
        raise HTTPException(400, "You cannot remove your own admin rights.")
    with db() as conn:
        conn.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(bool(payload.get("is_admin"))), user_id))
    return {"ok": True}


@app.post("/api/admin/reads/{user_id}/{case_id}/reopen")
def admin_reopen(user_id: int, case_id: str, admin=Depends(admin_user)):
    reads.reopen(user_id, case_id)
    return {"ok": True}


@app.post("/api/admin/reads/{user_id}/{case_id}/reset")
def admin_reset(user_id: int, case_id: str, admin=Depends(admin_user)):
    with db() as conn:
        u = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
    reads.reset(user_id, case_id)
    if u and sync.enabled():
        sync.queue_delete(u["username"], case_id)
    return {"ok": True}


@app.post("/api/admin/sync")
def admin_sync(admin=Depends(admin_user)):
    return {"result": sync.sync_once(), "status": sync.status()}


def _download(text: str, filename: str, media: str = "text/csv"):
    return PlainTextResponse(text, media_type=media,
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/admin/export/cases.csv")
def export_cases(admin=Depends(admin_user)):
    return _download(export.cases_csv(), f"{STUDY['id']}_cases.csv")


@app.get("/api/admin/export/lesions.csv")
def export_lesions(admin=Depends(admin_user)):
    return _download(export.lesions_csv(), f"{STUDY['id']}_lesions.csv")


@app.get("/api/admin/export/all.json")
def export_json(admin=Depends(admin_user)):
    return _download(export.raw_json(), f"{STUDY['id']}_all.json", "application/json")


@app.exception_handler(401)
async def unauthorized(request: Request, exc):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": getattr(exc, "detail", "Not logged in.")}, status_code=401)
    return RedirectResponse("/")
