// Slice viewer modelled on 3D Slicer's slice views.
// Every view reslices its volume in world (RAS) space, so T2W, DWI and ADC stay
// aligned even when they have different resolution / obliquity. View planes are
// aligned to the T2W acquisition ("rotate to volume plane"), so T2W is shown natively.

// ------------------------------------------------------------------ math ----
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a) => [-a[0], -a[1], -a[2]];

function mulPt(m, p) {
  return [0, 1, 2].map((r) => m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3]);
}
function mulDir(m, d) {
  return [0, 1, 2].map((r) => m[r][0] * d[0] + m[r][1] * d[1] + m[r][2] * d[2]);
}
function inv4(m) {
  // inverse of an affine 4x4 (last row 0 0 0 1)
  const a = m[0][0], b = m[0][1], c = m[0][2], d = m[1][0], e = m[1][1], f = m[1][2], g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const r = [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
  const t = [m[0][3], m[1][3], m[2][3]];
  return [
    [r[0][0], r[0][1], r[0][2], -dot(r[0], t)],
    [r[1][0], r[1][1], r[1][2], -dot(r[1], t)],
    [r[2][0], r[2][1], r[2][2], -dot(r[2], t)],
    [0, 0, 0, 1],
  ];
}
const col = (m, c) => [m[0][c], m[1][c], m[2][c]];

// RAS directions of the reference volume's voxel axes, as an orthonormal frame
function referenceFrame(A) {
  const cols = [0, 1, 2].map((c) => norm(col(A, c)));
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let best = null, bestScore = -1;
  for (const p of perms) {
    const s = Math.abs(cols[p[0]][0]) + Math.abs(cols[p[1]][1]) + Math.abs(cols[p[2]][2]);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  const e = [0, 1, 2].map((w) => { const v = cols[best[w]]; return v[w] < 0 ? neg(v) : v; });
  const eS = norm(e[2]);
  const eR = norm(sub(e[0], mul(eS, dot(e[0], eS))));
  const eA = cross(eS, eR);
  return { eR, eA, eS };
}

function orientations(f) {
  return {
    axial: { name: "Axial", x: neg(f.eR), y: neg(f.eA), n: f.eS, letter: "S" },
    sagittal: { name: "Sagittal", x: neg(f.eA), y: neg(f.eS), n: f.eR, letter: "R" },
    coronal: { name: "Coronal", x: neg(f.eR), y: neg(f.eS), n: f.eA, letter: "A" },
  };
}

function dirLabel(v) {
  const i = [0, 1, 2].reduce((m, k) => (Math.abs(v[k]) > Math.abs(v[m]) ? k : m), 0);
  return [["L", "R"], ["P", "A"], ["I", "S"]][i][v[i] > 0 ? 1 : 0];
}

// ---------------------------------------------------------------- volume ----
export class Volume {
  constructor(key, meta) {
    this.key = key;
    this.meta = meta;
    this.label = meta.label;
    this.dims = meta.shape;
    this.A = meta.affine;
    this.Ainv = inv4(meta.affine);
    this.frame = meta.default_frame;
    this.cache = {};         // frame -> typed array
    this.wl = {};            // frame -> {window, level}
    this.data = null;
    this.loading = null;
  }
  defaultWL(frame = this.frame) {
    const s = this.meta.frame_stats[frame];
    return { window: s.window, level: s.level };
  }
  get window() { return (this.wl[this.frame] ||= this.defaultWL()).window; }
  get level() { return (this.wl[this.frame] ||= this.defaultWL()).level; }
  setWL(w, l) { this.wl[this.frame] = { window: Math.max(1e-3, w), level: l }; }
  resetWL() { this.wl[this.frame] = this.defaultWL(); }
  get range() { const s = this.meta.frame_stats[this.frame]; return Math.max(1e-3, s.max - s.min); }
  center() { return mulPt(this.A, this.dims.map((d) => (d - 1) / 2)); }

  async load(url, frame) {
    if (this.cache[frame]) { this.frame = frame; this.data = this.cache[frame]; return; }
    const res = await fetch(`${url}?frame=${frame}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const arr = this.meta.dtype === "int16" ? new Int16Array(buf) : new Float32Array(buf);
    this.cache[frame] = arr;
    this.frame = frame;
    this.data = arr;
  }

  // slices of this volume along direction n
  sliceGeom(n) {
    let bi = 0, best = -1;
    for (let b = 0; b < 3; b++) {
      const c = col(this.A, b);
      const p = Math.abs(dot(c, n)) / (len(c) || 1);
      if (p > best) { best = p; bi = b; }
    }
    const step = dot(col(this.A, bi), n) || 1;
    const c0 = this.dims.map((d) => (d - 1) / 2);
    c0[bi] = 0;
    return { axis: bi, step, p0: dot(mulPt(this.A, c0), n), count: this.dims[bi] };
  }

  valueAt(p) {
    if (!this.data) return null;
    const v = mulPt(this.Ainv, p).map((x) => Math.round(x));
    const [ni, nj, nk] = this.dims;
    if (v[0] < 0 || v[1] < 0 || v[2] < 0 || v[0] >= ni || v[1] >= nj || v[2] >= nk) return { ijk: v, value: null };
    return { ijk: v, value: this.data[v[0] + v[1] * ni + v[2] * ni * nj] };
  }
}

// ------------------------------------------------------------ slice view ----
const VIEW_COLORS = {
  Red: "#f34a33", Yellow: "#edd54c", Green: "#6eb04b", Orange: "#e3903a",
};

class SliceView {
  constructor(viewer, name) {
    this.viewer = viewer;
    this.name = name;
    this.letter = name[0];
    this.color = VIEW_COLORS[name];
    this.volumeKey = "t2w";
    this.orientation = "axial";
    this.ownCam = null;
    this.ownOffset = 0;
    this.imageKey = "";
    this.imageData = null;
    this.hits = [];
    this.build();
  }

  build() {
    const el = (this.el = document.createElement("div"));
    el.className = "slice-view";
    el.style.setProperty("--view-color", this.color);
    el.innerHTML = `
      <div class="view-bar">
        <span class="view-letter" title="${this.name} view">${this.letter}</span>
        <select class="vb-ori" title="Orientation">
          <option value="axial">Axial</option><option value="sagittal">Sagittal</option><option value="coronal">Coronal</option>
        </select>
        <select class="vb-vol" title="Volume shown in this view">
          <option value="t2w">T2W</option><option value="dwi">DWI</option><option value="adc">ADC</option>
        </select>
        <input class="vb-slider" type="range" min="0" max="0" step="1" value="0" title="Slice">
        <span class="vb-offset">S: 0.0mm</span>
        <button class="vb-btn vb-max" title="Maximize / restore view (double-click)">
          <svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
        </button>
      </div>
      <div class="view-canvas-wrap">
        <canvas></canvas>
        <div class="view-msg"></div>
      </div>`;
    this.canvas = el.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.msg = el.querySelector(".view-msg");
    this.slider = el.querySelector(".vb-slider");
    this.offsetLabel = el.querySelector(".vb-offset");
    this.oriSel = el.querySelector(".vb-ori");
    this.volSel = el.querySelector(".vb-vol");

    this.oriSel.onchange = () => { this.setOrientation(this.oriSel.value); };
    this.volSel.onchange = () => { this.volumeKey = this.volSel.value; this.viewer.requestRender(); };
    this.slider.oninput = () => this.setSliderValue(+this.slider.value);
    el.querySelector(".vb-max").onclick = () => this.viewer.toggleMaximize(this);

    const wrap = el.querySelector(".view-canvas-wrap");
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.bindMouse(wrap);
  }

  get vol() { return this.viewer.volumes?.[this.volumeKey]; }
  get ori() { return this.viewer.oris?.[this.orientation]; }
  get cam() { return this.viewer.linked ? this.viewer.cameras[this.orientation] : this.ownCam; }

  setOrientation(o) {
    this.orientation = o;
    this.oriSel.value = o;
    if (!this.viewer.linked && this.viewer.cameras) this.ownCam = { ...this.viewer.cameras[o] };
    this.viewer.requestRender();
  }
  setVolume(k) { this.volumeKey = k; this.volSel.value = k; }

  resize() {
    const wrap = this.canvas.parentElement;
    const cssW = Math.max(10, wrap.clientWidth), cssH = Math.max(10, wrap.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(dpr, Math.sqrt(1_600_000 / (cssW * cssH)));  // cap work per view
    this.cssW = cssW; this.cssH = cssH;
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.canvas.width = Math.round(cssW * scale);
    this.canvas.height = Math.round(cssH * scale);
    this.pxScale = this.canvas.width / cssW;
    this.imageKey = "";
    this.viewer.requestRender();
  }

  // ---- slice geometry
  geom() { return this.vol.sliceGeom(this.ori.n); }
  targetOffset() { return this.viewer.linked ? dot(this.viewer.cursor, this.ori.n) : this.ownOffset; }
  sliceIndex() {
    const g = this.geom();
    const t = Math.round((this.targetOffset() - g.p0) / g.step);
    return Math.max(0, Math.min(g.count - 1, t));
  }
  offset() { const g = this.geom(); return g.p0 + this.sliceIndex() * g.step; }

  setSliceIndex(t) {
    const g = this.geom();
    t = Math.max(0, Math.min(g.count - 1, t));
    const off = g.p0 + t * g.step;
    if (this.viewer.linked) {
      const n = this.ori.n;
      this.viewer.cursor = add(this.viewer.cursor, mul(n, off - dot(this.viewer.cursor, n)));
    } else this.ownOffset = off;
    this.viewer.requestRender();
  }
  // slider always increases towards +n (S / R / A), like Slicer
  setSliderValue(s) {
    const g = this.geom();
    this.setSliceIndex(g.step >= 0 ? s : g.count - 1 - s);
  }
  scrollSlices(delta) {
    const g = this.geom();
    this.setSliceIndex(this.sliceIndex() + delta * Math.sign(g.step));
  }

  // ---- screen <-> world (CSS pixels)
  planeCenter() {
    const c = this.cam.center, n = this.ori.n;
    return add(c, mul(n, this.offset() - dot(c, n)));
  }
  toWorld(px, py) {
    const o = this.ori, s = this.cam.mmPerPx, C = this.planeCenter();
    return add(C, add(mul(o.x, (px - this.cssW / 2) * s), mul(o.y, (py - this.cssH / 2) * s)));
  }
  toScreen(p) {
    const o = this.ori, s = this.cam.mmPerPx, d = sub(p, this.planeCenter());
    return [this.cssW / 2 + dot(d, o.x) / s, this.cssH / 2 + dot(d, o.y) / s, dot(p, o.n) - this.offset()];
  }

  // ---- rendering
  render() {
    const v = this.vol;
    if (!this.cssW || !this.viewer.volumes) return;
    this.el.classList.toggle("is-hidden", false);
    const o = this.ori, cam = this.cam;
    const g = this.geom();
    const idx = this.sliceIndex();
    this.slider.max = g.count - 1;
    this.slider.value = g.step >= 0 ? idx : g.count - 1 - idx;
    this.offsetLabel.textContent = `${o.letter}: ${this.offset().toFixed(1)}mm`;
    this.oriSel.value = this.orientation;
    this.volSel.value = this.volumeKey;

    const ctx = this.ctx;
    if (!v || !v.data) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.msg.textContent = v?.error ? `Could not load ${v.label}: ${v.error}` : `Loading ${v ? v.label : ""}…`;
      this.msg.style.display = "block";
      return;
    }
    this.msg.style.display = "none";

    const key = [v.key, v.frame, this.offset().toFixed(3), cam.center.map((x) => x.toFixed(3)), cam.mmPerPx.toFixed(5),
      this.orientation, this.canvas.width, this.canvas.height, v.window, v.level, this.viewer.interpolate].join("|");
    if (key !== this.imageKey || !this.imageData) {
      this.imageData = this.renderImage(v);
      this.imageKey = key;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(this.imageData, 0, 0);
    ctx.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);
    this.drawOverlay(v, g, idx);
  }

  renderImage(v) {
    const W = this.canvas.width, H = this.canvas.height;
    const img = this.ctx.createImageData(W, H);
    const out = new Uint32Array(img.data.buffer);
    const o = this.ori, s = this.cam.mmPerPx / this.pxScale;
    const C = this.planeCenter();
    const w0 = add(C, add(mul(o.x, (0.5 - W / 2) * s), mul(o.y, (0.5 - H / 2) * s)));
    const v0 = mulPt(v.Ainv, w0), dx = mulDir(v.Ainv, mul(o.x, s)), dy = mulDir(v.Ainv, mul(o.y, s));
    const [ni, nj, nk] = v.dims, nij = ni * nj, data = v.data;
    const lo = v.level - v.window / 2, sc = 255 / v.window;
    const interp = this.viewer.interpolate;
    const BLACK = 0xff000000;
    let p = 0;
    for (let y = 0; y < H; y++) {
      let fx = v0[0] + dy[0] * y, fy = v0[1] + dy[1] * y, fz = v0[2] + dy[2] * y;
      for (let x = 0; x < W; x++, fx += dx[0], fy += dx[1], fz += dx[2], p++) {
        if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > ni - 0.5 || fy > nj - 0.5 || fz > nk - 0.5) { out[p] = BLACK; continue; }
        let val;
        if (!interp) {
          val = data[((fx + 0.5) | 0) + ((fy + 0.5) | 0) * ni + ((fz + 0.5) | 0) * nij];
        } else {
          const cx = fx < 0 ? 0 : fx > ni - 1 ? ni - 1 : fx;
          const cy = fy < 0 ? 0 : fy > nj - 1 ? nj - 1 : fy;
          const cz = fz < 0 ? 0 : fz > nk - 1 ? nk - 1 : fz;
          const i0 = cx | 0, j0 = cy | 0, k0 = cz | 0;
          const i1 = i0 + 1 < ni ? i0 + 1 : i0, j1 = j0 + 1 < nj ? j0 + 1 : j0, k1 = k0 + 1 < nk ? k0 + 1 : k0;
          const ax = cx - i0, ay = cy - j0, az = cz - k0;
          const b00 = j0 * ni + k0 * nij, b10 = j1 * ni + k0 * nij, b01 = j0 * ni + k1 * nij, b11 = j1 * ni + k1 * nij;
          const c00 = data[i0 + b00] + (data[i1 + b00] - data[i0 + b00]) * ax;
          const c10 = data[i0 + b10] + (data[i1 + b10] - data[i0 + b10]) * ax;
          const c01 = data[i0 + b01] + (data[i1 + b01] - data[i0 + b01]) * ax;
          const c11 = data[i0 + b11] + (data[i1 + b11] - data[i0 + b11]) * ax;
          const c0 = c00 + (c10 - c00) * ay, c1 = c01 + (c11 - c01) * ay;
          val = c0 + (c1 - c0) * az;
        }
        let gv = (val - lo) * sc;
        gv = gv < 0 ? 0 : gv > 255 ? 255 : gv | 0;
        out[p] = BLACK | (gv << 16) | (gv << 8) | gv;
      }
    }
    return img;
  }

  drawOverlay(v, g, idx) {
    const ctx = this.ctx, W = this.cssW, H = this.cssH, o = this.ori;
    ctx.font = "12px Helvetica, Arial, sans-serif";
    ctx.textBaseline = "top";
    const text = (s, x, y, align = "left") => {
      ctx.textAlign = align;
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.strokeText(s, x, y);
      ctx.fillStyle = "#f0f0f0";
      ctx.fillText(s, x, y);
    };
    const frameTxt = v.meta.frames > 1 ? `  [vol ${v.frame + 1}/${v.meta.frames}]` : "";
    text(`B: ${v.label}${frameTxt}`, 6, 5);
    text(o.name, W - 6, 5, "right");
    ctx.textBaseline = "bottom";
    text(`W ${fmt(v.window)}  L ${fmt(v.level)}`, 6, H - 5);
    text(`Slice ${idx + 1}/${g.count}`, W - 6, H - 5, "right");

    // orientation letters
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,210,80,0.85)";
    ctx.textAlign = "left"; ctx.fillText(dirLabel(neg(o.x)), 6, H / 2);
    ctx.textAlign = "right"; ctx.fillText(dirLabel(o.x), W - 6, H / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(dirLabel(neg(o.y)), W / 2, 20);
    ctx.textBaseline = "bottom"; ctx.fillText(dirLabel(o.y), W / 2, H - 4);

    this.drawRuler(ctx, W, H);

    // crosshair
    if (this.viewer.crosshair) {
      const [cx, cy] = this.toScreen(this.viewer.cursor);
      ctx.strokeStyle = "rgba(255,230,90,0.75)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cy + 0.5); ctx.lineTo(cx - 8, cy + 0.5); ctx.moveTo(cx + 8, cy + 0.5); ctx.lineTo(W, cy + 0.5);
      ctx.moveTo(cx + 0.5, 0); ctx.lineTo(cx + 0.5, cy - 8); ctx.moveTo(cx + 0.5, cy + 8); ctx.lineTo(cx + 0.5, H);
      ctx.stroke();
    }

    // lesion points
    this.hits = [];
    const half = Math.abs(g.step) / 2 + 0.01;
    for (const L of this.viewer.getLesions()) {
      const [sx, sy, dist] = this.toScreen(L.ras);
      if (Math.abs(dist) > half) {
        if (Math.abs(dist) <= half * 3 && L.selected) {       // hint: selected lesion is on a nearby slice
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = L.color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
        continue;
      }
      this.hits.push({ id: L.id, x: sx, y: sy });
      ctx.lineWidth = L.selected ? 2.5 : 1.8;
      ctx.strokeStyle = L.color;
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx - 11, sy); ctx.lineTo(sx - 4, sy); ctx.moveTo(sx + 4, sy); ctx.lineTo(sx + 11, sy);
      ctx.moveTo(sx, sy - 11); ctx.lineTo(sx, sy - 4); ctx.moveTo(sx, sy + 4); ctx.lineTo(sx, sy + 11); ctx.stroke();
      ctx.font = "bold 12px Helvetica, Arial, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillText(L.label, sx + 11, sy - 5);
      ctx.fillStyle = L.color; ctx.fillText(L.label, sx + 10, sy - 6);
      ctx.font = "12px Helvetica, Arial, sans-serif";
    }
  }

  drawRuler(ctx, W, H) {
    const mmPerPx = this.cam.mmPerPx;
    const target = (W * 0.25) * mmPerPx;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200];
    const mm = nice.reduce((b, n) => (n <= target ? n : b), 1);
    const px = mm / mmPerPx;
    const x0 = W / 2 - px / 2, y0 = H - 22;
    ctx.strokeStyle = "rgba(230,230,230,0.8)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 4);
    ctx.stroke();
    ctx.fillStyle = "rgba(230,230,230,0.9)"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(mm >= 10 ? `${mm / 10} cm` : `${mm} mm`, W / 2, y0 - 3);
  }

  // ---- mouse (Slicer defaults: L-drag W/L, R-drag zoom, M-drag / Shift+L-drag pan,
  //      wheel = slice, Ctrl/Cmd+wheel = zoom, Shift+move = crosshair)
  bindMouse(wrap) {
    let drag = null, wheelAcc = 0;
    const pos = (e) => { const r = wrap.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    wrap.addEventListener("contextmenu", (e) => e.preventDefault());
    wrap.addEventListener("dblclick", () => this.viewer.toggleMaximize(this));

    wrap.addEventListener("pointerdown", (e) => {
      if (!this.vol?.data) return;
      wrap.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      this.viewer.activeView = this;
      const hit = this.hits.find((h) => Math.hypot(h.x - x, h.y - y) < 9);
      if (e.button === 0 && hit) {
        this.viewer.cb.onLesionSelect?.(hit.id);
        drag = this.viewer.editable ? { type: "lesion", id: hit.id } : null;
        return;
      }
      if (e.button === 0 && this.viewer.mode === "place") {
        this.viewer.cb.onPlace?.(this.toWorld(x, y), this.volumeKey);
        return;
      }
      const cam = this.cam;
      if (e.button === 1 || (e.button === 0 && e.shiftKey) || (e.button === 0 && this.viewer.mode === "pan")) {
        drag = { type: "pan", x, y, center: cam.center.slice() };
      } else if (e.button === 2 || (e.button === 0 && this.viewer.mode === "zoom")) {
        drag = { type: "zoom", x, y, s0: cam.mmPerPx, anchor: this.toWorld(this.cssW / 2, this.cssH / 2) };
      } else if (e.button === 0) {
        drag = { type: "wl", x, y, w: this.vol.window, l: this.vol.level };
      }
    });

    wrap.addEventListener("pointermove", (e) => {
      if (!this.vol?.data) return;
      const [x, y] = pos(e);
      const world = this.toWorld(x, y);
      this.viewer.probe(this, world);
      if (!drag) {
        if (e.shiftKey && e.buttons === 0) { this.viewer.setCursor(world); }
        wrap.style.cursor = this.hits.some((h) => Math.hypot(h.x - x, h.y - y) < 9)
          ? (this.viewer.editable ? "move" : "pointer")
          : this.viewer.mode === "place" ? "crosshair" : "default";
        return;
      }
      const cam = this.cam, o = this.ori;
      if (drag.type === "lesion") {
        this.viewer.cb.onLesionMove?.(drag.id, world, this.volumeKey);
      } else if (drag.type === "pan") {
        const dxmm = (x - drag.x) * cam.mmPerPx, dymm = (y - drag.y) * cam.mmPerPx;
        cam.center = sub(drag.center, add(mul(o.x, dxmm), mul(o.y, dymm)));
      } else if (drag.type === "zoom") {
        const f = Math.exp((y - drag.y) * 0.01);   // drag down = zoom out, up = zoom in
        cam.mmPerPx = Math.max(0.02, Math.min(5, drag.s0 * f));
      } else if (drag.type === "wl") {
        const r = this.vol.range;
        this.vol.setWL(drag.w + (x - drag.x) * r / 600, drag.l - (y - drag.y) * r / 600);
        this.viewer.cb.onWLChange?.();
      }
      this.viewer.requestRender();
    });

    const end = (e) => {
      if (drag?.type === "lesion") this.viewer.cb.onLesionMoveEnd?.(drag.id);
      drag = null;
      try { wrap.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);
    wrap.addEventListener("pointerleave", () => this.viewer.probe(null));
    wrap.addEventListener("pointerenter", () => { this.viewer.hoverView = this; });

    wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (!this.vol?.data) return;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey) {           // zoom about mouse (also trackpad pinch)
        const [x, y] = pos(e);
        const cam = this.cam, before = this.toWorld(x, y);
        const f = Math.exp(e.deltaY * unit * 0.002);
        cam.mmPerPx = Math.max(0.02, Math.min(5, cam.mmPerPx * f));
        const after = this.toWorld(x, y);
        cam.center = add(cam.center, sub(before, after));
        this.viewer.requestRender();
        return;
      }
      const dy = e.deltaY * unit;
      if (Math.abs(dy) >= 50) {              // mouse wheel notch: exactly one slice
        wheelAcc = 0;
        this.scrollSlices(-Math.sign(dy));    // wheel up = towards S / R / A
        return;
      }
      wheelAcc += dy;                         // trackpad: accumulate small deltas
      const threshold = 30;
      while (Math.abs(wheelAcc) >= threshold) {
        const d = Math.sign(wheelAcc);
        this.scrollSlices(-d);
        wheelAcc -= d * threshold;
      }
    }, { passive: false });
  }
}

function fmt(x) {
  const a = Math.abs(x);
  return a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2);
}

// ----------------------------------------------------------------- viewer ----
export const LAYOUTS = {
  bpmri: {
    name: "bpMRI 1×3 (T2W | DWI | ADC)",
    cols: 3, rows: 1,
    views: [["Red", "t2w", "axial"], ["Yellow", "dwi", "axial"], ["Green", "adc", "axial"]],
  },
  bpmri2x2: {
    name: "bpMRI 2×2 (+ T2W sagittal)",
    cols: 2, rows: 2,
    views: [["Red", "t2w", "axial"], ["Yellow", "dwi", "axial"], ["Green", "adc", "axial"], ["Orange", "t2w", "sagittal"]],
  },
  fourup: {
    name: "Four-Up (T2W axial / sagittal / coronal + ADC)",
    cols: 2, rows: 2,
    views: [["Red", "t2w", "axial"], ["Orange", "adc", "axial"], ["Yellow", "t2w", "sagittal"], ["Green", "t2w", "coronal"]],
  },
  t2adc: {
    name: "1×2 (T2W | ADC)",
    cols: 2, rows: 1,
    views: [["Red", "t2w", "axial"], ["Green", "adc", "axial"]],
  },
  single: {
    name: "Red slice only",
    cols: 1, rows: 1,
    views: [["Red", "t2w", "axial"]],
  },
};

export class Viewer {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.cb = callbacks;
    this.views = {};
    for (const n of Object.keys(VIEW_COLORS)) this.views[n] = new SliceView(this, n);
    this.linked = true;
    this.crosshair = false;
    this.interpolate = true;
    this.mode = "wl";
    this.editable = true;
    this.volumes = null;
    this.maximized = null;
    this.layout = "bpmri";
    this.getLesions = () => [];
    this._raf = 0;
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  setLayout(name) {
    this.layout = name;
    this.maximized = null;
    const L = LAYOUTS[name];
    this.container.innerHTML = "";
    this.container.style.gridTemplateColumns = `repeat(${L.cols}, 1fr)`;
    this.container.style.gridTemplateRows = `repeat(${L.rows}, 1fr)`;
    this.visible = [];
    for (const [vn, vol, ori] of L.views) {
      const v = this.views[vn];
      v.setVolume(vol);
      v.orientation = ori;
      if (!this.linked && this.cameras) v.ownCam = { ...this.cameras[ori] };
      this.container.appendChild(v.el);
      this.visible.push(v);
    }
    this.pendingFit = true;
    this.requestRender();
  }

  toggleMaximize(view) {
    if (this.maximized) {
      this.setLayoutKeepViews();
    } else {
      this.maximized = view;
      this.container.innerHTML = "";
      this.container.style.gridTemplateColumns = "1fr";
      this.container.style.gridTemplateRows = "1fr";
      this.container.appendChild(view.el);
    }
    this.requestRender();
  }
  setLayoutKeepViews() {
    const L = LAYOUTS[this.layout];
    this.maximized = null;
    this.container.innerHTML = "";
    this.container.style.gridTemplateColumns = `repeat(${L.cols}, 1fr)`;
    this.container.style.gridTemplateRows = `repeat(${L.rows}, 1fr)`;
    for (const v of this.visible) this.container.appendChild(v.el);
  }

  // metas: {t2w: meta, dwi: meta, adc: meta}; urls: {t2w: url, ...}
  async loadCase(metas, urls) {
    const vols = {};
    for (const k of Object.keys(metas)) vols[k] = new Volume(k, metas[k]);
    this.volumes = vols;
    this.urls = urls;
    const ref = vols.t2w;
    this.frame = referenceFrame(ref.A);
    this.oris = orientations(this.frame);
    this.cursor = ref.center();
    this.resetViews(true);
    this.pendingFit = true;
    this.requestRender();
    await Promise.all(Object.values(vols).map(async (v) => {
      try { await v.load(urls[v.key], v.frame); } catch (e) { v.error = e.message; }
      this.requestRender();
    }));
  }

  async setFrame(key, frame) {
    const v = this.volumes?.[key];
    if (!v) return;
    v.data = null;
    this.requestRender();
    try { await v.load(this.urls[key], frame); } catch (e) { v.error = e.message; }
    this.requestRender();
  }

  // fit the T2W field of view in every visible view
  resetViews(recenter = true) {
    const ref = this.volumes.t2w;
    const [ni, nj, nk] = ref.dims;
    const corners = [];
    for (const i of [0, ni - 1]) for (const j of [0, nj - 1]) for (const k of [0, nk - 1]) corners.push(mulPt(ref.A, [i, j, k]));
    const center = ref.center();
    const cams = {};
    for (const [key, o] of Object.entries(this.oris)) {
      const ext = (d) => Math.max(...corners.map((c) => Math.abs(dot(sub(c, center), d)))) * 2;
      const ex = ext(o.x), ey = ext(o.y);
      let s = 0;
      for (const v of this.visible || []) {
        if (v.orientation !== key || !v.el.isConnected || !(v.cssW > 50)) continue;
        s = Math.max(s, ex / v.cssW, ey / v.cssH);
      }
      cams[key] = { center: center.slice(), mmPerPx: (s || 0.5) * 1.02 };
    }
    if (recenter || !this.cameras) this.cameras = cams;
    else for (const k of Object.keys(cams)) this.cameras[k].mmPerPx = cams[k].mmPerPx;
    if (recenter) this.cursor = center;
    for (const v of Object.values(this.views)) {
      v.ownCam = { ...this.cameras[v.orientation], center: this.cameras[v.orientation].center.slice() };
      v.ownOffset = dot(this.cursor, this.oris[v.orientation].n);
    }
    this.requestRender();
  }

  setLinked(on) {
    if (on === this.linked) return;
    if (!on && this.cameras) {
      for (const v of Object.values(this.views)) {
        const c = this.cameras[v.orientation];
        v.ownCam = { center: c.center.slice(), mmPerPx: c.mmPerPx };
        v.ownOffset = dot(this.cursor, this.oris[v.orientation].n);
      }
    }
    this.linked = on;
    this.requestRender();
  }

  setCursor(p) {
    this.cursor = p.slice();
    if (!this.linked) for (const v of Object.values(this.views)) v.ownOffset = dot(p, this.oris[v.orientation].n);
    this.requestRender();
  }

  // jump to a point and centre all views on it
  centerOn(p) {
    this.setCursor(p);
    for (const c of Object.values(this.cameras)) c.center = p.slice();
    for (const v of Object.values(this.views)) if (v.ownCam) v.ownCam.center = p.slice();
    this.requestRender();
  }

  setMode(m) { this.mode = m; this.cb.onModeChange?.(m); }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this.pendingFit && this.volumes && (this.visible || []).every((v) => v.el.isConnected && v.cssW > 50 && v.cssH > 50)) {
        this.pendingFit = false;
        this.resetViews(false);
      }
      const shown = this.maximized ? [this.maximized] : this.visible || [];
      for (const v of shown) v.render();
    });
  }

  probe(view, world) {
    if (!view || !this.volumes) { this.cb.onProbe?.(null); return; }
    const values = Object.values(this.volumes).map((v) => ({ key: v.key, label: v.label, ...(v.valueAt(world) || {}) }));
    this.cb.onProbe?.({ view: view.name, color: view.color, orientation: view.ori.name, ras: world, values });
  }

  worldToIjk(key, p) {
    const v = this.volumes?.[key];
    return v ? mulPt(v.Ainv, p) : null;
  }

  onKey(e) {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    const v = this.hoverView || this.activeView || this.visible?.[0];
    if (!v || !this.volumes) return;
    if (e.key === "ArrowUp" || e.key === "PageUp") { v.scrollSlices(1); e.preventDefault(); }
    else if (e.key === "ArrowDown" || e.key === "PageDown") { v.scrollSlices(-1); e.preventDefault(); }
    else if (e.key === "r" || e.key === "R") { this.resetViews(false); this.cb.onReset?.(); }
    else if (e.key === "Escape") { this.setMode("wl"); }
    else if (e.key === "p" || e.key === "P") { if (this.editable) this.setMode(this.mode === "place" ? "wl" : "place"); }
    else if (e.key === "c" || e.key === "C") { this.crosshair = !this.crosshair; this.cb.onCrosshair?.(this.crosshair); this.requestRender(); }
  }
}
