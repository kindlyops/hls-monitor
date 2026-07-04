// Copy of extension/charts.js — keep in sync (the site deploy only ships site/).
// Minimal dependency-free canvas line chart with crosshair + tooltip hover.
// One series per chart; the chart title (outside this module) names it.

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class LineChart {
  // opts: { color: css-var name, fmtValue: fn(v) -> string }
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts;
    this.points = []; // {t, v, label}
    this.marks = []; // {t, label, name} - failed requests, drawn as vertical marks
    this.hoverIdx = null;
    this.hoverMark = null;

    this.tooltip = document.createElement("div");
    this.tooltip.className = "chart-tooltip";
    this.tooltip.style.display = "none";
    canvas.parentElement.style.position = "relative";
    canvas.parentElement.appendChild(this.tooltip);

    canvas.addEventListener("mousemove", (e) => this.onMove(e));
    canvas.addEventListener("mouseleave", () => {
      this.hoverIdx = null;
      this.hoverMark = null;
      this.tooltip.style.display = "none";
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
  }

  setData(points) {
    this.points = points;
    this.draw();
  }

  setMarks(marks) {
    this.marks = marks || [];
  }

  layout() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(100, rect.width - 2);
    const h = this.opts.height || 180;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const pad = { l: 46, r: 28, t: 8, b: 20 };
    return { dpr, w, h, pad, pw: w - pad.l - pad.r, ph: h - pad.t - pad.b };
  }

  scales(L) {
    const pts = this.points;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const tSpan = Math.max(1, t1 - t0);
    let vMax = Math.max(...pts.map((p) => p.v));
    if (vMax <= 0) vMax = 1;
    vMax *= 1.15; // headroom
    const x = (t) => L.pad.l + ((t - t0) / tSpan) * L.pw;
    const y = (v) => L.pad.t + L.ph - (v / vMax) * L.ph;
    return { x, y, t0, t1, vMax };
  }

  draw() {
    const L = this.layout();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.font = "10px system-ui, sans-serif";

    const grid = cssVar("--grid");
    const baseline = cssVar("--baseline");
    const muted = cssVar("--text-muted");
    const color = cssVar(this.opts.color);

    if (this.points.length < 2) {
      ctx.fillStyle = muted;
      ctx.textAlign = "center";
      ctx.fillText("waiting for data…", L.w / 2, L.h / 2);
      return;
    }
    const S = this.scales(L);

    // horizontal gridlines + y labels
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = (S.vMax / 4) * i;
      const yy = S.y(v);
      ctx.strokeStyle = i === 0 ? baseline : grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.pad.l, yy);
      ctx.lineTo(L.w - L.pad.r, yy);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(this.opts.fmtAxis(v), L.pad.l - 6, yy);
    }

    // x time labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 3; i++) {
      const t = S.t0 + ((S.t1 - S.t0) / 3) * i;
      const d = new Date(t);
      const label =
        String(d.getHours()).padStart(2, "0") +
        ":" +
        String(d.getMinutes()).padStart(2, "0") +
        ":" +
        String(d.getSeconds()).padStart(2, "0");
      ctx.fillStyle = muted;
      ctx.fillText(label, S.x(t), L.pad.t + L.ph + 5);
    }

    // error marks: dashed vertical line + ✗ at each failed request
    const crit = cssVar("--status-critical");
    this.marks.forEach((m, i) => {
      if (m.t < S.t0 || m.t > S.t1) return;
      const hovered = this.hoverMark === i;
      const xx = S.x(m.t);
      ctx.strokeStyle = crit;
      ctx.lineWidth = hovered ? 2.5 : 1.5;
      ctx.setLineDash(hovered ? [] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, L.pad.t);
      ctx.lineTo(xx, L.pad.t + L.ph);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = crit;
      ctx.font = (hovered ? "bold 14px" : "bold 11px") + " system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("✗", xx, L.pad.t + 6);
      ctx.font = "10px system-ui, sans-serif";
    });

    // series line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    this.points.forEach((p, i) => {
      const xx = S.x(p.t);
      const yy = S.y(p.v);
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    });
    ctx.stroke();

    // hover: crosshair + marker
    if (this.hoverIdx !== null && this.points[this.hoverIdx]) {
      const p = this.points[this.hoverIdx];
      const xx = S.x(p.t);
      const yy = S.y(p.v);
      ctx.strokeStyle = baseline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, L.pad.t);
      ctx.lineTo(xx, L.pad.t + L.ph);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.strokeStyle = cssVar("--surface-1");
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(xx, yy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    this._L = L;
    this._S = S;
  }

  onMove(e) {
    if (this.points.length < 2 || !this._S) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = null;
    let bestD = Infinity;
    this.points.forEach((p, i) => {
      const d = Math.abs(this._S.x(p.t) - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    let bestM = null;
    let bestMD = Infinity;
    this.marks.forEach((m, i) => {
      if (m.t < this._S.t0 || m.t > this._S.t1) return;
      const d = Math.abs(this._S.x(m.t) - mx);
      if (d < bestMD) {
        bestMD = d;
        bestM = i;
      }
    });

    const fmtTime = (t) => {
      const d = new Date(t);
      return (
        String(d.getHours()).padStart(2, "0") +
        ":" +
        String(d.getMinutes()).padStart(2, "0") +
        ":" +
        String(d.getSeconds()).padStart(2, "0")
      );
    };
    this.tooltip.innerHTML = "";
    const strong = document.createElement("strong");
    const span = document.createElement("span");
    let xx, yy;

    if (bestM !== null && bestMD <= bestD) {
      // an error mark is closest: show an error-styled tooltip
      const m = this.marks[bestM];
      this.hoverMark = bestM;
      this.hoverIdx = null;
      this.tooltip.classList.add("err");
      strong.textContent = "✗ ERROR · " + m.label;
      span.textContent = (m.name ? m.name + " · " : "") + fmtTime(m.t);
      xx = this._S.x(m.t);
      yy = 24;
    } else {
      const p = this.points[best];
      this.hoverIdx = best;
      this.hoverMark = null;
      this.tooltip.classList.remove("err");
      strong.textContent = this.opts.fmtValue(p.v);
      span.textContent = (p.label ? p.label + " · " : "") + fmtTime(p.t);
      xx = this._S.x(p.t);
      yy = Math.max(4, this._S.y(p.v) - 34);
    }
    this.draw();
    this.tooltip.appendChild(strong);
    this.tooltip.appendChild(document.createElement("br"));
    this.tooltip.appendChild(span);
    this.tooltip.style.display = "block";
    const flip = xx > rect.width - 170;
    this.tooltip.style.left = flip ? "" : xx + 12 + "px";
    this.tooltip.style.right = flip ? rect.width - xx + 12 + "px" : "";
    this.tooltip.style.top = yy + "px";
  }
}
