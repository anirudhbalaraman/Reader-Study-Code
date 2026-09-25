// Small fetch wrapper: JSON in/out, readable error messages, redirect to login on 401.
export async function api(path, { method = "GET", body, keepalive = false, redirect401 = true } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      keepalive,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error("Cannot reach the server. Check the network connection.");
    err.network = true;
    throw err;
  }
  if (res.status === 401 && redirect401 && !path.startsWith("/api/login")) {
    location.href = "/?next=" + encodeURIComponent(location.pathname + location.hash);
    throw new Error("Not logged in");
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof data === "object" ? (Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join(", ") : data.detail) : data;
    const err = new Error(msg || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(msg, isErr = false, ms = 3200) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function modal({ title, html, buttons = [{ label: "OK", value: true, cls: "primary" }] }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3></h3><div class="mbody"></div><div class="mfoot"></div></div>`;
    back.querySelector("h3").textContent = title;
    const body = back.querySelector(".mbody");
    if (typeof html === "string") body.innerHTML = html; else body.appendChild(html);
    const foot = back.querySelector(".mfoot");
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.className = "btn " + (b.cls || "");
      el.textContent = b.label;
      el.onclick = () => close(b.value);
      foot.appendChild(el);
    }
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(null); });
    document.body.appendChild(back);
    back._body = body;
    foot.lastChild?.focus();
  });
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
