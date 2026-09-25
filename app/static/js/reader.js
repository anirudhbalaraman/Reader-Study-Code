import { api, esc, modal, toast } from "./api.js";
import { LAYOUTS, Viewer } from "./viewer.js";

const $ = (s, el = document) => el.querySelector(s);
const LESION_COLORS = ["#ff5a4f", "#46c2ff", "#ffd23f", "#8cff66", "#ff7ce6", "#ffa640"];
const ZONES = [["", "–"], ["PZ", "PZ"], ["TZ", "TZ"], ["CZ", "CZ"], ["AFS", "AFS"]];
const LEVELS = [["", "–"], ["base", "Base"], ["mid", "Mid"], ["apex", "Apex"]];
const SIDES = [["", "–"], ["R", "Right"], ["L", "Left"]];

const S = {
  study: null,
  me: null,
  worklist: [],
  caseId: null,
  read: null,          // server state for the open case
  ann: null,           // annotation being edited
  selected: null,      // selected lesion id
  pendingElapsed: 0,
  lastActivity: Date.now(),
  saveTimer: 0,
  saving: false,
  dirty: false,
  collapsed: JSON.parse(safeGet("rs_collapsed") || '{"help":true}'),
};

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ------------------------------------------------------------- viewer ----
const viewer = new Viewer($("#views"), {
  onPlace: (ras, volKey) => addLesion(ras, volKey),
  onLesionSelect: (id) => selectLesion(id, false),
  onLesionMove: (id, ras, volKey) => {
    const l = S.ann.lesions.find((x) => x.id === id);
    if (!l) return;
    l.ras = ras.map((v) => +v.toFixed(2));
    l.ijk_t2 = t2ijk(l.ras);
    l.placed_on = volKey;
    viewer.requestRender();
  },
  onLesionMoveEnd: () => changed(),
  onProbe: renderProbe,
  onModeChange: renderMode,
  onCrosshair: (on) => $("#tb-cross").classList.toggle("active", on),
});
viewer.getLesions = () => (S.ann?.lesions || []).map((l) => ({
  id: l.id, ras: l.ras, color: lesionColor(l.id), selected: l.id === S.selected,
  label: l.pirads ? `${l.id} (${l.pirads})` : l.id,
}));

const lesionColor = (id) => LESION_COLORS[(parseInt(id.slice(1), 10) - 1) % LESION_COLORS.length];
const t2ijk = (ras) => viewer.worldToIjk("t2w", ras).map((v) => +v.toFixed(2));
const editable = () => S.read && !S.read.locked && S.read.status !== "completed";

// ------------------------------------------------------------ toolbar ----
function initToolbar() {
  const sel = $("#tb-layout");
  for (const [k, L] of Object.entries(LAYOUTS)) sel.add(new Option(L.name, k));
  sel.value = safeGet("rs_layout") in LAYOUTS ? safeGet("rs_layout") : "bpmri";
  sel.onchange = () => { viewer.setLayout(sel.value); safeSet("rs_layout", sel.value); renderPanel(); };
  viewer.setLayout(sel.value);

  $("#tb-wl").onclick = () => viewer.setMode("wl");
  $("#tb-pan").onclick = () => viewer.setMode("pan");
  $("#tb-zoom").onclick = () => viewer.setMode("zoom");
  $("#tb-place").onclick = () => { if (editable()) viewer.setMode(viewer.mode === "place" ? "wl" : "place"); };
  $("#tb-cross").onclick = () => {
    viewer.crosshair = !viewer.crosshair;
    $("#tb-cross").classList.toggle("active", viewer.crosshair);
    viewer.requestRender();
    renderPanel();
  };
  $("#tb-link").onclick = () => {
    viewer.setLinked(!viewer.linked);
    $("#tb-link").classList.toggle("active", viewer.linked);
    renderPanel();
  };
  $("#tb-reset").onclick = () => viewer.resetViews(false);

  $("#menu-worklist").onclick = showWorklist;
  $("#menu-help").onclick = () => modal({ title: "Help", html: helpHtml() });
  $("#menu-logout").onclick = async () => { await flushSave(); await api("/api/logout", { method: "POST" }); location.href = "/"; };
  $("#menu-password").onclick = changePassword;
}

