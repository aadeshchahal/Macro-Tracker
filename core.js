/* Tare — core.js
   Pure logic only: dates, ids, deep-merge, nutrition math, parsing, validation, readers over
   the document shapes, search ranking, weight trend, backup format. No DOM, no storage.
   Loaded in the page as a plain script (window.TareCore) and in Node tests via require().

   Document shapes (see addendum.md):
     meta/app                      { schemaVersion, createdAt, updatedAt, lastBackupAt, firstYear, settings, targets: { from: target|null } }
     weights/{YYYY}                { year, updatedAt, byDate: { date: {v,u,at}|null } }
     foods/{id}, meals/{id}        records
     years/{YYYY}/days/{date}      { date, updatedAt, entries: { id: entry|null } }
   A null value in a map is a tombstone (removed). Readers filter; writers patch with deepMerge semantics. */
(function (root) {
  'use strict';
  const C = {};
  C.SCHEMA = 1;
  C.PATHS = { app: 'meta/app' };
  C.ID_RE = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
  // Ids become plain-object keys; reject anything that resolves on Object.prototype (__proto__, constructor, …).
  C.isId = (x) => typeof x === 'string' && C.ID_RE.test(x) && !(x in Object.prototype);
  C.MIN_KEY = '2000-01-01';
  C.MIN_YEAR = '2000';
  // How far ahead a day can be logged — enough for a week or two of meal-prepped breakfasts,
  // bounded so a mistyped year (2027 instead of 2026) can't silently open a huge planning window.
  C.MAX_FUTURE_DAYS = 14;
  C.yearOf = (key) => key.slice(0, 4);
  C.daysCol = (year) => 'years/' + year + '/days';
  C.dayPath = (key) => 'years/' + key.slice(0, 4) + '/days/' + key;
  C.weightsPath = (year) => 'weights/' + year;
  C.DEFAULT_SETTINGS = { weightUnit: 'lb', goalWeight: null, weightFirst: true };
  C.RANGES = ['1M', '3M', '6M', '1Y', 'All'];
  C.RANGE_DAYS = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365 };
  C.DOC_CAP = 5000;
  const LABEL = { kcal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat', fiber: 'Fiber' };
  C.LABEL = LABEL;
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  C.isNum = isNum;
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  C.isObj = isObj;

  // ---------------------------------------------------------------- dates
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  C.keyOf = (dt) => dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  C.todayKey = (now) => C.keyOf(now || new Date());
  C.isKey = (k) => {
    if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k) || k < C.MIN_KEY) return false;
    const y = +k.slice(0, 4), m = +k.slice(5, 7), d = +k.slice(8, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(y, m - 1, d, 12);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  };
  C.isYear = (y) => typeof y === 'string' && /^\d{4}$/.test(y) && y >= C.MIN_YEAR;
  C.isTimestamp = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s) && C.isKey(s.slice(0, 10));
  C.noon = (k) => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10), 12, 0, 0, 0);
  C.addDays = (k, n) => { const d = C.noon(k); d.setDate(d.getDate() + n); return C.keyOf(d); };
  C.daysBetween = (a, b) => Math.round((C.noon(b) - C.noon(a)) / 86400000);
  C.nowLocal = (now) => {
    const d = now || new Date();
    return C.keyOf(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };
  C.fmtDate = (k, withYear) => {
    const d = C.noon(k);
    return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + (withYear === false ? '' : ' ' + d.getFullYear());
  };
  C.fmtMonthDay = (k) => { const d = C.noon(k); return MON[d.getMonth()] + ' ' + d.getDate(); };
  C.fmtMonth = (k) => MON[C.noon(k).getMonth()];
  C.fmtMonthYear = (k) => { const d = C.noon(k); return MON[d.getMonth()] + " '" + String(d.getFullYear()).slice(2); };
  C.weekMonday = (k) => C.addDays(k, -((C.noon(k).getDay() + 6) % 7));
  C.relativeDay = (k, today) => {
    const n = C.daysBetween(k, today); // positive when k is before today, negative when k is ahead
    if (n === 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n > 1 && n < 7) return n + ' days ago';
    if (n === -1) return 'tomorrow';
    if (n < -1 && n > -7) return 'in ' + (-n) + ' days';
    return C.fmtDate(k, false);
  };
  C.timeAgo = (isoLocal, now) => {
    if (!isoLocal) return 'never';
    const key = String(isoLocal).slice(0, 10);
    if (!C.isKey(key)) return 'never';
    const n = C.daysBetween(key, C.todayKey(now));
    if (n <= 0) return 'today';
    if (n === 1) return 'yesterday';
    return n + ' days ago';
  };

  // ------------------------------------------------------------------ ids
  // prefix + time (base36 ms) + '_' + 2-char sequence + 6 random chars. Sorting by (at, id) keeps
  // creation order inside one second; the random tail keeps two devices apart.
  const ALPH = '0123456789abcdefghijklmnopqrstuvwxyz';
  let seq = 0;
  const cryptoRand = () => {
    const g = root.crypto && root.crypto.getRandomValues;
    if (!g) return Math.random();
    const a = new Uint32Array(1); root.crypto.getRandomValues(a); return a[0] / 4294967296;
  };
  C.newId = (prefix, now, rand) => {
    const t = (now == null ? Date.now() : now).toString(36);
    const fn = rand || cryptoRand;
    seq = (seq + 1) % 1296;
    let r = ALPH[Math.floor(seq / 36)] + ALPH[seq % 36];
    for (let i = 0; i < 6; i++) r += ALPH[Math.floor(fn() * 36) % 36];
    return prefix + t + '_' + r;
  };

  // ------------------------------------------------------------ deepMerge
  // Exactly the store's `update` semantics: nested plain objects merge recursively; arrays, scalars
  // and null replace the field wholesale (null is stored, not deleted). Never mutates its inputs.
  C.deepMerge = (base, patch) => {
    const out = isObj(base) ? Object.assign({}, base) : {};
    if (!isObj(patch)) return out;
    Object.keys(patch).forEach((k) => {
      const pv = patch[k];
      if (isObj(pv)) out[k] = C.deepMerge(isObj(out[k]) ? out[k] : {}, pv);
      else out[k] = Array.isArray(pv) ? pv.slice() : pv;
    });
    return out;
  };
  C.deepFreeze = (x) => {
    if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.keys(x).forEach((k) => C.deepFreeze(x[k])); }
    return x;
  };
  C.clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

  // -------------------------------------------------------------- numbers
  C.round1 = (x) => Math.round(x * 10) / 10;
  C.round3 = (x) => Math.round(x * 1000) / 1000;
  C.fmt1 = (x) => (x == null || !isFinite(x)) ? '—' : String(C.round1(x));
  C.fmtInt = (x) => (x == null || !isFinite(x)) ? '—' : Math.round(x).toLocaleString('en-US');
  C.fmtSigned = (x, dp) => {
    if (x == null || !isFinite(x)) return '—';
    const v = dp === 1 ? C.round1(x) : Math.round(x * 100) / 100;
    return (v > 0 ? '+' : '') + String(v);
  };
  C.parseNum = (s) => {
    if (typeof s === 'number') return isFinite(s) ? { ok: true, value: s } : { ok: false, error: 'Enter a number' };
    const t = String(s == null ? '' : s).trim();
    if (t === '') return { ok: false, empty: true, error: 'Enter a number' };
    if (t.indexOf(',') >= 0) return { ok: false, error: 'Use a dot for decimals (e.g. 4.5)' };
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, error: 'Enter a number' };
    return { ok: true, value: parseFloat(t) };
  };

  // ------------------------------------------------ amount expression parser
  C.evalExpr = (src) => {
    const s = String(src == null ? '' : src).replace(/\s+/g, '');
    if (s === '') return { ok: false, empty: true, error: 'Enter an amount' };
    if (s.length > 64) return { ok: false, error: 'Check the amount' };
    if (s.indexOf(',') >= 0) return { ok: false, error: 'Use a dot for decimals (e.g. 4.5)' };
    if (!/^[0-9.+\-*/()]+$/.test(s)) return { ok: false, error: 'Only numbers and + - * / ( )' };
    let i = 0, err = null;
    const num = () => { const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i)); if (!m) { err = 'Check the amount'; return NaN; } i += m[0].length; return parseFloat(m[0]); };
    const factor = () => {
      const ch = s[i];
      if (ch === '-') { i++; return -factor(); }
      if (ch === '+') { i++; return factor(); }
      if (ch === '(') { i++; const v = expr(); if (s[i] !== ')') { err = 'Missing )'; return NaN; } i++; return v; }
      return num();
    };
    const term = () => { let v = factor(); while (!err && (s[i] === '*' || s[i] === '/')) { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; } return v; };
    const expr = () => { let v = term(); while (!err && (s[i] === '+' || s[i] === '-')) { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
    const v = expr();
    if (err) return { ok: false, error: err };
    if (i !== s.length) return { ok: false, error: 'Check the amount' };
    if (!isFinite(v)) return { ok: false, error: 'Check the amount' };
    return { ok: true, value: v };
  };

  // ------------------------------------------------------------ nutrition
  C.scale = (n, amount, basis) => {
    const f = (x) => (x == null ? null : x * amount / basis);
    return { kcal: f(n.kcal), protein: f(n.protein), carbs: f(n.carbs), fat: f(n.fat), fiber: f(n.fiber) };
  };
  C.entryValues = (e) => C.scale(e.n, e.amount, e.basis);
  C.dayTotals = (entries) => {
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, fiberCount: 0, count: 0 };
    (entries || []).forEach((e) => {
      const v = C.entryValues(e);
      t.kcal += v.kcal; t.protein += v.protein; t.carbs += v.carbs; t.fat += v.fat;
      if (v.fiber != null) { t.fiber += v.fiber; t.fiberCount++; }
      t.count++;
    });
    return t;
  };
  C.macroKcal = (p, c, f) => 4 * (p || 0) + 4 * (c || 0) + 9 * (f || 0);
  C.energySplit = (p, c, f) => {
    const parts = [4 * (p || 0), 4 * (c || 0), 9 * (f || 0)];
    const sum = parts[0] + parts[1] + parts[2];
    if (!(sum > 0) || !isFinite(sum)) return null;
    const raw = parts.map((x) => 100 * x / sum);
    const out = raw.map(Math.floor);
    const rem = 100 - out.reduce((a, b) => a + b, 0);
    const order = [0, 1, 2].sort((a, b) => (raw[b] - out[b]) - (raw[a] - out[a]));
    for (let i = 0; i < rem; i++) out[order[i % 3]]++;
    return { protein: out[0], carbs: out[1], fat: out[2] };
  };
  C.kcalCheck = (kcal, p, c, f) => {
    const mk = C.macroKcal(p, c, f);
    if (!(kcal >= 10)) return { mismatch: false, macroKcal: mk };
    return { mismatch: Math.abs(kcal - mk) > Math.max(20, 0.15 * kcal), macroKcal: mk };
  };
  C.kjToKcal = (kj) => C.round1(kj / 4.184);
  C.parseEnergy = (s) => {
    const t = String(s == null ? '' : s).trim();
    const m = /^(\d+\.?\d*|\.\d+)\s*kj$/i.exec(t);
    if (m) { const kj = parseFloat(m[1]); return { ok: true, value: C.kjToKcal(kj), fromKj: kj }; }
    const r = C.parseNum(t);
    return r.ok ? { ok: true, value: r.value, fromKj: null } : r;
  };
  // targets: a map { from: target|null } (or a legacy array); returns the target in force on `key`
  C.targetsList = (targets) => {
    if (Array.isArray(targets)) return targets.filter((t) => t && C.isKey(t.from)).slice().sort((a, b) => (a.from < b.from ? -1 : 1));
    if (!isObj(targets)) return [];
    return Object.keys(targets).filter((k) => C.isKey(k) && isObj(targets[k])).sort().map((k) => Object.assign({ from: k }, targets[k]));
  };
  C.targetFor = (targets, key) => {
    let best = null;
    C.targetsList(targets).forEach((t) => { if (t.from <= key) best = t; });
    return best;
  };
  C.pct = (total, target) => (isNum(target) && target > 0 && isNum(total)) ? Math.round(100 * total / target) : null;
  C.targetsLine = (p, c, f) => {
    const k = C.macroKcal(p, c, f), s = C.energySplit(p, c, f);
    if (!s) return '';
    return 'P ' + C.fmt1(p || 0) + ' g + C ' + C.fmt1(c || 0) + ' g + F ' + C.fmt1(f || 0) + ' g = ' + C.fmtInt(k) + ' kcal (' + s.protein + '% / ' + s.carbs + '% / ' + s.fat + '%)';
  };

  // ----------------------------------------------------------- validation
  C.validateFood = (input) => {
    const errors = {}, warnings = {};
    const name = String(input.name || '').trim();
    if (name.length < 1) errors.name = 'Name is required';
    else if (name.length > 80) errors.name = 'Keep the name under 80 characters';
    const unit = C.isFoodUnit(input.unit) ? input.unit : null;
    if (!unit) errors.unit = 'Choose g, ml or pieces';
    let basis = null;
    const bR = C.parseNum(input.basis);
    if (!bR.ok) errors.basis = bR.empty ? 'How much is the label for? e.g. 100 g, 240 ml or 1 piece' : bR.error;
    else if (!(bR.value > 0 && bR.value <= 10000)) errors.basis = 'Enter an amount between 0 and 10,000';
    else basis = bR.value;
    let kcal = null, fromKj = null, kcalComputed = false;
    const eR = C.parseEnergy(input.kcal);
    if (eR.ok) {
      kcal = eR.value; fromKj = eR.fromKj;
      if (input.energyUnit === 'kJ' && fromKj == null) { fromKj = kcal; kcal = C.kjToKcal(kcal); }
      if (!(kcal >= 0 && kcal <= 10000)) { errors.kcal = 'Enter calories between 0 and 10,000'; kcal = null; }
    } else if (!eR.empty) errors.kcal = eR.error;
    const macros = {};
    ['protein', 'carbs', 'fat'].forEach((k) => {
      const r = C.parseNum(input[k]);
      if (!r.ok) { errors[k] = r.empty ? 'Enter 0 if the label says 0' : r.error; return; }
      if (r.value < 0) { errors[k] = "Can't be negative"; return; }
      macros[k] = r.value;
    });
    let fiber = null;
    const fR = C.parseNum(input.fiber);
    if (fR.ok) { if (fR.value < 0) errors.fiber = "Can't be negative"; else fiber = fR.value; }
    else if (!fR.empty) errors.fiber = fR.error;
    if (basis != null && unit) {
      ['protein', 'carbs', 'fat', 'fiber'].forEach((k) => {
        const v = k === 'fiber' ? fiber : macros[k];
        if (v == null || errors[k]) return;
        if (unit === 'g' && v > basis) errors[k] = LABEL[k] + " can't exceed the label's " + C.fmt1(basis) + ' g';
        else if (unit === 'ml' && v > 1.5 * basis) warnings.dense = 'More grams than ml — double-check the label';
      });
    }
    const haveMacros = macros.protein != null && macros.carbs != null && macros.fat != null;
    if (kcal == null && !errors.kcal && haveMacros) { kcal = Math.round(C.macroKcal(macros.protein, macros.carbs, macros.fat)); kcalComputed = true; }
    if (kcal != null && haveMacros && !kcalComputed) {
      const chk = C.kcalCheck(kcal, macros.protein, macros.carbs, macros.fat);
      warnings.macroKcal = Math.round(chk.macroKcal);
      if (chk.mismatch) warnings.kcal = 'Check this — the macros add up to ' + Math.round(chk.macroKcal) + ' kcal, the label says ' + C.fmt1(kcal);
    }
    const quick = [];
    (input.quick || []).forEach((q) => {
      const label = String((q && q.label) || '').trim();
      const r = C.parseNum(q && q.amount);
      if (label && r.ok && r.value > 0 && r.value <= 10000) quick.push({ label: label.slice(0, 30), amount: C.round1(r.value) });
    });
    const ok = Object.keys(errors).length === 0;
    return {
      ok, errors, warnings, kcalComputed, fromKj,
      food: ok ? {
        name, brand: String(input.brand || '').trim().slice(0, 80), unit, basis: C.round3(basis),
        kcal: C.round3(kcal), protein: C.round3(macros.protein), carbs: C.round3(macros.carbs), fat: C.round3(macros.fat),
        fiber: fiber == null ? null : C.round3(fiber), quick, favorite: !!input.favorite,
      } : null,
    };
  };
  // Units a food can be measured in: grams, millilitres, or pieces (1 taco, 2 oranges).
  C.FOOD_UNITS = ['g', 'ml', 'pc'];
  C.isFoodUnit = (u) => C.FOOD_UNITS.indexOf(u) >= 0;
  C.unitLabel = (u) => (u === 'serving' ? '×' : (u || ''));
  C.unitName = (u) => (u === 'pc' ? 'pieces' : u === 'ml' ? 'ml' : u === 'g' ? 'grams' : 'servings');
  C.checkAmount = (v, lastAmount, unit) => {
    if (!(isNum(v) && v > 0)) return { ok: false, error: 'Enter an amount above 0' };
    if (v > 10000) return { ok: false, error: "That's more than 10,000 — typo?" };
    // Counting pieces: 6 tacos after 1 last time is normal, so only flag implausibly large counts.
    const warn = unit === 'pc' ? v > 50 : (v > 2000 || (isNum(lastAmount) && lastAmount > 0 && v > 5 * lastAmount));
    return { ok: true, value: C.round1(v), warning: warn ? 'unusually large — typo?' : null };
  };
  C.weightRange = (unit) => (unit === 'kg' ? [20, 400] : [44, 880]);
  C.checkWeight = (v, unit, prev) => {
    if (!isNum(v)) return { ok: false, error: 'Enter a number' };
    const [lo, hi] = C.weightRange(unit);
    if (v < lo || v > hi) return { ok: false, error: 'Enter a weight between ' + lo + ' and ' + hi + ' ' + unit };
    let warning = null;
    if (prev && isNum(prev.v)) {
      const p = C.toUnit(prev.v, prev.u, unit);
      const pct = (v - p) / p;
      if (Math.abs(pct) > 0.10) warning = C.fmt1(p) + ' → ' + C.fmt1(v) + ' ' + unit + ', ' + (pct > 0 ? '+' : '') + Math.round(pct * 100) + '% — looks off?';
    }
    return { ok: true, value: C.round1(v), warning };
  };
  C.validateTargets = (input) => {
    const errors = {};
    const from = String(input.from || '').trim();
    if (!C.isKey(from)) errors.from = 'Pick a date';
    const out = { from };
    const lim = { kcal: 10000, protein: 2000, carbs: 2000, fat: 2000, fiber: 2000 };
    Object.keys(lim).forEach((k) => {
      const r = C.parseNum(input[k]);
      if (!r.ok) { if (r.empty) out[k] = null; else errors[k] = r.error; return; }
      if (r.value < 0 || r.value > lim[k]) { errors[k] = 'Enter a value between 0 and ' + lim[k].toLocaleString('en-US'); return; }
      out[k] = r.value;
    });
    return { ok: Object.keys(errors).length === 0, errors, target: out };
  };

  // ----------------------------------------------- readers & sanitizers
  const str = (x, max) => (typeof x === 'string' ? x.trim().slice(0, max || 200) : '');
  const strOrNull = (x) => (typeof x === 'string' && x ? x : null);
  const idOrNull = (x) => (C.isId(x) ? x : null);
  C.sanitizeFood = (d) => {
    if (!isObj(d)) return null;
    const id = idOrNull(d.id), name = str(d.name, 80);
    if (!id || name.length < 1) return null;
    const unit = C.isFoodUnit(d.unit) ? d.unit : null;
    if (!unit) return null;
    if (!(isNum(d.basis) && d.basis > 0 && d.basis <= 10000)) return null;
    const out = { id, name, brand: str(d.brand, 80), unit, basis: d.basis };
    for (const k of ['kcal', 'protein', 'carbs', 'fat']) { if (!(isNum(d[k]) && d[k] >= 0)) return null; out[k] = d[k]; }
    out.fiber = isNum(d.fiber) && d.fiber >= 0 ? d.fiber : null;
    out.quick = Array.isArray(d.quick) ? d.quick.filter((q) => q && typeof q.label === 'string' && q.label.trim() && isNum(q.amount) && q.amount > 0).map((q) => ({ label: q.label.trim().slice(0, 30), amount: q.amount })) : [];
    out.favorite = !!d.favorite; out.archived = !!d.archived;
    out.useCount = Number.isInteger(d.useCount) && d.useCount >= 0 ? d.useCount : 0;
    out.lastUsedAt = strOrNull(d.lastUsedAt);
    out.lastAmount = isNum(d.lastAmount) && d.lastAmount > 0 ? d.lastAmount : null;
    out.createdAt = strOrNull(d.createdAt); out.updatedAt = strOrNull(d.updatedAt);
    return out;
  };
  C.sanitizeEntry = (e, id) => {
    if (!isObj(e)) return null;
    const eid = idOrNull(id != null ? id : e.id);
    if (!eid) return null;
    if (!(isNum(e.amount) && e.amount > 0)) return null;
    const unit = C.isFoodUnit(e.unit) || e.unit === 'serving' ? e.unit : null;
    if (!unit) return null;
    if (!(isNum(e.basis) && e.basis > 0)) return null;
    const n = isObj(e.n) ? e.n : null;
    if (!n) return null;
    const nn = {};
    for (const k of ['kcal', 'protein', 'carbs', 'fat']) { if (!(isNum(n[k]) && n[k] >= 0)) return null; nn[k] = n[k]; }
    nn.fiber = isNum(n.fiber) && n.fiber >= 0 ? n.fiber : null;
    return {
      id: eid, foodId: idOrNull(e.foodId), name: str(e.name, 80) || 'Unknown food', brand: str(e.brand, 80),
      amount: e.amount, unit, basis: e.basis, n: nn, mealId: idOrNull(e.mealId), at: strOrNull(e.at),
    };
  };
  // Live entries of a day doc (map with tombstones) in logged order (at, id). Unreadable records are
  // skipped (they stay in the document; only writers that patch them can ever change them).
  const entriesCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  const entryOrder = (a, b) => ((a.at || '') < (b.at || '') ? -1 : (a.at || '') > (b.at || '') ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  C.dayEntries = (doc) => {
    if (!isObj(doc) || !isObj(doc.entries)) return [];
    if (entriesCache && entriesCache.has(doc)) return entriesCache.get(doc);
    const out = [];
    Object.keys(doc.entries).forEach((id) => { const raw = doc.entries[id]; if (raw == null) return; const e = C.sanitizeEntry(raw, id); if (e) out.push(e); });
    out.sort(entryOrder);
    if (entriesCache) entriesCache.set(doc, out);
    return out;
  };
  C.unreadableEntries = (doc) => {
    if (!isObj(doc) || !isObj(doc.entries)) return 0;
    let n = 0;
    Object.keys(doc.entries).forEach((id) => { const raw = doc.entries[id]; if (raw != null && !C.sanitizeEntry(raw, id)) n++; });
    return n;
  };
  C.isLogged = (doc) => C.dayEntries(doc).length > 0;
  C.isAllTombstones = (doc) => isObj(doc) && isObj(doc.entries) && Object.keys(doc.entries).length > 0 && Object.keys(doc.entries).every((k) => doc.entries[k] == null);
  // Import-time day sanitize: drops tombstones and unreadable entries (the user reviews the counts).
  C.sanitizeDay = (d, key) => {
    if (!isObj(d) || !C.isKey(key)) return { value: null, skipped: 0 };
    const src = isObj(d.entries) ? d.entries : {};
    const entries = {};
    let n = 0, skipped = 0;
    Object.keys(src).forEach((id) => { const raw = src[id]; if (raw == null) return; const e = C.sanitizeEntry(raw, id); if (e) { entries[e.id] = e; n++; } else skipped++; });
    if (!n) return { value: null, skipped };
    return { value: { date: key, entries, updatedAt: strOrNull(d.updatedAt) }, skipped };
  };
  C.sanitizeMeal = (d) => {
    if (!isObj(d)) return null;
    const id = idOrNull(d.id), name = str(d.name, 60);
    if (!id || !name) return null;
    const items = Array.isArray(d.items) ? d.items.filter((it) => it && idOrNull(it.foodId) && isNum(it.amount) && it.amount > 0).map((it) => ({ foodId: it.foodId, amount: it.amount })) : [];
    if (!items.length) return null;
    return { id, name, items, useCount: Number.isInteger(d.useCount) && d.useCount >= 0 ? d.useCount : 0, lastUsedAt: strOrNull(d.lastUsedAt), createdAt: strOrNull(d.createdAt), updatedAt: strOrNull(d.updatedAt) };
  };
  C.validWeighIn = (k, w) => {
    if (!C.isKey(k) || !isObj(w)) return null;
    const u = w.u === 'kg' || w.u === 'lb' ? w.u : null;
    if (!u) return null;
    const [lo, hi] = C.weightRange(u);
    if (!(isNum(w.v) && w.v >= lo && w.v <= hi)) return null;
    return { v: w.v, u, at: strOrNull(w.at) };
  };
  // weightsByYear: { '2026': doc } -> { date: {v,u,at} } live, valid weigh-ins
  C.liveWeights = (weightsByYear) => {
    const out = {};
    Object.keys(weightsByYear || {}).forEach((y) => {
      const doc = weightsByYear[y];
      if (!isObj(doc) || !isObj(doc.byDate)) return;
      Object.keys(doc.byDate).forEach((k) => { const w = C.validWeighIn(k, doc.byDate[k]); if (w) out[k] = w; });
    });
    return out;
  };
  C.sanitizeWeightsDoc = (d, year) => {
    const byDate = {};
    let skipped = 0;
    const src = isObj(d) && isObj(d.byDate) ? d.byDate : {};
    Object.keys(src).forEach((k) => { if (src[k] == null) return; const w = C.validWeighIn(k, src[k]); if (w && (!year || k.slice(0, 4) === year)) byDate[k] = w; else skipped++; });
    return { value: { year: year || (isObj(d) && strOrNull(d.year)) || null, byDate, updatedAt: isObj(d) ? strOrNull(d.updatedAt) : null }, skipped, count: Object.keys(byDate).length };
  };
  C.sanitizeApp = (d) => {
    const src = isObj(d) ? d : {};
    const s = isObj(src.settings) ? src.settings : {};
    const settings = {
      weightUnit: s.weightUnit === 'kg' ? 'kg' : 'lb',
      goalWeight: isObj(s.goalWeight) && isNum(s.goalWeight.value) && s.goalWeight.value > 0 && (s.goalWeight.unit === 'kg' || s.goalWeight.unit === 'lb') ? { value: s.goalWeight.value, unit: s.goalWeight.unit } : null,
      weightFirst: s.weightFirst !== false,
    };
    const targets = {};
    const lim = { kcal: 10000, protein: 2000, carbs: 2000, fat: 2000, fiber: 2000 };
    const srcT = Array.isArray(src.targets) ? src.targets.reduce((m, t) => { if (t && C.isKey(t.from)) m[t.from] = t; return m; }, {}) : (isObj(src.targets) ? src.targets : {});
    Object.keys(srcT).forEach((k) => {
      const t = srcT[k];
      if (!C.isKey(k) || !isObj(t)) return;
      const o = {};
      Object.keys(lim).forEach((f) => { o[f] = isNum(t[f]) && t[f] >= 0 && t[f] <= lim[f] ? t[f] : null; });
      targets[k] = o;
    });
    return {
      schemaVersion: Number.isInteger(src.schemaVersion) ? src.schemaVersion : C.SCHEMA,
      createdAt: strOrNull(src.createdAt), updatedAt: strOrNull(src.updatedAt), lastBackupAt: strOrNull(src.lastBackupAt),
      firstYear: C.isYear(src.firstYear) ? src.firstYear : null,
      settings, targets,
    };
  };

  // --------------------------------------------------------------- search
  C.tokenize = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}%]+/u).filter(Boolean);
  C.normQuery = (q) => String(q || '').toLowerCase().trim().replace(/\s+/g, ' ');
  C.rankItems = (query, items, use30, limit) => {
    const q = C.normQuery(query);
    const qTokens = C.tokenize(q);
    const scored = [];
    items.forEach((it) => {
      const rec = it.type === 'food' ? it.food : it.meal;
      if (it.type === 'food' && rec.archived) return;
      const name = String(rec.name || '').toLowerCase();
      const words = C.tokenize(name).concat(it.type === 'food' ? C.tokenize(rec.brand) : []);
      let tier;
      if (!q) tier = 3;
      else if (name.startsWith(q)) tier = 1;
      else if (qTokens.length && qTokens.every((t) => words.some((w) => w.startsWith(t)))) tier = 2;
      else return;
      const use = (it.type === 'food' ? use30.foods.get(rec.id) : use30.meals.get(rec.id)) || 0;
      scored.push({ it, tier, use, name });
    });
    scored.sort((a, b) => a.tier - b.tier || b.use - a.use || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out = scored.map((s) => s.it);
    return limit ? out.slice(0, limit) : out;
  };
  // days: { date: dayDoc }
  C.use30 = (days, todayKey) => {
    const lo = C.addDays(todayKey, -29);
    const foods = new Map(), meals = new Map();
    Object.keys(days).forEach((k) => {
      if (k < lo || k > todayKey) return;
      const seenMeals = new Set();
      C.dayEntries(days[k]).forEach((e) => {
        if (e.foodId) foods.set(e.foodId, (foods.get(e.foodId) || 0) + 1);
        if (e.mealId && !seenMeals.has(e.mealId)) { seenMeals.add(e.mealId); meals.set(e.mealId, (meals.get(e.mealId) || 0) + 1); }
      });
    });
    return { foods, meals };
  };
  C.chips = (foods, meals, use30, max) => {
    const byName = (a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
    const fav = Object.values(foods).filter((f) => f.favorite && !f.archived)
      .sort((a, b) => (use30.foods.get(b.id) || 0) - (use30.foods.get(a.id) || 0) || byName(a, b))
      .map((f) => ({ type: 'food', food: f }));
    const seen = new Set(fav.map((c) => c.food.id));
    const rest = [];
    Object.values(foods).forEach((f) => { const u = use30.foods.get(f.id) || 0; if (!f.archived && !seen.has(f.id) && u > 0) rest.push({ type: 'food', food: f, use: u, name: f.name }); });
    Object.values(meals).forEach((m) => { const u = use30.meals.get(m.id) || 0; if (u > 0) rest.push({ type: 'meal', meal: m, use: u, name: m.name }); });
    rest.sort((a, b) => b.use - a.use || byName(a, b));
    return fav.concat(rest.map((r) => (r.type === 'food' ? { type: 'food', food: r.food } : { type: 'meal', meal: r.meal }))).slice(0, max || 12);
  };

  // --------------------------------------------------------------- weight
  const KG_PER_LB = 0.45359237;
  C.toUnit = (v, from, to) => (from === to ? v : (to === 'kg' ? v * KG_PER_LB : v / KG_PER_LB));
  C.weightSeries = (byDate, unit) => Object.keys(byDate || {}).filter(C.isKey).sort()
    .map((k) => ({ date: k, v: C.toUnit(byDate[k].v, byDate[k].u, unit), raw: byDate[k] }));
  C.trend = (series) => {
    const t = [];
    for (let i = 0; i < series.length; i++) {
      if (i === 0) t.push(series[0].v);
      else { const gap = Math.max(1, C.daysBetween(series[i - 1].date, series[i].date)); const a = 1 - Math.pow(0.9, gap); t.push(t[i - 1] + a * (series[i].v - t[i - 1])); }
    }
    return t;
  };
  C.sevenDayAvg = (series, key) => {
    const lo = C.addDays(key, -6);
    const vals = series.filter((p) => p.date >= lo && p.date <= key).map((p) => p.v);
    if (vals.length < 2) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  C.ratePerWeek = (series, trend) => {
    const n = series.length;
    if (n < 2) return null;
    const P = n - 1, cutoff = C.addDays(series[P].date, -28);
    let Q = -1;
    for (let i = P - 1; i >= 0; i--) if (series[i].date <= cutoff) { Q = i; break; }
    if (Q < 0) { if (C.daysBetween(series[0].date, series[P].date) >= 14) Q = 0; else return null; }
    const days = C.daysBetween(series[Q].date, series[P].date);
    return days > 0 ? (trend[P] - trend[Q]) / days * 7 : null;
  };
  C.changeOverRange = (series, trend, startKey) => {
    const idx = [];
    series.forEach((p, i) => { if (p.date >= startKey) idx.push(i); });
    if (idx.length < 2) return null;
    const a = idx[0], b = idx[idx.length - 1];
    const days = C.daysBetween(series[a].date, series[b].date);
    const change = trend[b] - trend[a];
    return { change, perWeek: days > 0 ? change / days * 7 : null, days };
  };
  C.rangeStart = (range, today, firstKey) => {
    if (range === 'All') {
      const n = firstKey ? Math.max(14, C.daysBetween(firstKey, today) + 1) : 14;
      return { start: C.addDays(today, -(n - 1)), n };
    }
    const n = C.RANGE_DAYS[range] || 91;
    return { start: C.addDays(today, -(n - 1)), n };
  };

  // --------------------------------------------------------- weekly table
  C.weeklyRows = (days, series, trend, startKey, todayKey, maxRows) => {
    const trendByDate = {};
    series.forEach((p, i) => { trendByDate[p.date] = trend[i]; });
    const lastTrendOfWeek = (mon) => { for (let i = 6; i >= 0; i--) { const k = C.addDays(mon, i); if (trendByDate[k] != null) return trendByDate[k]; } return null; };
    const rows = [];
    let mon = C.weekMonday(todayKey);
    const firstMon = C.weekMonday(startKey);
    while (mon >= firstMon && rows.length < (maxRows || 52)) {
      const r = { logged: 0, kcal: 0, protein: 0, carbs: 0, fat: 0, weights: [] };
      for (let i = 0; i < 7; i++) {
        const k = C.addDays(mon, i);
        if (k > todayKey) continue;
        const es = days[k] ? C.dayEntries(days[k]) : [];
        if (es.length) { const t = C.dayTotals(es); r.logged++; r.kcal += t.kcal; r.protein += t.protein; r.carbs += t.carbs; r.fat += t.fat; }
      }
      const sun = C.addDays(mon, 6);
      series.forEach((p) => { if (p.date >= mon && p.date <= sun) r.weights.push(p.v); });
      const out = { week: mon, logged: r.logged, avgKcal: null, avgProtein: null, avgCarbs: null, avgFat: null, avgWeight: null, trendChange: null };
      if (r.logged) { out.avgKcal = r.kcal / r.logged; out.avgProtein = r.protein / r.logged; out.avgCarbs = r.carbs / r.logged; out.avgFat = r.fat / r.logged; }
      if (r.weights.length) out.avgWeight = r.weights.reduce((a, b) => a + b, 0) / r.weights.length;
      const tThis = lastTrendOfWeek(mon), tPrev = lastTrendOfWeek(C.addDays(mon, -7));
      if (tThis != null && tPrev != null) out.trendChange = tThis - tPrev;
      if (out.logged || out.avgWeight != null) rows.push(out);
      mon = C.addDays(mon, -7);
    }
    return rows;
  };

  // -------------------------------------------------------------- entries
  C.makeEntry = (food, amount, opts) => ({
    id: opts.id, foodId: food.id, name: food.name, brand: food.brand || '', amount: C.round1(amount), unit: food.unit, basis: food.basis,
    n: { kcal: food.kcal, protein: food.protein, carbs: food.carbs, fat: food.fat, fiber: food.fiber == null ? null : food.fiber },
    mealId: opts.mealId || null, at: opts.at || null,
  });
  C.makeQuickEntry = (q, opts) => ({
    id: opts.id, foodId: null, name: q.name, brand: '', amount: 1, unit: 'serving', basis: 1,
    n: { kcal: q.kcal || 0, protein: q.protein || 0, carbs: q.carbs || 0, fat: q.fat || 0, fiber: null }, mealId: null, at: opts.at || null,
  });
  C.copyEntries = (entries, at, idGen) => entries.map((e) => Object.assign({}, e, { n: Object.assign({}, e.n), id: idGen(), at }));
  C.expandMeal = (meal, foods, at, idGen) => {
    const entries = [], skipped = [];
    meal.items.forEach((it) => {
      const f = foods[it.foodId];
      if (!f) { skipped.push(it.foodId); return; }
      entries.push(C.makeEntry(f, it.amount, { id: idGen(), at, mealId: meal.id }));
    });
    return { entries, skipped };
  };
  C.foodReferences = (foodId, days, meals) => {
    let entries = 0;
    const mealNames = [];
    Object.keys(days).forEach((k) => C.dayEntries(days[k]).forEach((e) => { if (e.foodId === foodId) entries++; }));
    Object.values(meals).forEach((m) => { if (m.items.some((it) => it.foodId === foodId)) mealNames.push(m.name); });
    return { entries, mealNames };
  };
  C.placeholderFood = (entry, now) => ({
    id: entry.foodId, name: entry.name || 'Unknown food', brand: entry.brand || '', unit: C.isFoodUnit(entry.unit) ? entry.unit : 'g', basis: entry.basis,
    kcal: entry.n.kcal, protein: entry.n.protein, carbs: entry.n.carbs, fat: entry.n.fat, fiber: entry.n.fiber, quick: [], favorite: false, archived: true,
    useCount: 0, lastUsedAt: null, lastAmount: null, createdAt: now, updatedAt: now,
  });
  // patch helper: entries array -> { id: entry } map
  C.entriesPatch = (entries) => { const m = {}; entries.forEach((e) => { m[e.id] = e; }); return m; };

  // --------------------------------------------------------------- backup
  C.PATH_RE = {
    app: /^meta\/app$/, weights: /^weights\/(\d{4})$/, food: /^foods\/([A-Za-z0-9_\-.~:@+]{1,200})$/, meal: /^meals\/([A-Za-z0-9_\-.~:@+]{1,200})$/,
    day: /^years\/(\d{4})\/days\/(\d{4}-\d{2}-\d{2})$/,
  };
  // docs: { path: rawDoc } from a full enumeration. Tombstones are stripped; days without live entries are omitted.
  C.buildBackup = (docs, exportedAt) => {
    const out = {};
    Object.keys(docs).forEach((path) => {
      const d = docs[path];
      if (d == null) return;
      let m;
      if (C.PATH_RE.app.test(path)) { const a = C.sanitizeApp(d); out[path] = a; }
      else if ((m = C.PATH_RE.weights.exec(path))) { const r = C.sanitizeWeightsDoc(d, m[1]); if (r.count) out[path] = r.value; }
      else if ((m = C.PATH_RE.day.exec(path))) { const r = C.sanitizeDay(d, m[2]); if (r.value && m[2].slice(0, 4) === m[1]) out[path] = r.value; }
      else if (C.PATH_RE.food.test(path) || C.PATH_RE.meal.test(path)) out[path] = d;
    });
    return { app: 'tare', schemaVersion: C.SCHEMA, exportedAt, docs: out };
  };
  C.migrateDoc = (doc, fromVersion) => doc; // v1: nothing to migrate
  C.parseBackup = (text) => {
    let j;
    try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, error: 'This file is not valid JSON.' }; }
    if (!isObj(j) || j.app !== 'tare') return { ok: false, error: 'This is not a Tare backup file.' };
    if (!Number.isInteger(j.schemaVersion)) return { ok: false, error: 'This is not a Tare backup file (no schema version).' };
    if (j.schemaVersion > C.SCHEMA) return { ok: false, error: 'This backup was made by a newer version of Tare. Reload the page and try again.' };
    if (!isObj(j.docs)) return { ok: false, error: 'This backup has no data in it.' };
    const docs = {};
    let skipped = 0, newerApp = false;
    const sum = { foods: 0, meals: 0, days: 0, weights: 0, firstDay: null, lastDay: null, exportedAt: C.isTimestamp(j.exportedAt) ? j.exportedAt : null };
    Object.keys(j.docs).forEach((path) => {
      const body = C.migrateDoc(j.docs[path], (isObj(j.docs[path]) && Number.isInteger(j.docs[path].v)) ? j.docs[path].v : j.schemaVersion);
      let m;
      if (C.PATH_RE.app.test(path)) {
        const a = C.sanitizeApp(body);
        if (a.schemaVersion > C.SCHEMA) { newerApp = true; return; }
        a.schemaVersion = C.SCHEMA;
        docs[path] = a;
        return;
      }
      if ((m = C.PATH_RE.weights.exec(path))) { const r = C.sanitizeWeightsDoc(body, m[1]); skipped += r.skipped; if (r.count) { docs[path] = r.value; sum.weights += r.count; } return; }
      if ((m = C.PATH_RE.food.exec(path))) { const f = C.sanitizeFood(Object.assign({}, body, { id: m[1] })); if (f) { docs[path] = f; sum.foods++; } else skipped++; return; }
      if ((m = C.PATH_RE.meal.exec(path))) { const mm = C.sanitizeMeal(Object.assign({}, body, { id: m[1] })); if (mm) { docs[path] = mm; sum.meals++; } else skipped++; return; }
      if ((m = C.PATH_RE.day.exec(path))) {
        const key = m[2];
        if (!C.isKey(key) || key.slice(0, 4) !== m[1]) { skipped++; return; }
        const r = C.sanitizeDay(body, key); skipped += r.skipped;
        if (r.value) { docs[path] = r.value; sum.days++; if (!sum.firstDay || key < sum.firstDay) sum.firstDay = key; if (!sum.lastDay || key > sum.lastDay) sum.lastDay = key; }
        else if (!r.skipped) skipped++;
        return;
      }
      skipped++;
    });
    if (newerApp) return { ok: false, error: 'This backup was made by a newer version of Tare. Reload the page and try again.' };
    if (!docs['meta/app']) docs['meta/app'] = C.sanitizeApp({});
    if (sum.firstDay) { const y = sum.firstDay.slice(0, 4); if (!docs['meta/app'].firstYear || y < docs['meta/app'].firstYear) docs['meta/app'].firstYear = y; }
    return { ok: true, docs, skipped, summary: sum };
  };

  // ---------------------------------------------------------- starter set
  C.STARTER_FOODS = [
    ['Chicken breast, raw', 'g', 120, 22.5, 0, 2.6, 0],
    ['Egg, whole, raw', 'g', 143, 12.6, 0.7, 9.5, 0],
    ['White rice, cooked', 'g', 130, 2.7, 28.2, 0.3, 0.4],
    ['Rolled oats, dry', 'g', 379, 13.2, 67.7, 6.5, 10.1],
    ['Banana, raw', 'g', 89, 1.1, 22.8, 0.3, 2.6],
    ['Whole milk', 'ml', 61, 3.2, 4.8, 3.3, 0],
    ['Greek yogurt, plain, nonfat', 'g', 59, 10.2, 3.6, 0.4, 0],
    ['Potato, baked, flesh and skin', 'g', 93, 2.5, 21.2, 0.1, 2.2],
    ['Broccoli, raw', 'g', 34, 2.8, 6.6, 0.4, 2.6],
    ['Olive oil', 'ml', 800, 0, 0, 90.9, 0],
    ['Peanut butter, smooth', 'g', 588, 25.1, 20, 50.4, 6],
    ['Salmon, Atlantic, raw', 'g', 208, 20.4, 0, 13.4, 0],
  ];

  root.TareCore = C;
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);
