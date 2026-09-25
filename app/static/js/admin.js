import { api, esc, modal, toast } from "./api.js";

const $ = (s) => document.querySelector(s);
const t = (iso) => (iso ? new Date(iso).toLocaleString() : "–");

async function load() {
  let d;
  try { d = await api("/api/admin/overview"); } catch (e) {
    document.querySelector(".admin").innerHTML = `<p>${esc(e.message)}</p><p><a href="/reader">Back to reader</a></p>`;
    return;
  }
  document.title = d.study.title + " - Admin";
  $("#title").textContent = d.study.title + " · Admin";
  const complete = d.cases.filter((c) => c.complete);
  const readers = d.readers.filter((r) => !r.is_admin || r.completed || r.in_progress);
  const totalDone = d.readers.reduce((a, r) => a + r.completed, 0);

  $("#cards").innerHTML = [
    ["Cases ready", complete.length, `${d.cases.length - complete.length} incomplete folders`],
    ["Readers", readers.length, `${d.readers.length} accounts`],
    ["Reads completed", totalDone, `of ${complete.length * readers.length} planned`],
    ["Cloud sync", d.sync.enabled ? (d.sync.last_error ? "Error" : "On") : "Off", d.sync.enabled ? `last OK ${t(d.sync.last_ok)}` : "local only"],
  ].map(([k, n, s]) => `<div class="card"><div class="muted small">${k}</div><div class="n">${n}</div><div class="muted small">${s}</div></div>`).join("");

  // sync
  const s = d.sync;
  $("#sync").innerHTML = s.enabled
    ? `<div class="kv"><span class="k">Last attempt</span><span>${t(s.last_attempt)}</span>
         <span class="k">Last success</span><span>${t(s.last_ok)}</span>
         <span class="k">Rows waiting</span><span>${s.pending_rows}</span>
         <span class="k">Last error</span><span style="color:var(--err)">${esc(s.last_error) || "–"}</span></div>
       <button class="btn small" id="sync-now" style="margin-top:8px">Sync now</button>`
    : `<span class="muted">${s.configured_but_missing_key ? "Enabled in config.yaml but no Supabase key is set." : "Disabled. Results are stored only on this PC (see README to enable)."}</span>`;
  const sn = $("#sync-now");
  if (sn) sn.onclick = async () => { sn.disabled = true; const r = await api("/api/admin/sync", { method: "POST" }); toast(r.result.error ? "Sync failed: " + r.result.error : `Synced ${r.result.pushed} row(s).`, !!r.result.error); load(); };

  // readers
  $("#readers").innerHTML = `<tr><th>Username</th><th>Name</th><th>Role</th><th>Completed</th><th>In progress</th><th>Reading time</th><th>Last activity</th><th></th></tr>` +
    d.readers.map((r) => `<tr>
      <td>${esc(r.username)}</td><td>${esc(r.full_name)}</td><td>${r.is_admin ? "admin" : "reader"}</td>
      <td>${r.completed} / ${r.total_cases}</td><td>${r.in_progress}</td><td>${r.reading_minutes} min</td>
      <td>${t(r.last_activity)}</td>
      <td><button class="btn small" data-pw="${r.id}" data-name="${esc(r.username)}">Set password</button>
          <button class="btn small" data-adm="${r.id}" data-on="${r.is_admin ? 0 : 1}">${r.is_admin ? "Remove admin" : "Make admin"}</button></td></tr>`).join("");
  document.querySelectorAll("[data-pw]").forEach((b) => (b.onclick = () => setPassword(b.dataset.pw, b.dataset.name)));
  document.querySelectorAll("[data-adm]").forEach((b) => (b.onclick = async () => {
    try { await api(`/api/admin/users/${b.dataset.adm}/admin`, { method: "POST", body: { is_admin: b.dataset.on === "1" } }); load(); }
    catch (e) { toast(e.message, true); }
  }));

  // matrix
  const status = {};
  for (const r of d.reads) status[`${r.user_id}|${r.case_id}`] = r;
  $("#matrix").innerHTML = `<tr><th>Case</th>${readers.map((r) => `<th class="c">${esc(r.username)}</th>`).join("")}</tr>` +
    complete.map((c) => `<tr><td>${esc(c.case_id)}</td>${readers.map((r) => {
      const st = status[`${r.id}|${c.case_id}`];
      const cls = st ? st.status : "";
      const title = st ? `${st.status}, stage ${st.stage}` : "not started";
      return `<td class="c"><span class="cell ${cls}" title="${title}" ${st ? `data-u="${r.id}" data-c="${esc(c.case_id)}" data-n="${esc(r.username)}" data-s="${st.status}" style="cursor:pointer"` : ""}></span></td>`;
    }).join("")}</tr>`).join("");
  document.querySelectorAll(".cell[data-u]").forEach((el) => (el.onclick = () => cellAction(el.dataset)));

  // cases
  $("#cases").innerHTML = `<tr><th>Case</th><th>T2W</th><th>DWI</th><th>ADC</th><th>PSA/volume</th></tr>` +
    d.cases.map((c) => `<tr><td>${esc(c.case_id)}</td>${["t2w", "dwi", "adc"].map((k) => `<td>${c.files[k] ? esc(c.files[k]) : '<span style="color:var(--err)">missing</span>'}</td>`).join("")}
      <td>${c.has_clinical ? "yes" : '<span style="color:var(--warn)">missing</span>'}</td></tr>`).join("");
}

async function setPassword(id, name) {
  const box = document.createElement("div");
  box.innerHTML = `<label>New password for <b>${esc(name)}</b> (min. 6)<br><input type="text" id="np" style="width:100%"></label>`;
  const ok = await modal({ title: "Set password", html: box, buttons: [{ label: "Cancel", value: false }, { label: "Set", value: true, cls: "primary" }] });
  if (!ok) return;
  try { await api(`/api/admin/users/${id}/password`, { method: "POST", body: { password: box.querySelector("#np").value } }); toast("Password set."); }
  catch (e) { toast(e.message, true); }
}

async function cellAction(ds) {
  const choice = await modal({
    title: `${ds.n} · ${ds.c}`,
    html: `<p>Status: <b>${ds.s}</b></p><p><b>Reopen</b> lets the reader change a submitted case again.<br><b>Reset</b> deletes this reader's annotation for the case completely.</p>`,
    buttons: [{ label: "Cancel", value: null }, { label: "Reset (delete)", value: "reset", cls: "danger" }, ...(ds.s === "completed" ? [{ label: "Reopen", value: "reopen", cls: "primary" }] : [])],
  });
  if (!choice) return;
  if (choice === "reset") {
    const sure = await modal({ title: "Really delete?", html: `<p>Delete ${esc(ds.n)}'s read of ${esc(ds.c)}? This cannot be undone.</p>`,
      buttons: [{ label: "Cancel", value: false }, { label: "Delete", value: true, cls: "danger" }] });
    if (!sure) return;
  }
  await api(`/api/admin/reads/${ds.u}/${encodeURIComponent(ds.c)}/${choice}`, { method: "POST" });
  toast(choice === "reset" ? "Read deleted." : "Case reopened.");
  load();
}

$("#refresh").onclick = load;
$("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "/"; };
load();