function renderMode(m) {
  for (const [id, mode] of [["#tb-wl", "wl"], ["#tb-pan", "pan"], ["#tb-zoom", "zoom"], ["#tb-place", "place"]]) {
    $(id).classList.toggle("active", m === mode);
  }
  $("#status-mode").textContent = "Mode: " + { wl: "Window/Level", pan: "Pan", zoom: "Zoom", place: "Place lesion - click in a view" }[m];
  const pb = $("#btn-place");
  if (pb) pb.classList.toggle("primary", m === "place");
}

// -------------------------------------------------------------- cases ----
async function loadWorklist() {
  S.worklist = await api("/api/worklist");
}

function nextOpenCase(afterId = null) {
  const wl = S.worklist;
  const start = afterId ? wl.findIndex((w) => w.case_id === afterId) + 1 : 0;
  for (let i = 0; i < wl.length; i++) {
    const w = wl[(start + i) % wl.length];
    if (w.status !== "completed") return w.case_id;
  }
  return null;
}

async function openCase(caseId) {
  if (!caseId) return;
  await flushSave();
  S.caseId = caseId;
  history.replaceState(null, "", "#" + encodeURIComponent(caseId));
  $("#views").style.opacity = 0.5;
  try {
    const st = await api(`/api/cases/${encodeURIComponent(caseId)}`);
    S.read = st;
    S.ann = structuredClone(st.annotation);
    S.selected = null;
    S.pendingElapsed = 0;
    S.lastActivity = Date.now();
    viewer.editable = editable();
    viewer.setMode("wl");
    renderPanel();
    renderStatus();
    const urls = {};
    for (const k of Object.keys(st.volumes)) urls[k] = `/api/cases/${encodeURIComponent(caseId)}/volume/${k}`;
    $("#views").style.opacity = 1;
    await viewer.loadCase(st.volumes, urls);
    renderPanel();
    prefetchNext();
  } catch (e) {
    $("#views").style.opacity = 1;
    toast(e.message, true, 6000);
  }
}

function prefetchNext() {
  // warm the server + browser cache for the next case in the list
  const next = nextOpenCase(S.caseId);
  if (!next || next === S.caseId) return;
  for (const k of ["t2w", "dwi", "adc"]) {
    fetch(`/api/cases/${encodeURIComponent(next)}/volume/${k}?frame=-1`, { credentials: "same-origin" }).catch(() => {});
  }
}

function caseIndex() { return S.worklist.findIndex((w) => w.case_id === S.caseId); }
function go(delta) {
  const i = caseIndex() + delta;
  if (i >= 0 && i < S.worklist.length) openCase(S.worklist[i].case_id);
}

// ------------------------------------------------------------ lesions ----
function addLesion(ras, volKey) {
  if (!editable()) return;
  if (S.ann.lesions.length >= S.study.max_lesions) {
    toast(`At most ${S.study.max_lesions} lesions per case.`, true);
    viewer.setMode("wl");
    return;
  }
  const used = new Set(S.ann.lesions.map((l) => l.id));
  let n = 1;
  while (used.has("L" + n)) n++;
  const l = {
    id: "L" + n, pirads: null, zone: "", level: "", side: "", comment: "",
    ras: ras.map((v) => +v.toFixed(2)), ijk_t2: t2ijk(ras), placed_on: volKey,
  };
  S.ann.lesions.push(l);
  S.ann.lesions.sort((a, b) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1)));
  S.selected = l.id;
  viewer.setMode("wl");
  changed(true);
}

function deleteLesion(id) {
  S.ann.lesions = S.ann.lesions.filter((l) => l.id !== id);
  if (S.selected === id) S.selected = null;
  changed(true);
}

