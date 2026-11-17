/* Tare — charts.js
   SVG charts for the Progress screen: the body-weight chart (raw weigh-ins as
   dots + EWMA trend line) and the intake bar chart (calories / protein / carbs /
   fat against the target in force each day). Plain script, no libraries, no
   modules: defines window.TareCharts and needs window.TareCore (core.js) first.

   Both constructors render into a container element they own, return
   { update(opts), destroy() }, and rebuild on container resize (150 ms debounce).
   Every node is built with createElementNS into a DocumentFragment. Colours come
   from the app's CSS tokens (with light-theme fallbacks) via one injected
   <style id="tare-charts-css">, so the module is self-contained. */
(function (root) {
  'use strict';
  const C = root.TareCore;
  if (!C) throw new Error('charts.js: load core.js first');

  const NS = 'http://www.w3.org/2000/svg';
  const PAD = { l: 44, r: 16, t: 12, b: 28 };
  const HEIGHT = { weight: 320, intake: 160 };
  const GLYPH = 6.6;        // advance of one 11-px mono glyph, for label-collision estimates
  const DEBOUNCE = 150;
  const W_STEPS = [0.5, 1, 2, 5, 10];
  const K_STEPS = [50, 100, 200, 250, 500, 1000];
  const G_STEPS = [5, 10, 20, 25, 50, 100];
  const FONT_UI = "'IBM Plex Sans', system-ui, 'Segoe UI', sans-serif";
  const FONT_MONO = "'IBM Plex Mono', ui-monospace, Consolas, monospace";

  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const r2 = (v) => Math.round(v * 100) / 100;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ------------------------------------------------------------------ css
  const CSS = [
    '.tare-chart{position:relative}',
    '.tare-chart>svg{display:block;width:100%;height:auto;overflow:visible;font-family:var(--font-ui,' + FONT_UI + ');-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:pan-y}',
    '.tc-mono{font-family:var(--font-mono,' + FONT_MONO + ');font-variant-numeric:tabular-nums;font-size:11px}',
    '.tc-label{fill:var(--muted,#8B908D)}',
    '.tc-label-2{fill:var(--ink-2,#585D5B)}',
    '.tc-halo{paint-order:stroke;stroke:var(--surface,#FFFFFF);stroke-width:3px;stroke-linejoin:round}',
    '.tc-msg{fill:var(--muted,#8B908D);font-size:13px}',
    '.tc-grid{stroke:var(--hairline,#E1E4E0);stroke-width:1}',
    '.tc-axis{stroke:var(--axis,#C5C9C4);stroke-width:1}',
    '.tc-today{stroke:var(--axis,#C5C9C4);stroke-width:1;opacity:.8}',
    '.tc-goal{stroke:var(--ink-2,#585D5B);stroke-width:1;stroke-dasharray:4 3;opacity:.75}',
    '.tc-dot{fill:var(--muted,#8B908D);opacity:.7}',
    '.tc-trend{fill:none;stroke:var(--accent,#2A78D6);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}',
    '.tc-trend-gap{stroke-dasharray:5 4}',
    '.tc-focus{fill:var(--muted,#8B908D);stroke:var(--surface,#FFFFFF);stroke-width:2;pointer-events:none}',
    '.tc-cross{stroke:var(--ink-2,#585D5B);stroke-width:1;opacity:.55;pointer-events:none}',
    '.tc-bar{fill:var(--accent,#2A78D6)}',
    '.tc-bar.is-over{fill:var(--crit,#D03B3B)}',
    '.tc-bar.is-met{fill:var(--good,#0CA30C)}',
    '.tc-bar.is-hot{opacity:.7}',
    '.tc-target{fill:none;stroke:var(--ink-2,#585D5B);stroke-width:1.5;stroke-linejoin:miter;opacity:.85}',
    '.tc-overlay{fill:transparent;pointer-events:all;cursor:crosshair;touch-action:pan-y}',
    '.chart-legend{margin:4px 0 0;font:12px/1.4 var(--font-ui,' + FONT_UI + ');color:var(--muted,#8B908D)}',
    '.chart-legend[hidden]{display:none}',
    '.chart-tip{position:absolute;left:0;top:0;z-index:5;pointer-events:none;white-space:nowrap;box-sizing:border-box;' +
      'background:var(--surface,#FFFFFF);color:var(--ink,#15171A);border:1px solid var(--hairline,#E1E4E0);border-radius:6px;padding:6px 8px;' +
      'font:12px/1.35 var(--font-mono,' + FONT_MONO + ');font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.08)}',
    '.chart-tip.is-wrap{white-space:normal}',
    '.chart-tip .tc-seg{white-space:nowrap}',
    '.chart-tip[hidden]{display:none}',
    '@media (prefers-reduced-motion:no-preference){.tc-bar{transition:opacity .12s}}',
  ].join('\n');

  function injectCss() {
    if (document.getElementById('tare-charts-css')) return;
    const s = document.createElement('style');
    s.id = 'tare-charts-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------------------------------------------------------- svg helpers
  function svgEl(tag, attrs, cls) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute('class', cls);
    return e;
  }
  function text(x, y, str, cls, attrs) {
    const t = svgEl('text', Object.assign({ x: r2(x), y: r2(y) }, attrs || {}), cls);
    t.textContent = str;
    return t;
  }
  function line(x1, y1, x2, y2, cls) {
    return svgEl('line', { x1: r2(x1), y1: r2(y1), x2: r2(x2), y2: r2(y2) }, cls);
  }

  // ---------------------------------------------------------------- scales
  function contentWidth(cont) {
    const cs = root.getComputedStyle(cont);
    return cont.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  }
  function layout(cont, height) {
    let W = contentWidth(cont);
    if (!(W > 0)) W = 600;                       // not laid out yet; the ResizeObserver re-renders once it is
    W = Math.max(160, Math.round(W));
    return { W, H: height, padL: PAD.l, padT: PAD.t, plotW: W - PAD.l - PAD.r, plotH: height - PAD.t - PAD.b };
  }
  // x(date) = padL + daysBetween(start, date) / (n - 1) * plotW — true calendar time.
  function xScale(geo, start, n) {
    const span = Math.max(1, n - 1);
    const X = (date) => geo.padL + C.daysBetween(start, date) / span * geo.plotW;
    X.slot = geo.plotW / span;
    return X;
  }
  function nextMonth(key) {
    const y = +key.slice(0, 4), m = +key.slice(5, 7);
    return m === 12 ? (y + 1) + '-01-01' : y + '-' + pad2(m + 1) + '-01';
  }
  // n <= 31: every 7 days "Sep 5"; n <= 190: first of each month "Sep"; else quarter starts "Jan '26".
  // Thinned (every k-th tick) when labels would collide — long All ranges, narrow phones.
  function xTicks(geo, X, start, today, n) {
    let out = [];
    if (n <= 31) {
      for (let d = start; d <= today; d = C.addDays(d, 7)) out.push({ date: d, label: C.fmtMonthDay(d) });
    } else {
      const monthly = n <= 190;
      let d = start.slice(8) === '01' ? start : nextMonth(start);
      for (; d <= today; d = nextMonth(d)) {
        if (monthly) out.push({ date: d, label: C.fmtMonth(d) });
        else if ((+d.slice(5, 7) - 1) % 3 === 0) out.push({ date: d, label: C.fmtMonthYear(d) });
      }
    }
    out.forEach((t) => { t.x = X(t.date); });
    if (out.length > 1) {
      let chars = 0, minGap = Infinity;
      out.forEach((t, i) => { chars = Math.max(chars, t.label.length); if (i) minGap = Math.min(minGap, t.x - out[i - 1].x); });
      const k = Math.ceil((chars * GLYPH + 12) / minGap);
      if (k > 1) {
        if (n <= 31) out = out.filter((t, i) => i % k === 0);
        else {                                    // keep month-number boundaries: every 2/3/4/6/12 months
          let every = (n <= 190 ? 1 : 3) * k;
          while (12 % every !== 0 && every < 12) every++;
          if (every < 12) out = out.filter((t) => (+t.date.slice(5, 7) - 1) % every === 0);
          else {                                  // yearly or sparser: January of every k-th year
            const yrs = Math.ceil(every / 12);
            out = out.filter((t) => t.date.slice(5, 7) === '01' && +t.date.slice(0, 4) % yrs === 0);
          }
        }
      }
    }
    return out;
  }
  // Weight y-domain: pad = max(0.5, 6% of span), snapped to a tick step from {0.5,1,2,5,10} giving 4–7 lines; never zero-based.
  function weightDomain(min, max) {
    const pad = Math.max(0.5, 0.06 * (max - min));
    const lo = min - pad, hi = max + pad;
    let step = W_STEPS[W_STEPS.length - 1];
    for (let i = 0; i < W_STEPS.length; i++) {
      const s = W_STEPS[i];
      if (Math.round((Math.ceil(hi / s) * s - Math.floor(lo / s) * s) / s) + 1 <= 7) { step = s; break; }
    }
    let dLo = Math.floor(lo / step) * step, dHi = Math.ceil(hi / step) * step;
    let count = Math.round((dHi - dLo) / step) + 1, flip = false;
    while (count < 4) { if (flip) dHi += step; else dLo -= step; flip = !flip; count++; }
    const ticks = [];
    for (let i = 0; i < count; i++) ticks.push(r2(dLo + i * step));
    return { lo: dLo, hi: dHi, step, ticks };
  }
  // Intake y-domain: 0 .. max rounded up to a clean step (<= 6 lines above zero).
  function intakeDomain(max, isKcal) {
    const steps = isKcal ? K_STEPS : G_STEPS;
    let step = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) if (Math.ceil(max / steps[i]) <= 6) { step = steps[i]; break; }
    while (Math.ceil(max / step) > 8) step *= 2;
    const hi = Math.max(step, Math.ceil(max / step) * step);
    const ticks = [];
    for (let v = 0; v <= hi + 1e-9; v += step) ticks.push(v);
    return { lo: 0, hi, step, ticks };
  }

  // ------------------------------------------------------- shared drawing
  function drawFrame(frag, geo, xt, yt) {
    const g = svgEl('g', null, 'tc-frame');
    const x0 = geo.padL, x1 = geo.padL + geo.plotW, y0 = geo.padT, y1 = geo.padT + geo.plotH;
    yt.forEach((t) => {
      g.appendChild(line(x0, t.y, x1, t.y, 'tc-grid'));
      g.appendChild(text(x0 - 8, t.y, t.label, 'tc-mono tc-label tc-ytick', { 'text-anchor': 'end', dy: '0.35em' }));
    });
    xt.forEach((t) => {
      g.appendChild(line(t.x, y0, t.x, y1, 'tc-grid'));
      const half = t.label.length * GLYPH / 2;
      g.appendChild(text(clamp(t.x, half + 2, geo.W - half - 2), y1 + 18, t.label, 'tc-mono tc-label tc-xtick', { 'text-anchor': 'middle' }));
    });
    g.appendChild(line(x0, y1, x1, y1, 'tc-axis'));
    frag.appendChild(g);
  }
  function message(frag, geo, str) {
    frag.appendChild(text(geo.W / 2, geo.H / 2, str, 'tc-msg', { 'text-anchor': 'middle', dy: '0.35em' }));
  }
  function barPath(l, r, top, base) {
    const w = r - l, h = base - top;
    const rad = Math.min(4, w / 2, h);
    l = r2(l); r = r2(r); top = r2(top); base = r2(base);
    if (rad < 0.25) return 'M' + l + ' ' + base + 'V' + top + 'H' + r + 'V' + base + 'Z';
    const ty = r2(top + rad);
    return 'M' + l + ' ' + base + 'V' + ty + 'Q' + l + ' ' + top + ' ' + r2(l + rad) + ' ' + top +
      'H' + r2(r - rad) + 'Q' + r + ' ' + top + ' ' + r + ' ' + ty + 'V' + base + 'Z';
  }
  function windowOf(o) {
    const today = C.isKey(o.today) ? o.today : C.todayKey();
    const n = Math.max(2, Math.round(o.n) || 14);
    const start = C.isKey(o.start) ? o.start : C.addDays(today, -(n - 1));
    return { today, n, start };
  }

  // ---------------------------------------------------------- interaction
  // Overlay rect over the plot; pointer (mouse/pen/touch) and touch-fallback events snap to the
  // nearest item by x, move the crosshair, highlight the item and place the HTML tooltip.
  // api: { text(it) -> [segments], anchorY(it) -> y in viewBox units, hot(it), cold(it) }
  function wire(st, svg, geo, items, api) {
    const cont = st.container, tip = st.tip;
    const cross = line(0, geo.padT, 0, geo.padT + geo.plotH, 'tc-cross');
    cross.style.display = 'none';
    const overlay = svgEl('rect', { x: geo.padL, y: geo.padT, width: geo.plotW, height: geo.plotH, fill: 'transparent' }, 'tc-overlay');
    svg.appendChild(cross);
    svg.appendChild(overlay);
    let hot = -1;

    const nearest = (vx) => {
      let lo = 0, hi = items.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].x < vx) lo = mid + 1; else hi = mid; }
      if (lo > 0 && vx - items[lo - 1].x <= items[lo].x - vx) lo--;
      return lo;
    };
    const setText = (segs) => {
      while (tip.firstChild) tip.removeChild(tip.firstChild);
      segs.forEach((s, i) => {
        if (i) tip.appendChild(document.createTextNode(' · '));
        const span = document.createElement('span');
        span.className = 'tc-seg';
        span.textContent = s;
        tip.appendChild(span);
      });
    };
    const hide = () => {
      if (hot >= 0) { api.cold(items[hot]); hot = -1; }
      cross.style.display = 'none';
      tip.hidden = true;
    };
    const show = (e, touch) => {
      if (!items.length) return;
      const sr = svg.getBoundingClientRect();
      if (!(sr.width > 0)) return;
      const k = sr.width / geo.W;
      const idx = nearest((e.clientX - sr.left) / k);
      const it = items[idx];
      if (idx !== hot) {
        if (hot >= 0) api.cold(items[hot]);
        hot = idx;
        api.hot(it);
        cross.setAttribute('x1', r2(it.x)); cross.setAttribute('x2', r2(it.x));
        cross.style.display = '';
        setText(api.text(it));
      }
      const cr = cont.getBoundingClientRect();
      tip.hidden = false;
      tip.classList.remove('is-wrap'); tip.style.maxWidth = '';
      let tw = tip.offsetWidth, th = tip.offsetHeight;
      if (tw > cr.width - 8) {                    // phone: wrap between segments, never inside one
        tip.classList.add('is-wrap'); tip.style.maxWidth = Math.max(120, cr.width - 8) + 'px';
        tw = tip.offsetWidth; th = tip.offsetHeight;
      }
      const px = sr.left - cr.left + it.x * k;    // item x in container px
      let left, top;
      if (touch) {                                // above the finger, centred on the item
        left = px - tw / 2;
        top = (e.clientY - cr.top) - th - 28;
      } else {                                    // beside the item; flips left near the right edge
        const ay = sr.top - cr.top + api.anchorY(it) * k;
        left = px + 14;
        top = ay - th / 2;
        if (left + tw > cr.width - 4) {
          if (px - 14 - tw >= 0) left = px - 14 - tw;
          else {                                  // fits on neither side: centred above (or below) the item
            left = px - tw / 2;
            top = ay - th - 14;
            if (top < 0) top = ay + 14;
          }
        }
      }
      tip.style.left = r2(clamp(left, 0, Math.max(0, cr.width - tw))) + 'px';
      tip.style.top = r2(clamp(top, 0, Math.max(0, cr.height - th))) + 'px';
    };
    const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
    overlay.addEventListener('pointermove', (e) => show(e, isTouch(e)));
    overlay.addEventListener('pointerdown', (e) => show(e, isTouch(e)));
    overlay.addEventListener('pointerleave', (e) => { if (!isTouch(e)) hide(); });
    overlay.addEventListener('pointercancel', hide);
    if (!root.PointerEvent) {                     // very old engines: raw touch + mouse events
      const onTouch = (e) => { if (e.touches && e.touches[0]) show(e.touches[0], true); };
      overlay.addEventListener('touchstart', onTouch, { passive: true });
      overlay.addEventListener('touchmove', onTouch, { passive: true });
      overlay.addEventListener('mousemove', (e) => show(e, false));
      overlay.addEventListener('mouseleave', hide);
    }
    overlay.addEventListener('click', (e) => {
      if (!items.length || typeof st.opts.onSelect !== 'function') return;
      const sr = svg.getBoundingClientRect();
      if (!(sr.width > 0)) return;
      st.opts.onSelect(items[nearest((e.clientX - sr.left) * geo.W / sr.width)].date);
    });
    st.hide = hide;
  }

  // ---------------------------------------------------------- weight chart
  function renderWeight(st) {
    const o = st.opts, geo = layout(st.container, HEIGHT.weight);
    const w = windowOf(o), start = w.start, today = w.today, n = w.n;
    const unit = o.unit === 'kg' ? 'kg' : 'lb';
    const series = Array.isArray(o.series) ? o.series : [];
    const trend = Array.isArray(o.trend) ? o.trend : [];
    const goal = isNum(o.goal) ? o.goal : null;
    const X = xScale(geo, start, n);
    const svg = svgEl('svg', { viewBox: '0 0 ' + geo.W + ' ' + geo.H, role: 'img' }, 'tc-svg tc-weight');
    const frag = document.createDocumentFragment();

    const pts = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      if (!p || !isNum(p.v) || p.date < start || p.date > today) continue;
      const t = isNum(trend[i]) ? trend[i] : p.v;
      pts.push({ date: p.date, v: p.v, t, x: X(p.date), y: 0 });
      if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v;
      if (t < lo) lo = t; if (t > hi) hi = t;
    }

    let label;
    if (!series.length) {
      message(frag, geo, 'Log your first weight on Today');
      label = 'Body weight, no weigh-ins yet';
    } else if (!pts.length) {
      message(frag, geo, 'No weigh-ins in the last ' + n + ' days');
      label = 'Body weight, last ' + n + ' days, no weigh-ins in this range';
    } else {
      if (goal != null && goal >= lo - 2 && goal <= hi + 2) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); }
      const dom = weightDomain(lo, hi);
      const Y = (v) => geo.padT + (dom.hi - v) / (dom.hi - dom.lo) * geo.plotH;
      const yt = dom.ticks.map((v) => ({ y: Y(v), label: dom.step < 1 ? v.toFixed(1) : String(Math.round(v)) }));
      drawFrame(frag, geo, xTicks(geo, X, start, today, n), yt);
      // unit label, top-left; haloed so it stays legible when data sits under it
      frag.appendChild(text(geo.padL + 6, geo.padT + 11, unit, 'tc-mono tc-label tc-halo tc-unit'));
      // goal line (label drawn later, above the data)
      let goalY = null;
      if (goal != null && goal >= dom.lo && goal <= dom.hi) {
        goalY = Y(goal);
        frag.appendChild(line(geo.padL, goalY, geo.padL + geo.plotW, goalY, 'tc-goal'));
      }
      // today rule
      frag.appendChild(line(geo.padL + geo.plotW, geo.padT, geo.padL + geo.plotW, geo.padT + geo.plotH, 'tc-today'));
      // raw weigh-ins
      const r = pts.length > 400 ? 1.5 : 3;
      const gDots = svgEl('g', null, 'tc-dots');
      pts.forEach((p) => { p.y = Y(p.v); gDots.appendChild(svgEl('circle', { cx: r2(p.x), cy: r2(p.y), r }, 'tc-dot')); });
      frag.appendChild(gDots);
      // trend: solid segments; any segment spanning a gap > 7 days goes to the dashed path
      let solid = '', dashed = '', pen = false;
      for (let i = 1; i < pts.length; i++) {
        const q = pts[i - 1], p = pts[i];
        const from = 'M' + r2(q.x) + ' ' + r2(Y(q.t)), to = 'L' + r2(p.x) + ' ' + r2(Y(p.t));
        if (C.daysBetween(q.date, p.date) > 7) { dashed += from + to; pen = false; }
        else { solid += (pen ? '' : from) + to; pen = true; }
      }
      if (solid) frag.appendChild(svgEl('path', { d: solid, fill: 'none' }, 'tc-trend'));
      if (dashed) frag.appendChild(svgEl('path', { d: dashed, fill: 'none' }, 'tc-trend tc-trend-gap'));
      if (goalY != null) {
        const ly = goalY - 5 < geo.padT + 9 ? goalY + 13 : goalY - 5;
        frag.appendChild(text(geo.padL + geo.plotW - 4, ly, 'Goal ' + C.fmt1(goal), 'tc-mono tc-label-2 tc-halo tc-goal-label', { 'text-anchor': 'end' }));
      }
      // hover marker (enlarged point with a surface ring)
      const focus = svgEl('circle', { cx: 0, cy: 0, r: 5.5 }, 'tc-focus');
      focus.style.display = 'none';
      frag.appendChild(focus);
      const last = pts[pts.length - 1];
      label = 'Body weight, last ' + n + ' days, latest ' + C.fmt1(last.v) + ' ' + unit + ', trend ' + C.fmt1(last.t);
      svg.appendChild(frag);
      wire(st, svg, geo, pts, {
        text: (it) => {
          const segs = [C.fmtDate(it.date, false), C.fmt1(it.v) + ' ' + unit, 'trend ' + C.fmt1(it.t)];
          const avg = o.sevenDayAvgByDate ? o.sevenDayAvgByDate[it.date] : null;
          if (isNum(avg)) segs.push('7-day avg ' + C.fmt1(avg));
          const k = o.kcalByDate ? o.kcalByDate[it.date] : null;
          if (isNum(k)) segs.push(C.fmtInt(k) + ' kcal logged');
          return segs;
        },
        anchorY: (it) => it.y,
        hot: (it) => { focus.setAttribute('cx', r2(it.x)); focus.setAttribute('cy', r2(it.y)); focus.style.display = ''; },
        cold: () => { focus.style.display = 'none'; },
      });
    }
    if (!svg.firstChild) svg.appendChild(frag);
    svg.setAttribute('aria-label', label);
    if (st.legend) st.legend.hidden = !series.length;
    mount(st, svg, geo);
  }

  // ---------------------------------------------------------- intake chart
  function renderIntake(st) {
    const o = st.opts, geo = layout(st.container, HEIGHT.intake);
    const w = windowOf(o), start = w.start, today = w.today, n = w.n;
    const values = o.values && typeof o.values === 'object' ? o.values : {};
    const metric = o.metric || 'kcal';
    const unitLabel = o.unitLabel || (metric === 'kcal' ? 'kcal' : 'g');
    const targetFor = typeof o.targetFor === 'function' ? o.targetFor : () => null;
    const status = typeof o.status === 'function' ? o.status : () => null;
    const name = C.LABEL[metric] || metric;
    const X = xScale(geo, start, n);
    const svg = svgEl('svg', { viewBox: '0 0 ' + geo.W + ' ' + geo.H, role: 'img' }, 'tc-svg tc-intake');
    const frag = document.createDocumentFragment();

    // logged days inside the window (absent days draw nothing)
    const days = [];
    let vmax = 0, sum = 0;
    Object.keys(values).forEach((k) => {
      const v = values[k];
      if (k < start || k > today || !isNum(v) || !C.isKey(k)) return;
      days.push(k); sum += v; if (v > vmax) vmax = v;
    });
    days.sort();
    // target in force per day -> runs of equal value (the step line), and the y-range
    const runs = [], tOf = {};
    for (let i = 0; i < n; i++) {
      const d = C.addDays(start, i);
      if (d > today) break;
      const raw = targetFor(d), t = isNum(raw) ? raw : null;
      tOf[d] = t;
      const x = X(d), last = runs[runs.length - 1];
      if (last && last.t === t) last.x1 = x; else runs.push({ t, x0: x, x1: x });
      if (t != null && t > vmax) vmax = t;
    }

    let label;
    if (!days.length) {
      message(frag, geo, 'No days logged in the last ' + n + ' days');
      label = name + ', last ' + n + ' days, no logged days in this range';
    } else {
      const dom = intakeDomain(vmax, metric === 'kcal');
      const base = geo.padT + geo.plotH;
      const Y = (v) => geo.padT + (dom.hi - v) / dom.hi * geo.plotH;
      drawFrame(frag, geo, xTicks(geo, X, start, today, n), dom.ticks.map((v) => ({ y: Y(v), label: C.fmtInt(v) })));
      // bars: <= 24 px thick, centred in the day slot, rounded only at the data end
      const bw = Math.min(24, Math.max(1, geo.plotW / n - 1));
      const gBars = svgEl('g', null, 'tc-bars');
      const items = [];
      days.forEach((k) => {
        const v = values[k], x = X(k);
        let l = Math.max(geo.padL - 6, x - bw / 2), r = x + bw / 2;   // keep the first bar out of the y-label gutter
        if (r < l + 1) r = l + 1;
        const top = Math.min(base - 1, Y(v));                            // a logged day always shows at least 1 px
        const t = tOf[k] == null ? null : tOf[k];
        const s = status(k, v, t);
        const el = svgEl('path', { d: barPath(l, r, top, base) }, 'tc-bar' + (s === 'over' ? ' is-over' : s === 'met' ? ' is-met' : ''));
        gBars.appendChild(el);
        items.push({ x, y: top, date: k, v, t, el });
      });
      frag.appendChild(gBars);
      // target step line, broken where the target is null
      let d = '', open = false;
      const half = X.slot / 2, xMin = geo.padL, xMax = geo.padL + geo.plotW;
      runs.forEach((run) => {
        if (run.t == null) { open = false; return; }
        const x0 = r2(Math.max(xMin, run.x0 - half)), x1 = r2(Math.min(xMax, run.x1 + half)), y = r2(Y(run.t));
        d += (open ? 'V' + y : 'M' + x0 + ' ' + y) + 'H' + x1;
        open = true;
      });
      if (d) frag.appendChild(svgEl('path', { d, fill: 'none' }, 'tc-target'));
      label = name + ', last ' + n + ' days, ' + days.length + ' logged day' + (days.length === 1 ? '' : 's') +
        ', average ' + C.fmtInt(sum / days.length) + ' ' + unitLabel;
      svg.appendChild(frag);
      wire(st, svg, geo, items, {
        text: (it) => {
          const segs = [C.fmtDate(it.date, false), C.fmtInt(it.v) + ' ' + unitLabel];
          if (it.t != null) {
            const diff = Math.round(it.v - it.t);
            segs.push('target ' + C.fmtInt(it.t));
            segs.push((diff > 0 ? '+' : diff < 0 ? '−' : '') + C.fmtInt(Math.abs(diff)));
          }
          return segs;
        },
        anchorY: (it) => it.y,
        hot: (it) => { it.el.classList.add('is-hot'); },
        cold: (it) => { it.el.classList.remove('is-hot'); },
      });
    }
    if (!svg.firstChild) svg.appendChild(frag);
    svg.setAttribute('aria-label', label);
    mount(st, svg, geo);
  }

  // ------------------------------------------------------------ lifecycle
  function mount(st, svg, geo) {
    if (st.svg && st.svg.parentNode === st.container) st.container.removeChild(st.svg);
    st.container.insertBefore(svg, st.container.firstChild);
    st.svg = svg;
    st.lastW = geo.W;
  }
  function create(container, opts, renderFn, legendText) {
    if (!container || container.nodeType !== 1) throw new Error('TareCharts: container element required');
    injectCss();
    const st = { container, opts: Object.assign({}, opts), svg: null, tip: null, hide: null, lastW: 0, timer: 0, destroyed: false };
    container.classList.add('tare-chart');
    while (container.firstChild) container.removeChild(container.firstChild);
    if (legendText) {
      const legend = document.createElement('div');
      legend.className = 'chart-legend';
      legend.textContent = legendText;
      container.appendChild(legend);
      st.legend = legend;
    }
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');
    container.appendChild(tip);
    st.tip = tip;
    st.render = () => { if (st.destroyed) return; if (st.hide) st.hide(); st.hide = null; renderFn(st); };
    st.render();

    // tap / click outside the chart hides the tooltip
    st.docDown = (e) => { if (st.hide && !container.contains(e.target)) st.hide(); };
    document.addEventListener('pointerdown', st.docDown, true);
    if (!root.PointerEvent) document.addEventListener('touchstart', st.docDown, true);
    // re-render when the container's width changes (debounced)
    const onResize = () => {
      clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        if (st.destroyed) return;
        const w = Math.round(contentWidth(container));
        if (w > 0 && w !== st.lastW) st.render();
      }, DEBOUNCE);
    };
    if (root.ResizeObserver) { st.ro = new ResizeObserver(onResize); st.ro.observe(container); }
    else { st.onWin = onResize; root.addEventListener('resize', onResize); }

    return {
      update(next) {
        if (st.destroyed) return;
        if (next && typeof next === 'object') Object.assign(st.opts, next);
        st.render();
      },
      destroy() {
        if (st.destroyed) return;
        st.destroyed = true;
        clearTimeout(st.timer);
        if (st.ro) st.ro.disconnect();
        if (st.onWin) root.removeEventListener('resize', st.onWin);
        document.removeEventListener('pointerdown', st.docDown, true);
        document.removeEventListener('touchstart', st.docDown, true);
        while (container.firstChild) container.removeChild(container.firstChild);
        container.classList.remove('tare-chart');
        st.svg = null; st.tip = null; st.hide = null;
      },
    };
  }

  root.TareCharts = {
    weightChart: (container, opts) => create(container, opts, renderWeight, 'dots = daily weigh-ins · line = trend'),
    intakeChart: (container, opts) => create(container, opts, renderIntake, null),
  };
})(window);