function selectLesion(id, jump = true) {
  S.selected = id;
  const l = S.ann.lesions.find((x) => x.id === id);
  if (l && jump) viewer.centerOn(l.ras);
  viewer.requestRender();
  renderPanel();
}

// --------------------------------------------------------------- save ----
function changed(rerender = false) {
  S.dirty = true;
  S.lastActivity = Date.now();
  if (rerender) renderPanel(); else renderOverall();
  viewer.requestRender();
  setSaveState("busy", "Unsaved changes…");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 700);
}

async function saveNow() {
  clearTimeout(S.saveTimer);
  if (!S.caseId || !editable() || S.saving) return;
  if (!S.dirty && S.pendingElapsed < 1) return;
  S.saving = true;
  const elapsed = S.pendingElapsed;
  const wasDirty = S.dirty;
  S.dirty = false;
  S.pendingElapsed = 0;
  setSaveState("busy", "Saving…");
  try {
    await api(`/api/reads/${encodeURIComponent(S.caseId)}`, {
      method: "PUT", body: { annotation: S.ann, elapsed_seconds: elapsed },
    });
    setSaveState("ok", "All changes saved " + new Date().toLocaleTimeString());
  } catch (e) {
    S.dirty = S.dirty || wasDirty;
    S.pendingElapsed += elapsed;
    setSaveState("err", "NOT SAVED - " + e.message + " (retrying)");
    S.saveTimer = setTimeout(saveNow, 5000);
  } finally {
    S.saving = false;
  }
}

async function flushSave() {
  while (S.saving) await new Promise((r) => setTimeout(r, 100));
  await saveNow();
}

function setSaveState(cls, text) {
  const el = $("#save-state");
  el.className = "save-state " + cls;
  el.textContent = text;
}

// reading-time: counts only while the tab is visible and the reader is active
function startTimer() {
  const bump = () => { S.lastActivity = Date.now(); };
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) window.addEventListener(ev, bump, { passive: true });
  setInterval(() => {
    if (!editable() || document.hidden || !S.study.record_reading_time) return;
    if (Date.now() - S.lastActivity > S.study.idle_timeout_seconds * 1000) return;
    S.pendingElapsed += 1;
  }, 1000);
  setInterval(() => { if (S.pendingElapsed >= 15 && !S.dirty) saveNow(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });
  window.addEventListener("beforeunload", (e) => {
    if (!editable() || (!S.dirty && S.pendingElapsed < 1)) return;
    fetch(`/api/reads/${encodeURIComponent(S.caseId)}`, {
      method: "PUT", keepalive: true, credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotation: S.ann, elapsed_seconds: S.pendingElapsed }),
    });
    if (S.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

// ------------------------------------------------------------- submit ----
function validationError() {
  const allowed = S.study.lesion_scores;
  for (const l of S.ann.lesions) if (!allowed.includes(l.pirads)) return `Choose a PI-RADS score for lesion ${l.id}.`;
  if (!S.ann.lesions.length && ![1, 2].includes(S.ann.overall_pirads)) {
    return "No lesion is marked. Choose an overall PI-RADS of 1 or 2, or place a lesion point.";
  }
  return null;
}

async function submit() {
  const err = validationError();
  if (err) { toast(err, true, 5000); return; }
  const stage1 = S.study.two_stage_read && S.read.stage === 1;
  const score = overallScore();
  const ok = await modal({
    title: stage1 ? "Submit image-only read" : "Submit final read",
    html: `<p>Overall PI-RADS <b>${score}</b> with <b>${S.ann.lesions.length}</b> lesion(s).</p>` + (stage1
      ? "<p>The image-only read is then frozen. PSA and prostate volume will be shown, and you can revise your assessment for the final read.</p>"
      : "<p>After submitting you cannot change this case any more.</p>"),
    buttons: [{ label: "Cancel", value: false }, { label: stage1 ? "Submit and show clinical data" : "Submit final read", value: true, cls: "primary" }],
  });
  if (!ok) return;
  clearTimeout(S.saveTimer);
  while (S.saving) await new Promise((r) => setTimeout(r, 100));
  try {
    const elapsed = S.pendingElapsed;
    S.pendingElapsed = 0;
    const st = await api(`/api/reads/${encodeURIComponent(S.caseId)}/submit`, {
      method: "POST", body: { annotation: S.ann, elapsed_seconds: elapsed },
    });
    S.dirty = false;
    Object.assign(S.read, st);
    S.ann = structuredClone(st.annotation);
    await loadWorklist();
    viewer.editable = editable();
    setSaveState("ok", "Submitted " + new Date().toLocaleTimeString());
    if (st.status === "completed") {
      const next = nextOpenCase(S.caseId);
      if (next) {
        toast("Case submitted. Opening the next case…");
        setTimeout(() => openCase(next), 600);
      } else {
        renderPanel();
        modal({ title: "All cases done", html: "<p>You have completed every case in this study. Thank you!</p>" });
      }
    } else {
      toast("Image-only read saved. Clinical information is now shown.");
      renderPanel();
      $("#module").scrollTop = 0;
    }
    renderStatus();
  } catch (e) {
    toast(e.message, true, 6000);
  }
}

function overallScore() {
  const scores = S.ann.lesions.map((l) => l.pirads).filter(Boolean);
  if (S.ann.lesions.length) return scores.length === S.ann.lesions.length ? Math.max(...scores) : "–";
  return S.ann.overall_pirads || "–";
}

// -------------------------------------------------------------- panel ----
function section(key, title, bodyHtml, badge = "") {
  const c = S.collapsed[key] ? " collapsed" : "";
  return `<div class="section${c}" data-sec="${key}">
    <button class="section-head" type="button">${esc(title)}${badge ? `<span class="badge">${badge}</span>` : ""}</button>
    <div class="section-body">${bodyHtml}</div></div>`;
}

function statusChip(read) {
  if (!read) return "";
  if (read.status === "completed") return `<span class="chip done">Completed</span>`;
  if (S.study.two_stage_read && read.stage === 2) return `<span class="chip s2">Stage 2 · with clinical data</span>`;
  return S.study.two_stage_read ? `<span class="chip s1">Stage 1 · images only</span>` : `<span class="chip s1">In progress</span>`;
}

function renderPanel() {
  const m = $("#module");
  if (!S.read) { m.innerHTML = `<div class="muted" style="padding:10px">No case open.</div>`; return; }
  const done = S.worklist.filter((w) => w.status === "completed").length;
  const total = S.worklist.length;
  const idx = caseIndex();
  const ed = editable();
  const dis = ed ? "" : "disabled";

  // Case
  let html = section("case", "Case", `
    <div class="row"><span class="lbl">Case</span><b>${idx + 1} of ${total}</b>&nbsp;<span class="muted">(${esc(S.caseId)})</span></div>
    <div class="row"><span class="lbl">Status</span>${statusChip(S.read)}</div>
    <div class="row"><span class="lbl">Your progress</span><span>${done} / ${total} completed</span></div>
    <div class="progress" style="margin-bottom:8px"><div style="width:${total ? (100 * done / total) : 0}%"></div></div>
    <div class="row">
      <button class="btn small" id="btn-prev" ${idx <= 0 ? "disabled" : ""}>&#9664; Previous</button>
      <button class="btn small" id="btn-list" style="flex:1">Worklist…</button>
      <button class="btn small" id="btn-next" ${idx >= total - 1 ? "disabled" : ""}>Next &#9654;</button>
    </div>`);

  // Clinical
  const c = S.read.clinical;
  const lockSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
  const clin = c
    ? `<div class="kv">
        <span class="k">PSA</span><span class="v">${c.psa ?? "n/a"}${c.psa != null ? " ng/ml" : ""}</span>
        <span class="k">Prostate volume</span><span class="v">${c.prostate_volume ?? "n/a"}${c.prostate_volume != null ? " ml" : ""}</span>
        <span class="k">PSA density</span><span class="v">${c.psa_density ?? "n/a"}${c.psa_density != null ? " ng/ml²" : ""}</span>
      </div>`
    : `<div class="locked-box">${lockSvg}<span>Hidden during the image-only read. Shown after you submit stage 1.</span></div>`;
  html += section("clinical", "Clinical information", clin);

  // Stage-1 summary (stage 2)
  let s1 = "";
  if (S.read.stage1 && S.study.two_stage_read) {
    const a = S.read.stage1;
    const sc = a.lesions.length ? Math.max(...a.lesions.map((l) => l.pirads || 0)) : a.overall_pirads;
    s1 = `<div class="stage-note s2">Your image-only read: <b>PI-RADS ${sc}</b>, ${a.lesions.length} lesion(s)${a.lesions.length ? " (" + a.lesions.map((l) => `${l.id}: ${l.pirads}`).join(", ") + ")" : ""}. You may now revise it.</div>`;
  }

  // Lesions
  const lesions = S.ann.lesions.map((l) => lesionCard(l, ed)).join("");
  html += section("lesions", "Lesions", `
    ${s1}
    <div class="row">
      <button class="btn block ${viewer.mode === "place" ? "primary" : ""}" id="btn-place" ${dis || (S.ann.lesions.length >= S.study.max_lesions ? "disabled" : "")}>
        + Place lesion point
      </button>
    </div>
    <div class="muted small" style="margin-bottom:6px">Click the button (or press P), then click on the lesion in any view. Drag a point to move it.</div>
    ${lesions || `<div class="muted small center" style="padding:6px">No lesions marked.</div>`}`,
    `<span class="muted">${S.ann.lesions.length}/${S.study.max_lesions}</span>`);

  // Assessment
  html += section("assess", "Assessment", `
    <div id="overall"></div>
    <div style="margin-top:8px"><span class="muted small">Comment (optional)</span>
      <textarea id="case-comment" rows="2" ${dis}>${esc(S.ann.comment || "")}</textarea></div>
    <div style="margin-top:10px" id="submit-area"></div>`);

  // Display
  const dwi = viewer.volumes?.dwi;
  let frameSel = "";
  if (dwi && dwi.meta.frames > 1) {
    frameSel = `<div class="row"><span class="lbl">DWI volume</span><select id="dwi-frame">${
      Array.from({ length: dwi.meta.frames }, (_, i) => `<option value="${i}" ${i === dwi.frame ? "selected" : ""}>${i + 1} of ${dwi.meta.frames}${i === dwi.meta.default_frame ? " (default, highest b)" : ""}</option>`).join("")
    }</select></div>`;
  }
  html += section("display", "Display", `
    ${frameSel}
    <label class="chk" style="margin-bottom:5px"><input type="checkbox" id="opt-interp" ${viewer.interpolate ? "checked" : ""}> Interpolate (smooth) images</label>
    <label class="chk" style="margin-bottom:5px"><input type="checkbox" id="opt-cross" ${viewer.crosshair ? "checked" : ""}> Show crosshair (Shift + move mouse)</label>
    <label class="chk" style="margin-bottom:8px"><input type="checkbox" id="opt-link" ${viewer.linked ? "checked" : ""}> Link views</label>
    <div class="row"><button class="btn small" id="btn-autowl">Auto window/level</button><button class="btn small" id="btn-resetview">Reset field of view</button></div>`);

  html += section("help", "Help", helpHtml());
  m.innerHTML = html;

  // wire up
  m.querySelectorAll(".section-head").forEach((h) => (h.onclick = () => {
    const sec = h.parentElement, key = sec.dataset.sec;
    sec.classList.toggle("collapsed");
    S.collapsed[key] = sec.classList.contains("collapsed");
    safeSet("rs_collapsed", JSON.stringify(S.collapsed));
  }));
  $("#btn-prev").onclick = () => go(-1);
  $("#btn-next").onclick = () => go(1);
  $("#btn-list").onclick = showWorklist;
  $("#btn-place").onclick = () => viewer.setMode(viewer.mode === "place" ? "wl" : "place");
  $("#case-comment").oninput = (e) => { S.ann.comment = e.target.value; changed(); };
  $("#opt-interp").onchange = (e) => { viewer.interpolate = e.target.checked; viewer.requestRender(); };
  $("#opt-cross").onchange = (e) => { viewer.crosshair = e.target.checked; $("#tb-cross").classList.toggle("active", viewer.crosshair); viewer.requestRender(); };
  $("#opt-link").onchange = (e) => { viewer.setLinked(e.target.checked); $("#tb-link").classList.toggle("active", viewer.linked); };
  $("#btn-autowl").onclick = () => { Object.values(viewer.volumes || {}).forEach((v) => v.resetWL()); viewer.requestRender(); };
  $("#btn-resetview").onclick = () => viewer.resetViews(false);
  const fs = $("#dwi-frame");
  if (fs) fs.onchange = () => viewer.setFrame("dwi", +fs.value);

  m.querySelectorAll(".lesion").forEach((card) => wireLesion(card));
  renderOverall();
}

function lesionCard(l, ed) {
  const dis = ed ? "" : "disabled";
  const opts = (list, v) => list.map(([k, t]) => `<option value="${k}" ${k === v ? "selected" : ""}>${t}</option>`).join("");
  const scores = S.study.lesion_scores.map((s) => `<button type="button" data-score="${s}" class="${l.pirads === s ? "on" : ""}" ${dis}>${s}</button>`).join("");
  const col = lesionColor(l.id);
  return `<div class="lesion ${l.id === S.selected ? "selected" : ""}" data-id="${l.id}">
    <div class="lhead">
      <span class="dot" style="border-color:${col}"></span>
      <span class="name">${l.id}</span>
      <span class="muted small grow">on ${esc((l.placed_on || "").toUpperCase())}</span>
      <button class="btn small" data-act="jump" title="Show this lesion in all views">Go to</button>
      ${ed ? `<button class="btn small" data-act="del" title="Delete lesion">&#10005;</button>` : ""}
    </div>
    <div class="muted small" style="margin-bottom:3px">PI-RADS</div>
    <div class="pirads-pick">${scores}</div>
    <div class="grid" style="grid-template-columns:repeat(3,1fr);margin-top:6px">
      <label>Zone<select data-f="zone" ${dis}>${opts(ZONES, l.zone)}</select></label>
      <label>Level<select data-f="level" ${dis}>${opts(LEVELS, l.level)}</select></label>
      <label>Side<select data-f="side" ${dis}>${opts(SIDES, l.side)}</select></label>
    </div>
    <input class="comment" type="text" data-f="comment" placeholder="Lesion comment (optional)" value="${esc(l.comment)}" ${dis}>
  </div>`;
}

function wireLesion(card) {
  const id = card.dataset.id;
  const l = () => S.ann.lesions.find((x) => x.id === id);
  card.addEventListener("mousedown", (e) => {
    if (e.target.closest("button,select,input")) return;
    selectLesion(id, true);
  });
  card.querySelector("[data-act=jump]").onclick = () => selectLesion(id, true);
  const del = card.querySelector("[data-act=del]");
  if (del) del.onclick = async () => {
    const ok = await modal({ title: "Delete lesion", html: `<p>Delete lesion ${id}?</p>`,
      buttons: [{ label: "Cancel", value: false }, { label: "Delete", value: true, cls: "danger" }] });
    if (ok) deleteLesion(id);
  };
  card.querySelectorAll("[data-score]").forEach((b) => (b.onclick = () => {
    l().pirads = +b.dataset.score;
    card.querySelectorAll("[data-score]").forEach((x) => x.classList.toggle("on", x === b));
    S.selected = id;
    changed();
  }));
  card.querySelectorAll("select[data-f], input[data-f]").forEach((el) => (el.oninput = () => {
    l()[el.dataset.f] = el.value;
    changed();
  }));
}

function renderOverall() {
  const box = $("#overall");
  if (!box) return;
  const ed = editable();
  if (S.ann.lesions.length) {
    box.innerHTML = `<div class="overall"><span class="score">${overallScore()}</span>
      <span class="muted small">Overall PI-RADS = highest lesion score</span></div>`;
  } else {
    const pick = [1, 2].map((s) => `<button type="button" data-ov="${s}" class="${S.ann.overall_pirads === s ? "on" : ""}" ${ed ? "" : "disabled"}>${s}</button>`).join("");
    box.innerHTML = `<div class="muted small" style="margin-bottom:4px">No lesion marked. Overall PI-RADS:</div>
      <div class="pirads-pick" style="max-width:140px">${pick}</div>`;
    box.querySelectorAll("[data-ov]").forEach((b) => (b.onclick = () => { S.ann.overall_pirads = +b.dataset.ov; changed(); }));
  }
  // viewer labels show scores
  viewer.requestRender();
  renderSubmit();
}

function renderSubmit() {
  const area = $("#submit-area");
  if (!area) return;
  const r = S.read;
  if (r.status === "completed") {
    const next = nextOpenCase(S.caseId);
    area.innerHTML = `<div class="stage-note done">This case is submitted and read-only.</div>
      ${next ? `<button class="btn primary block" id="btn-gonext">Go to next open case &#9654;</button>` : `<div class="muted">All cases completed.</div>`}`;
    const b = $("#btn-gonext");
    if (b) b.onclick = () => openCase(next);
    return;
  }
  const stage1 = S.study.two_stage_read && r.stage === 1;
  const err = validationError();
  area.innerHTML = `
    <div class="stage-note ${stage1 ? "" : "s2"}">${stage1
      ? "<b>Stage 1 - image-only read.</b> Mark and score lesions using the images only. PSA and prostate volume are shown after you submit."
      : S.study.two_stage_read ? "<b>Stage 2 - final read.</b> PSA and volume are shown. Revise if needed, then submit." : "Mark and score lesions, then submit."}</div>
    <button class="btn ${err ? "" : "success"} block" id="btn-submit" title="${esc(err || "")}">${stage1 ? "Submit image-only read" : "Submit final read"}</button>
    ${err ? `<div class="muted small" style="margin-top:4px">${esc(err)}</div>` : ""}`;
  $("#btn-submit").onclick = submit;
}

function renderStatus() {
  const i = caseIndex();
  $("#status-case").textContent = S.caseId ? `Case ${i + 1}/${S.worklist.length} · ${S.caseId}` : "";
}

function renderProbe(p) {
  const el = $("#probe");
  if (!p) { el.innerHTML = `<div class="dp-title">Data Probe</div><div class="muted">Move the mouse over a view.</div>`; return; }
  const r = p.ras;
  const f = (v) => (v >= 0 ? " " : "") + v.toFixed(1);
  const lr = (v) => `${v >= 0 ? "R" : "L"} ${Math.abs(v).toFixed(1)}`;
  const ap = (v) => `${v >= 0 ? "A" : "P"} ${Math.abs(v).toFixed(1)}`;
  const si = (v) => `${v >= 0 ? "S" : "I"} ${Math.abs(v).toFixed(1)}`;
  const rows = p.values.map((v) => {
    const val = v.value == null ? "out of volume" : Math.abs(v.value) >= 100 ? v.value.toFixed(0) : v.value.toFixed(2);
    return `<tr><td>${esc(v.label.split(" ")[0])}</td><td>(${v.ijk ? v.ijk.join(", ") : ""})</td><td><b>${val}</b></td></tr>`;
  }).join("");
  el.innerHTML = `<div class="dp-title"><span class="dp-view" style="background:${p.color}"></span>${p.view} · ${p.orientation}</div>
    <div>(${lr(r[0])}, ${ap(r[1])}, ${si(r[2])}) mm</div>
    <table>${rows}</table>`;
  void f;
}

// ----------------------------------------------------------- dialogs ----
async function showWorklist() {
  await loadWorklist().catch(() => {});
  const chip = (w) => w.status === "completed" ? `<span class="chip done">Completed</span>`
    : w.status === "in_progress" ? (w.stage === 2 && S.study.two_stage_read ? `<span class="chip s2">Stage 2</span>` : `<span class="chip s1">In progress</span>`)
    : `<span class="chip new">Not started</span>`;
  const rows = S.worklist.map((w) => `<tr class="clickable ${w.case_id === S.caseId ? "current" : ""}" data-id="${esc(w.case_id)}">
    <td>${w.index}</td><td>${esc(w.case_id)}</td><td>${chip(w)}</td></tr>`).join("");
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div style="max-height:60vh;overflow:auto"><table class="list"><tr><th>#</th><th>Case</th><th>Status</th></tr>${rows}</table></div>`;
  let chosen = null;
  wrap.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => { chosen = tr.dataset.id; document.querySelector(".modal-back .mfoot button")?.click(); }));
  await modal({ title: `Worklist · ${S.worklist.filter((w) => w.status === "completed").length}/${S.worklist.length} completed`, html: wrap, buttons: [{ label: "Close", value: null }] });
  if (chosen && chosen !== S.caseId) openCase(chosen);
}

async function changePassword() {
  const form = document.createElement("div");
  form.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;min-width:280px">
    <label>Current password<br><input type="password" id="pw-old" style="width:100%"></label>
    <label>New password (min. 6)<br><input type="password" id="pw-new" style="width:100%"></label></div>`;
  const ok = await modal({ title: "Change password", html: form, buttons: [{ label: "Cancel", value: false }, { label: "Change", value: true, cls: "primary" }] });
  if (!ok) return;
  try {
    await api("/api/me/password", { method: "POST", body: { old_password: form.querySelector("#pw-old").value, new_password: form.querySelector("#pw-new").value } });
    toast("Password changed.");
  } catch (e) { toast(e.message, true); }
}

function helpHtml() {
  return `<table class="list small">
    <tr><td>Scroll wheel / ↑ ↓</td><td>Change slice</td></tr>
    <tr><td>Left-drag</td><td>Window / level (← → contrast, ↑ ↓ brightness)</td></tr>
    <tr><td>Right-drag, Ctrl/Cmd + scroll</td><td>Zoom</td></tr>
    <tr><td>Middle-drag, Shift + left-drag</td><td>Pan</td></tr>
    <tr><td>Shift + move mouse</td><td>Move crosshair / link position</td></tr>
    <tr><td>Double-click view</td><td>Maximize / restore</td></tr>
    <tr><td>P</td><td>Place lesion point</td></tr>
    <tr><td>Esc</td><td>Back to window/level mode</td></tr>
    <tr><td>C</td><td>Toggle crosshair</td></tr>
    <tr><td>R</td><td>Reset field of view</td></tr>
  </table>
  <p class="muted small">Each view's colored bar lets you pick orientation and sequence. Views are linked: scrolling one moves the others to the same position.
  Everything you do is saved automatically - you can log out at any time and continue later.</p>`;
}

// -------------------------------------------------------------- start ----
async function main() {
  try {
    [S.study, S.me] = await Promise.all([api("/api/study"), api("/api/me")]);
  } catch { return; }
  document.title = S.study.title;
  $("#study-title").textContent = S.study.title;
  $("#user-name").textContent = S.me.full_name ? `${S.me.full_name} (${S.me.username})` : S.me.username;
  $("#menu-admin").hidden = !S.me.is_admin;
  initToolbar();
  startTimer();
  await loadWorklist();
  if (!S.worklist.length) {
    $("#module").innerHTML = `<div style="padding:12px">No cases are available yet. Please contact the study coordinator.</div>`;
    return;
  }
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const first = S.worklist.some((w) => w.case_id === fromHash) ? fromHash : nextOpenCase() || S.worklist[0].case_id;
  await openCase(first);
}
main();
