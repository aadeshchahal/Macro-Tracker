/* Tare — app.js
   Boot + mode selection, the data mirror (frozen snapshots + overlay of pending patches), live
   subscriptions per year, patch-based writes through the queue, shell (nav, banners, sync, toast,
   modal), and the Today screen. Foods / Progress / Settings live in screens.js and register on window.Tare. */
(function (root) {
  'use strict';
  const C = root.TareCore, S = root.TareStore;
  const T = root.Tare = { core: C, renderers: {}, hooks: {} };
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ DOM helper
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') el.style.cssText = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); };
    children.forEach(add);
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  T.h = h; T.$ = $; T.clear = clear; T.plural = plural;

  // ----------------------------------------------------------------- state
  const todayKey = C.todayKey();
  T.snap = { app: undefined, foods: {}, meals: {}, weights: {}, days: {} };
  T.def = { app: false, foods: false, meals: false, weights: false, days: {} };
  T.data = { app: null, foods: {}, meals: {}, weights: {}, days: {} };
  T.years = { loaded: {}, gc: {} };
  T.ui = {
    screen: 'today', todayKey, viewedDate: todayKey, query: '', picked: null, ddOpen: false, ddIndex: 0, quickAdd: false,
    editingEntryId: null, entriesDirty: false, editWeight: false, modal: null, undo: null, newDay: false, tilesDetail: false, expandedEntryId: null,
    foodFilter: 'all', foodSort: 'name', foodQuery: '', intakeMetric: 'kcal', weightRows: 30, selectedWeightDate: null,
    touch: !!(root.matchMedia && root.matchMedia('(hover: none) and (pointer: coarse)').matches),
    graphRange: (() => { try { const r = root.localStorage.getItem('tare.graphRange'); return C.RANGES.indexOf(r) >= 0 ? r : '3M'; } catch (e) { return '3M'; } })(),
    disconnected: false, readonlyCode: null, reconnecting: {}, unreadable: {}, remoteErased: false, cachedBanner: false, waitingBanner: false, skippedShown: false, cache: {}, batch: 0,
  };
  T.now = () => C.nowLocal();
  T.newId = (p) => C.newId(p);
  T.settings = () => (T.data.app ? T.data.app.settings : C.DEFAULT_SETTINGS);
  T.targetFor = (date) => (T.data.app ? C.targetFor(T.data.app.targets, date) : null);
  T.entries = (date) => C.dayEntries(T.data.days[date] || null);
  T.thisYear = () => T.ui.todayKey.slice(0, 4);
  T.lastYear = () => String(+T.thisYear() - 1);
  T.readonly = () => !!(T.ui.readonlyCode || T.ui.disconnected || T.ui.remoteErased || (T.queue && T.queue.isReadonly()) || (T.data.app && T.data.app.schemaVersion > C.SCHEMA));
  T.baseReady = () => T.def.app && T.def.foods && T.def.meals && T.def.weights && !!T.def.days[T.thisYear()] && !!T.def.days[T.lastYear()];
  // A day outside the two live year subscriptions is writable once its own doc subscription is definitive.
  T.dayReady = (date) => { const y = date.slice(0, 4); return y === T.thisYear() || y === T.lastYear() || T.def.viewed === date; };
  T.canWrite = () => !!T.queue && T.baseReady() && !T.readonly() && T.data.app != null && !T.ui.importing && (T.ui.screen !== 'today' || T.dayReady(T.ui.viewedDate));
  // Creating new documents is paused while the database is full (edits to existing ones still work).
  T.canCreate = () => T.canWrite() && !(T.queue && T.queue.blockedCount);
  T.use30 = () => { if (!T.ui.cache.use30) T.ui.cache.use30 = C.use30(T.data.days, T.ui.todayKey); return T.ui.cache.use30; };
  // The furthest day that can be planned ahead (e.g. tonight's breakfast prep for tomorrow).
  T.maxDateKey = () => C.addDays(T.ui.todayKey, C.MAX_FUTURE_DAYS);
  T.setGraphRange = (r) => { T.ui.graphRange = r; try { root.localStorage.setItem('tare.graphRange', r); } catch (e) { /* ignore */ } };

  // ------------------------------------------------------------- the mirror
  function overlay(path, base) { return T.queue ? T.queue.overlay(path, base) : base; }
  function recompute() {
    const d = { foods: {}, meals: {}, weights: {}, days: {} };
    const unreadable = {};
    const pendingPaths = T.queue ? T.queue.pendingPaths() : new Set();
    const appBody = overlay(C.PATHS.app, T.snap.app === undefined ? null : T.snap.app);
    d.app = appBody ? C.sanitizeApp(appBody) : null;
    const ids = (map, prefix) => { const s = new Set(Object.keys(map)); pendingPaths.forEach((p) => { if (p.indexOf(prefix) === 0 && p.split('/').length === prefix.split('/').length) s.add(p.slice(prefix.length)); }); return s; };
    ids(T.snap.foods, 'foods/').forEach((id) => { const b = overlay('foods/' + id, T.snap.foods[id] || null); const f = b && C.sanitizeFood(Object.assign({}, b, { id })); if (f) d.foods[id] = f; });
    ids(T.snap.meals, 'meals/').forEach((id) => { const b = overlay('meals/' + id, T.snap.meals[id] || null); const m = b && C.sanitizeMeal(Object.assign({}, b, { id })); if (m) d.meals[id] = m; });
    const wy = {};
    ids(T.snap.weights, 'weights/').forEach((y) => { const b = overlay('weights/' + y, T.snap.weights[y] || null); if (!b) return; if (C.isObj(b) && C.isObj(b.byDate)) wy[y] = b; else unreadable['weights/' + y] = b; });
    d.weights = C.liveWeights(wy);
    const dayKeys = new Set(Object.keys(T.snap.days));
    pendingPaths.forEach((p) => { const m = C.PATH_RE.day.exec(p); if (m) dayKeys.add(m[2]); });
    dayKeys.forEach((date) => {
      const path = C.dayPath(date);
      const base = T.snap.days[date] || null;
      const b = pendingPaths.has(path) ? overlay(path, base) : base;
      if (!b || date > T.maxDateKey()) return;
      if (C.isObj(b) && C.isObj(b.entries)) d.days[date] = b; else unreadable[path] = b;
    });
    T.data = d;
    T.ui.unreadable = unreadable;
    T.ui.cache = {};
  }
  function onData() {
    recompute();
    if (T.ui.batch) { T.ui.batch = 2; return; }
    render();
  }
  T.batch = (fn) => { T.ui.batch = 1; try { fn(); } finally { const need = T.ui.batch === 2; T.ui.batch = 0; if (need) render(); } };

  // ------------------------------------------------------------- writes
  const skeleton = (path) => {
    let m;
    if ((m = C.PATH_RE.day.exec(path))) return { date: m[2], entries: {}, updatedAt: null };
    if ((m = C.PATH_RE.weights.exec(path))) return { year: m[1], byDate: {}, updatedAt: null };
    if (C.PATH_RE.app.test(path)) return Object.assign(C.sanitizeApp({}), { createdAt: T.now() });
    return null;
  };
  // Foods/meals are only ever created from a full, valid record: a stray stats patch for a food that was
  // deleted on another device is dropped instead of leaving a nameless document behind.
  const canCreate = (path, body) => {
    let m;
    if ((m = C.PATH_RE.food.exec(path))) return !!C.sanitizeFood(Object.assign({}, body, { id: m[1] }));
    if ((m = C.PATH_RE.meal.exec(path))) return !!C.sanitizeMeal(Object.assign({}, body, { id: m[1] }));
    return false;
  };
  T.patch = (path, patch) => { if (!T.queue) return false; if (T.ui.unreadable[path]) { T.toast('This record has unreadable data — see Settings → Data'); return false; } const ok = T.queue.update(path, patch); if (!ok) T.toast('Read-only right now'); return ok; };
  T.setDoc = (path, body) => { if (!T.queue) return false; return T.queue.set(path, body); };
  T.del = (path) => { if (!T.queue) return false; return T.queue.delete(path); };
  T.patchApp = (patch) => T.patch(C.PATHS.app, patch);
  // Entries: regenerate any id colliding with the target day or the batch, then one keyed patch.
  T.appendEntries = (date, entries) => {
    const existing = T.data.days[date] && T.data.days[date].entries ? T.data.days[date].entries : {};
    const seen = new Set(Object.keys(existing));
    entries.forEach((e) => { while (seen.has(e.id)) e.id = C.newId('e_'); seen.add(e.id); });
    const now = T.now();
    T.patch(C.dayPath(date), { date, entries: C.entriesPatch(entries), updatedAt: now });
    const y = date.slice(0, 4);
    if (T.data.app && (!T.data.app.firstYear || y < T.data.app.firstYear)) T.patchApp({ firstYear: y });
    return entries.map((e) => e.id);
  };
  T.tombstone = (date, ids) => { const m = {}; ids.forEach((id) => { m[id] = null; }); T.patch(C.dayPath(date), { entries: m, updatedAt: T.now() }); };
  T.putEntry = (date, entry) => T.patch(C.dayPath(date), { entries: { [entry.id]: entry }, updatedAt: T.now() });
  T.bumpFood = (foodId, amount) => {
    const f = T.data.foods[foodId];
    if (!f) return;
    const p = { useCount: (f.useCount || 0) + 1, lastUsedAt: T.now(), updatedAt: T.now() };
    if (amount != null) p.lastAmount = amount;
    T.patch('foods/' + foodId, p);
  };
  T.saveWeighIn = (date, w) => T.patch(C.weightsPath(date.slice(0, 4)), { year: date.slice(0, 4), byDate: { [date]: w }, updatedAt: T.now() });
  T.removeWeighIn = (date) => T.patch(C.weightsPath(date.slice(0, 4)), { byDate: { [date]: null }, updatedAt: T.now() });

  // ------------------------------------------------------------------ boot
  async function boot() {
    try {
      const q = new URLSearchParams(location.search);
      const th = q.get('theme');
      if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
      const scr = (location.hash || '').slice(1);
      if (['foods', 'progress', 'settings'].indexOf(scr) >= 0) T.ui.screen = scr;
    } catch (e) { /* ignore */ }
    bindShell();
    bindToday();
    renderDayBar();
    renderSync();
    render();
    let db = null, downloads = null;
    if (typeof root.claude === 'undefined') {
      T.store = S.create(null, 'tare.docs');
    } else {
      try { db = await root.claude.use('db'); } catch (e) { db = null; }
      try { downloads = await root.claude.use('downloads'); } catch (e) { downloads = null; }
      if (!db) { T.ui.disconnected = true; renderBanners(); renderSync(); render(); return; }
      T.store = S.create(db);
    }
    T.downloads = downloads;
    T.mode = T.store.mode;
    T.framed = root.self !== root.top;
    T.queue = S.createQueue(T.store, {
      skeleton, canCreate,
      stash: {
        read: () => { try { return root.localStorage.getItem('tare.pending'); } catch (e) { return null; } },
        write: (t) => { try { root.localStorage.setItem('tare.pending', t); } catch (e) { /* ignore */ } },
      },
      canFlush: () => !T.ui.remoteErased && !(T.snap.app && Number.isInteger(T.snap.app.schemaVersion) && T.snap.app.schemaVersion > C.SCHEMA),
      onState: () => { renderSync(); renderBanners(); },
      onChange: onData,
      onRetry: () => renderBanners(),
      onDropped: (path) => { console.info('Tare: skipped a write to a record that no longer exists', path); },
      onError: (code, path, e) => {
        if (code === 'quota_exceeded') { T.ui.quotaMsg = (e && e.message) || ''; }
        else if (code === 'invalid_argument' || code === 'transform_error') { console.error('Tare: rejected write', path, e); T.toast("Couldn't save (invalid data)" + (e && /256/.test(String(e.message)) ? ' — the day is too large' : '')); }
        else { T.ui.readonlyCode = code; } // unsaved changes stay visible and exportable; the banner says so
        onData(); renderBanners(); renderSync();
      },
    });
    subscribeAll();
    setInterval(checkNewDay, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkNewDay(); T.queue.retryNow(); retryLive(); } });
    root.addEventListener('focus', checkNewDay);
    root.addEventListener('online', () => { T.queue.retryNow(); retryLive(); });
    root.addEventListener('beforeunload', (e) => { if (T.queue && T.queue.size > 0) { e.preventDefault(); e.returnValue = ''; } });
    setTimeout(() => { if (!T.baseReady() && !T.ui.readonlyCode) { T.ui.cachedBanner = true; renderBanners(); } }, 5000);
    setTimeout(() => { if (T.mode === 'db' && !T.def.app && T.snap.app === undefined && !T.ui.readonlyCode) { T.ui.waitingBanner = true; renderBanners(); } }, 15000);
    renderSync(); renderBanners(); render();
  }

  // ----------------------------------------------------------- subscriptions
  const lives = {};
  function retryLive() { Object.keys(lives).forEach((k) => lives[k] && lives[k].retry()); }
  function liveOpts(key) {
    return {
      onRetry: (n) => { T.ui.reconnecting[key] = n; renderBanners(); },
      onOk: () => { if (T.ui.reconnecting[key]) { delete T.ui.reconnecting[key]; renderBanners(); } },
      onFatal: (code, e) => { console.error('Tare: subscription failed', key, code, e); T.ui.readonlyCode = code; if (T.queue) T.queue.stop(false); renderBanners(); renderSync(); render(); },
    };
  }
  const defin = (meta) => !(meta && meta.fromCache);
  const newerSchema = (body) => !!(body && Number.isInteger(body.schemaVersion) && body.schemaVersion > C.SCHEMA);
  function subscribeAll() {
    const st = T.store;
    lives.app = S.live((next, err) => st.onDoc(C.PATHS.app, next, err), (body, meta) => {
      const hadApp = !!T.snap.app;
      T.snap.app = body;
      // Check the schema before anything from last session is replayed.
      if (newerSchema(body) && T.queue && !T.queue.isReadonly()) { T.queue.stop(false); T.toast('This data was saved by a newer Tare — reload to update'); }
      if (defin(meta)) {
        if (!T.def.app) { T.def.app = true; if (!newerSchema(body)) restorePending(); runGc(); }
        else if (hadApp && !body && !T.ui.erasing && !T.ui.importing) {
          // Erased on another device: drop this device's queued writes so they can't bring data back.
          T.ui.remoteErased = true;
          if (T.queue) T.queue.stop(true);
          try { root.localStorage.removeItem('tare.pending'); } catch (e) { /* ignore */ }
        }
      }
      onData(); renderBanners(); renderSync();
    }, liveOpts('settings'));
    const col = (name) => S.live((next, err) => st.onQuery(name, {}, next, err), (docs, meta) => {
      const m = {};
      docs.forEach((d) => { if (C.isId(d.id)) m[d.id] = d.body; });
      T.snap[name] = m;
      if (defin(meta)) T.def[name] = true;
      onData();
    }, liveOpts(name));
    lives.foods = col('foods');
    lives.meals = col('meals');
    lives.weights = col('weights');
    subscribeYear(T.thisYear());
    subscribeYear(T.lastYear());
  }
  function subscribeYear(year) {
    const key = 'year:' + year;
    if (lives[key]) return;
    lives[key] = S.live((next, err) => T.store.onQuery(C.daysCol(year), {}, next, err), (docs, meta) => {
      Object.keys(T.snap.days).forEach((k) => { if (k.slice(0, 4) === year) delete T.snap.days[k]; });
      docs.forEach((d) => { if (C.isKey(d.id) && d.id.slice(0, 4) === year) T.snap.days[d.id] = d.body; });
      T.years.loaded[year] = true;
      if (defin(meta)) { T.def.days[year] = true; runGc(); }
      onData();
    }, liveOpts('days ' + year));
  }
  function unsubscribeYear(year) {
    const key = 'year:' + year;
    if (lives[key]) { lives[key].stop(); delete lives[key]; }
    delete T.years.loaded[year]; delete T.def.days[year]; delete T.ui.reconnecting['days ' + year];
  }
  T.stopAllSubscriptions = () => { Object.keys(lives).forEach((k) => { if (lives[k]) lives[k].stop(); delete lives[k]; }); };
  // Housekeeping: a past day (older than two days) whose entries were all removed is deleted, once per year,
  // and only after last session's unsent writes have been handed back to the queue.
  function runGc() {
    if (!T.queue || !T.def.app || T.queue.isReadonly()) return;
    const cutoff = C.addDays(T.ui.todayKey, -2);
    [T.thisYear(), T.lastYear()].forEach((year) => {
      if (T.years.gc[year] || !T.def.days[year]) return;
      T.years.gc[year] = true;
      Object.keys(T.snap.days).forEach((k) => { if (k.slice(0, 4) === year && k < cutoff && C.isAllTombstones(T.snap.days[k]) && !T.queue.hasPending(C.dayPath(k))) T.queue.delete(C.dayPath(k)); });
    });
  }
  function restorePending() {
    if (!T.queue) return;
    const n = T.queue.heldCount;
    if (!n) return;
    T.queue.restore();
    T.toast('Saving ' + plural(n, 'change') + ' from last time');
  }
  // A viewed day outside the two live years gets its own live doc subscription (single slot).
  T.setViewedDaySub = (date) => {
    if (lives.viewed) { lives.viewed.stop(); lives.viewed = null; }
    T.def.viewed = null;
    const y = date.slice(0, 4);
    if (!T.store || y === T.thisYear() || y === T.lastYear()) return;
    lives.viewed = S.live((next, err) => T.store.onDoc(C.dayPath(date), next, err), (body, meta) => {
      if (body) T.snap.days[date] = body; else delete T.snap.days[date];
      if (defin(meta)) T.def.viewed = date;
      onData();
    }, liveOpts('day'));
  };
  T.loadYear = (y) => {
    if (T.years.loaded[y] || !T.store) return Promise.resolve();
    return T.store.query(C.daysCol(y), {}).then((docs) => { docs.forEach((d) => { if (C.isKey(d.id)) T.snap.days[d.id] = d.body; }); T.years.loaded[y] = true; onData(); });
  };
  // Years to enumerate, from firstYear (bounded to 30 years back, never before 2000) to this year.
  T.allYears = () => {
    const now = +T.thisYear();
    let first = T.data.app && C.isYear(T.data.app.firstYear) ? +T.data.app.firstYear : now;
    first = Math.min(now, Math.max(first, now - 30, +C.MIN_YEAR));
    const out = [];
    for (let y = first; y <= now; y++) out.push(String(y));
    return out;
  };
  T.loadAllYears = () => T.allYears().filter((y) => !T.years.loaded[y]).reduce((p, y) => p.then(() => T.loadYear(y)), Promise.resolve());

  // ----------------------------------------------------------------- shell
  function bindShell() {
    document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => T.go(b.dataset.screen)));
    document.addEventListener('keydown', onGlobalKey);
    let blurT = null;
    document.addEventListener('focusin', (e) => { if (isField(e.target)) { if (blurT) clearTimeout(blurT); document.body.classList.add('typing'); } });
    document.addEventListener('focusout', (e) => { if (isField(e.target)) { blurT = setTimeout(() => { if (!isField(document.activeElement)) document.body.classList.remove('typing'); }, 100); } });
  }
  const isField = (el) => !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
  T.go = (screen) => {
    if (T.ui.screen === screen) { render(); return; }
    T.ui.screen = screen;
    render();
    if (screen === 'foods' && !T.ui.touch) setTimeout(() => { const s = $('food-search'); if (s) s.focus(); }, 0);
    root.scrollTo(0, 0);
  };
  function onGlobalKey(e) {
    const a = document.activeElement;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { if (T.ui.modal) { e.preventDefault(); T.closeModal(); } return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      const searchEmpty = a && a.id === 'search' && !a.value;
      if (T.ui.undo && !T.ui.modal && (!isField(a) || searchEmpty)) { e.preventDefault(); T.runUndo(); }
      return;
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); if (T.ui.screen === 'today') T.setDate(C.addDays(T.ui.viewedDate, e.key === 'ArrowLeft' ? -1 : 1)); return; }
    if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); if (T.ui.screen !== 'today') T.go('today'); T.setDate(T.ui.todayKey); return; }
    if (isField(a) || T.ui.modal) return;
    if (e.key === '/') { e.preventDefault(); if (T.ui.screen !== 'today') T.go('today'); const s = $('search'); if (s && !s.disabled && !s.parentElement.hidden) { s.focus(); s.select(); } return; }
    if (e.key.toLowerCase() === 'n' && T.ui.screen === 'foods' && T.hooks.newFood) { e.preventDefault(); T.hooks.newFood(); }
  }
  function renderNav() {
    document.querySelectorAll('.nav-btn').forEach((b) => {
      const on = b.dataset.screen === T.ui.screen;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    ['today', 'foods', 'progress', 'settings'].forEach((s) => { const el = $('screen-' + s); if (el) el.hidden = s !== T.ui.screen; });
    const toast = $('toast');
    if (toast && T.ui.screen !== 'today' && toast.parentElement && toast.parentElement.id === 'addbox') { $('app').appendChild(toast); toast.classList.remove('in-flow'); }
  }
  function renderSync() {
    const el = $('sync'), txt = $('sync-text');
    if (!el) return;
    el.className = 'sync';
    if (T.ui.disconnected) { el.classList.add('off'); txt.textContent = 'Not connected'; return; }
    if (!T.store) { txt.textContent = 'Connecting…'; return; }
    if (T.readonly()) { el.classList.add('off'); txt.textContent = 'Read-only'; return; }
    const st = T.queue.state;
    if (T.mode !== 'db') { el.classList.add(st === 'pending' || st === 'blocked' ? 'pending' : 'ok'); txt.textContent = st === 'pending' || st === 'blocked' ? 'Not saved' : 'Local mode'; return; }
    if (st === 'saving') { el.classList.add('ok'); txt.textContent = 'Saving…'; }
    else if (st === 'pending') { el.classList.add('pending'); txt.textContent = 'Not saved yet — retrying'; }
    else if (st === 'blocked') { el.classList.add('off'); txt.textContent = 'Not saved — storage full'; }
    else { el.classList.add('ok'); txt.textContent = T.baseReady() ? 'Synced' : 'Loading…'; }
  }
  let lastBanners = '';
  function renderBanners() {
    const box = $('banners');
    if (!box) return;
    const list = [];
    const add = (cls, text, btns) => list.push({ cls, text, btns: btns || [] });
    const reload = () => location.reload();
    const exportNow = () => T.hooks.exportBackup && T.hooks.exportBackup();
    const stranded = T.queue && T.queue.isReadonly() && !T.ui.remoteErased ? T.queue.size : 0;
    const strandedNote = stranded ? ' ' + plural(stranded, 'change') + " couldn't be saved — export a backup now, then reload." : '';
    const reconnect = Math.max(0, ...Object.values(T.ui.reconnecting));
    if (T.ui.disconnected) add('banner-crit', "Couldn't connect to your data — reload, or open Tare from claude.ai. Nothing you type here is saved.", [['Reload', reload]]);
    else if (T.ui.remoteErased) add('banner-crit', 'Your data was erased from another device. Reload to start again.', [['Reload', reload]]);
    else {
      if (T.ui.readonlyCode) add('banner-crit', "Tare can't reach your data right now." + (strandedNote || ' Reload the page.'), stranded ? [['Export now', exportNow], ['Reload', reload]] : [['Reload', reload]]);
      else if (T.data.app && T.data.app.schemaVersion > C.SCHEMA) add('banner-crit', 'This data was saved by a newer version of Tare. The page is read-only until you reload.' + strandedNote, stranded ? [['Export now', exportNow], ['Reload', reload]] : [['Reload', reload]]);
      if (T.queue && T.queue.blockedCount) add('banner-crit', 'Not saved — the database is full. ' + (T.ui.quotaMsg || '') + ' Free space by deleting archived foods or old meals, then retry.', [['Export now', exportNow], ['Retry', () => T.queue.retryNow(true)]]);
      else if (T.queue && T.queue.state === 'pending') add('banner-warn', (typeof navigator !== 'undefined' && navigator.onLine === false) ? "You're offline — changes will save when you're back online (don't close this page)" : 'Changes not saved yet — retrying…', [['Retry now', () => T.queue.retryNow()]]);
      if (T.queue && T.queue.isPaused()) add('banner-warn', 'Too many changes at once — retrying…');
    }
    if (reconnect >= 10) add('banner-warn', 'Live sync paused — reload the page.', [['Reload', reload]]);
    else if (reconnect >= 2) add('banner-info', 'Reconnecting…');
    if (T.ui.waitingBanner && !T.def.app) add('banner-info', 'Waiting for permission or connection…', [['Reload', () => location.reload()]]);
    else if (T.ui.cachedBanner && !T.baseReady() && T.mode === 'db') add('banner-info', 'Working from cached data — logging is enabled once we reconnect');
    if (T.mode === 'local' && T.store) add('banner-info', 'Local mode — data is saved in this browser only. Open Tare from your Claude link to sync between devices.');
    if (T.ui.newDay) add('banner-info', "It's a new day.", [['Go to today', () => { T.ui.newDay = false; T.setDate(T.ui.todayKey); renderBanners(); }]]);
    // Only touch the live region when something changed, so screen readers don't re-announce on every save.
    const sig = JSON.stringify(list.map((b) => [b.cls, b.text, b.btns.map((x) => x[0])]));
    if (sig === lastBanners) return;
    lastBanners = sig;
    clear(box);
    list.forEach((b) => box.appendChild(h('div', { class: 'banner ' + b.cls }, h('span', { text: b.text }), b.btns.map((x) => h('button', { class: 'btn btn-sm', type: 'button', onclick: x[1] }, x[0])))));
  }
  function checkNewDay() {
    const now = C.todayKey();
    if (now === T.ui.todayKey) return;
    const old = T.ui.todayKey;
    T.ui.todayKey = now;
    if (now.slice(0, 4) !== old.slice(0, 4)) { unsubscribeYear(String(+old.slice(0, 4) - 1)); subscribeYear(now.slice(0, 4)); }
    if (T.ui.viewedDate === old && T.ui.screen === 'today') T.ui.newDay = true;
    onData(); renderBanners();
  }

  // ------------------------------------------------------------------ toast
  let toastTimer = null, toastLeft = 0, toastStart = 0;
  T.toast = (msg, opts) => {
    opts = opts || {};
    const el = $('toast');
    // On phones the toast sits in flow under the add box instead of floating over it.
    const phone = !!(root.matchMedia && root.matchMedia('(max-width: 719px)').matches);
    const today = $('screen-today');
    const host = phone && T.ui.screen === 'today' && !T.ui.modal && today && !today.hidden && $('addbox') ? $('addbox') : $('app');
    if (el.parentElement !== host) host.appendChild(el);
    el.classList.toggle('in-flow', host.id === 'addbox');
    clear(el);
    el.appendChild(h('span', { text: msg }));
    T.ui.undo = opts.undo || null;
    if (opts.undo) el.appendChild(h('button', { class: 'link-btn', type: 'button', onclick: () => T.runUndo() }, 'Undo'));
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastLeft = opts.ms || (opts.undo ? 8000 : 4000); toastStart = Date.now();
    toastTimer = setTimeout(T.hideToast, toastLeft);
  };
  document.addEventListener('visibilitychange', () => {
    if (!toastTimer) return;
    if (document.hidden) { clearTimeout(toastTimer); toastLeft -= Date.now() - toastStart; }
    else { toastStart = Date.now(); toastTimer = setTimeout(T.hideToast, Math.max(1000, toastLeft)); }
  });
  T.hideToast = () => { const el = $('toast'); el.hidden = true; T.ui.undo = null; if (toastTimer) clearTimeout(toastTimer); toastTimer = null; };
  T.runUndo = () => { const u = T.ui.undo; T.hideToast(); if (u) { u(); render(); } };

  // ------------------------------------------------------------------ modal
  const INERT = ['.topbar', '#banners', '#main', '.nav-bottom'];
  const focusables = (root_) => Array.from(root_.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null);
  T.openModal = (opts) => {
    T.closeModal(true);
    const opener = document.activeElement;
    const rootEl = $('modal-root');
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Dialog' },
      h('div', { class: 'modal-head' }, h('h2', { text: opts.title || '' }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => T.closeModal() }, '×')),
      h('div', { class: 'modal-body' }, opts.body),
      opts.footer ? h('div', { class: 'modal-foot' }, opts.footer) : null);
    const back = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === back && opts.dismissible !== false) T.closeModal(); } }, modal);
    modal.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && opts.onPrimary) { e.preventDefault(); opts.onPrimary(); return; }
      if (e.key === 'Tab') {
        const f = focusables(modal);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    rootEl.appendChild(back);
    INERT.forEach((s) => { const n = document.querySelector(s); if (n) n.setAttribute('inert', ''); });
    T.ui.modal = { el: back, onClose: opts.onClose, guard: opts.guard, opener };
    const target = opts.focus ? modal.querySelector(opts.focus) : modal.querySelector('input, select, button.btn-primary, button');
    if (target && !T.ui.touch) setTimeout(() => target.focus(), 0);
    else { modal.setAttribute('tabindex', '-1'); try { modal.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    return modal;
  };
  T.closeModal = (force) => {
    const m = T.ui.modal;
    if (!m) return true;
    if (!force && m.guard && !m.guard()) return false;
    m.el.remove();
    INERT.forEach((s) => { const n = document.querySelector(s); if (n) n.removeAttribute('inert'); });
    T.ui.modal = null;
    if (m.opener && m.opener.isConnected && !T.ui.touch && typeof m.opener.focus === 'function') { try { m.opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    if (m.onClose) m.onClose();
    return true;
  };

  // ----------------------------------------------------------------- render
  function render() {
    if (T.ui.batch) { T.ui.batch = 2; return; }
    const a = document.activeElement;
    const keep = a && a.id && isField(a) ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
    T.ui.rendering = true;
    try {
      renderNav();
      if (T.ui.screen === 'today') renderToday();
      else if (T.renderers[T.ui.screen]) T.renderers[T.ui.screen]();
    } finally { T.ui.rendering = false; }
    if (keep) { const el = $(keep.id); if (el && el !== a && document.activeElement !== el) { try { el.focus({ preventScroll: true }); if (keep.start != null && el.setSelectionRange) el.setSelectionRange(keep.start, keep.end); } catch (e) { /* ignore */ } } }
  }
  T.render = render;

  // ------------------------------------------------------------------ Today
  const el = {};
  function bindToday() {
    ['day-prev', 'day-next', 'day-today', 'day-label', 'day-input', 'day-rel', 'search', 'dropdown', 'pickbox', 'chips', 'entries', 'tiles', 'weightbox', 'day-links', 'addbox', 'screen-today', 'main'].forEach((id) => { el[id] = $(id); });
    el['day-prev'].addEventListener('click', () => T.setDate(C.addDays(T.ui.viewedDate, -1)));
    el['day-next'].addEventListener('click', () => T.setDate(C.addDays(T.ui.viewedDate, 1)));
    el['day-today'].addEventListener('click', () => T.setDate(T.ui.todayKey));
    el['day-label'].addEventListener('click', () => { const i = el['day-input']; i.max = T.maxDateKey(); i.min = C.MIN_KEY; i.value = T.ui.viewedDate; if (i.showPicker) { try { i.showPicker(); } catch (e) { i.focus(); } } else { i.focus(); i.click(); } });
    el['day-input'].addEventListener('change', () => { const v = el['day-input'].value; if (C.isKey(v)) T.setDate(v); });
    const s = el.search;
    s.addEventListener('input', () => { T.ui.query = s.value; T.ui.ddIndex = 0; T.ui.ddOpen = s.value.trim().length > 0; renderDropdown(); });
    s.addEventListener('focus', () => { if (s.value.trim()) { T.ui.ddOpen = true; renderDropdown(); } });
    s.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== s) { T.ui.ddOpen = false; renderDropdown(); } }, 150); });
    s.addEventListener('keydown', onSearchKey);
    el.tiles.addEventListener('click', () => { T.ui.tilesDetail = !T.ui.tilesDetail; renderTiles(); });
  }
  T.setDate = (key) => {
    if (!C.isKey(key)) return;
    if (key > T.maxDateKey()) key = T.maxDateKey();
    T.ui.editingEntryId = null; T.ui.expandedEntryId = null;
    T.ui.viewedDate = key;
    T.ui.picked = null; T.ui.quickAdd = false; T.ui.editWeight = false;
    if (key === T.ui.todayKey) T.ui.newDay = false;
    T.setViewedDaySub(key);
    if (T.ui.screen !== 'today') T.ui.screen = 'today';
    renderBanners();
    render();
    focusEntry();
  };
  function focusEntry() {
    if (T.ui.touch || !T.canWrite()) return;
    const s = T.settings();
    if (T.ui.viewedDate === T.ui.todayKey && !T.data.weights[T.ui.viewedDate] && s.weightFirst) { const wi = $('weight-input'); if (wi) { wi.focus(); return; } }
    if (el.search && !el.search.disabled && !el.search.parentElement.hidden) el.search.focus();
  }
  let focusedOnce = false;

  function renderToday() {
    const scr = el['screen-today'];
    if (T.def.app && T.snap.app === null && T.queue && !T.queue.hasPending(C.PATHS.app) && !T.ui.erasing && !T.ui.remoteErased) { renderWelcome(); return; }
    const w = $('welcome'); if (w) w.remove();
    scr.hidden = false;
    renderDayBar();
    const canWrite = T.canWrite();
    if (!T.baseReady() && !Object.keys(T.data.foods).length && !T.data.app) {
      clear(el.tiles).appendChild(h('div', { class: 'loading', text: T.ui.disconnected ? 'Not connected' : 'Loading your data…' }));
      clear(el.weightbox); clear(el.chips); clear(el.entries); clear(el['day-links']);
      el.search.disabled = true; el.addbox.classList.add('loading');
      return;
    }
    el.search.disabled = !canWrite; el.addbox.classList.toggle('loading', !canWrite);
    el.search.placeholder = canWrite ? 'Add food… (type a name)' : (T.readonly() ? 'Read-only' : 'Loading your data…');
    renderTiles();
    renderWeightBox();
    renderPick();
    renderDropdown();
    renderChips();
    renderEntries();
    renderDayLinks();
    if (!focusedOnce && T.def.app && T.def.weights && canWrite) { focusedOnce = true; focusEntry(); }
  }
  function renderWelcome() {
    const scr = el['screen-today'];
    scr.hidden = true;
    if ($('welcome')) return;
    let unit = 'lb';
    const unitSel = h('div', { class: 'seg' }, h('button', { type: 'button', class: 'on', text: 'lb', onclick: () => pickUnit('lb') }), h('button', { type: 'button', text: 'kg', onclick: () => pickUnit('kg') }));
    function pickUnit(u) { unit = u; unitSel.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === u)); }
    const kcal = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 2400', class: 'mono', 'aria-label': 'Daily calories' });
    const prot = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 180', class: 'mono', 'aria-label': 'Protein grams' });
    const card = h('div', { id: 'welcome', class: 'welcome' },
      h('h1', { text: 'Welcome to Tare' }),
      h('p', { text: T.mode === 'db' ? 'Your data is saved to your Claude account and syncs to every device where you open this page. Log food in grams or millilitres straight off the scale, weigh in every morning, and watch the trend.' : 'Local mode: data stays in this browser. Open Tare from your Claude link to sync between devices.' }),
      h('div', { class: 'row' }, h('span', { class: 'eyebrow', text: 'Weight unit' }), unitSel),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' }, h('div', { class: 'field' }, h('label', { text: 'Daily calories (optional)' }), kcal), h('div', { class: 'field' }, h('label', { text: 'Protein g (optional)' }), prot)),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: start }, 'Start'),
        h('button', { class: 'link-btn', type: 'button', onclick: () => T.hooks.importBackup && T.hooks.importBackup() }, 'Restore from a backup file')));
    function start() {
      const app = C.sanitizeApp({ settings: { weightUnit: unit } });
      const k = C.parseNum(kcal.value), p = C.parseNum(prot.value);
      if ((k.ok && k.value > 0) || (p.ok && p.value > 0)) app.targets[T.ui.todayKey] = { kcal: k.ok && k.value > 0 ? k.value : null, protein: p.ok && p.value > 0 ? p.value : null, carbs: null, fat: null, fiber: null };
      app.createdAt = T.now(); app.updatedAt = app.createdAt; app.firstYear = T.thisYear();
      T.setDoc(C.PATHS.app, app);
      card.remove();
      render();
      focusEntry();
    }
    el.main.insertBefore(card, el.main.firstChild);
  }
  function renderDayBar() {
    const d = T.ui.viewedDate, isToday = d === T.ui.todayKey;
    el['day-label'].textContent = C.fmtDate(d);
    el['day-rel'].textContent = isToday ? 'today' : C.relativeDay(d, T.ui.todayKey);
    el['day-next'].disabled = d >= T.maxDateKey();
    el['day-today'].hidden = isToday;
  }

  // tiles
  function renderTiles() {
    const totals = C.dayTotals(T.entries(T.ui.viewedDate));
    const tg = T.targetFor(T.ui.viewedDate);
    const hasFiber = !!(tg && tg.fiber != null);
    const box = clear(el.tiles);
    box.classList.toggle('has-fiber', hasFiber);
    const split = C.energySplit(totals.protein, totals.carbs, totals.fat);
    const mk = (key, label, total, unit) => {
      const target = tg ? tg[key] : null;
      const tile = h('div', { class: 'tile tile-' + key });
      const pct = C.pct(total, target);
      tile.appendChild(h('div', { class: 'eyebrow' }, h('span', { text: label }), pct != null ? h('span', { text: pct + '%' }) : null));
      tile.appendChild(h('div', { class: 'tile-value num' }, C.fmtInt(total), target != null ? h('span', { class: 'of', text: ' / ' + C.fmtInt(target) + ' ' + unit }) : h('span', { class: 'of', text: ' ' + unit })));
      if (target != null) {
        tile.appendChild(h('div', { class: 'meter' }, h('i', { style: 'width:' + Math.min(100, pct) + '%' })));
        const rem = target - total;
        let cls = '';
        if (key === 'kcal' && rem < 0) cls = 'over';
        else if ((key === 'protein' || key === 'fiber') && total >= target) cls = 'met';
        else if ((key === 'carbs' || key === 'fat') && rem < 0) cls = 'warnover';
        if (cls) tile.classList.add(cls);
        tile.appendChild(h('div', { class: 'tile-sub', text: rem >= 0 ? C.fmtInt(rem) + ' left' : 'over by ' + C.fmtInt(-rem) }));
      } else tile.appendChild(h('div', { class: 'tile-sub' }, h('button', { class: 'link-btn', type: 'button', text: 'Set targets', onclick: (e) => { e.stopPropagation(); T.go('settings'); } })));
      let title = label + ': ' + C.fmt1(total) + ' ' + unit;
      if (split && key === 'kcal') title += ' · energy split P ' + split.protein + '% / C ' + split.carbs + '% / F ' + split.fat + '%';
      tile.title = title;
      if (key === 'kcal' && split) tile.appendChild(h('div', { class: 'tile-split', text: split.protein + '% P · ' + split.carbs + '% C · ' + split.fat + '% F' }));
      if (key === 'fiber' && totals.fiberCount && totals.fiberCount < totals.count) tile.appendChild(h('div', { class: 'tile-split', text: '≥ ' + C.fmtInt(totals.fiber) + ' g (' + totals.fiberCount + ' of ' + totals.count + ')' }));
      return tile;
    };
    box.appendChild(mk('kcal', 'Calories', totals.kcal, 'kcal'));
    box.appendChild(mk('protein', 'Protein', totals.protein, 'g'));
    box.appendChild(mk('carbs', 'Carbs', totals.carbs, 'g'));
    box.appendChild(mk('fat', 'Fat', totals.fat, 'g'));
    if (hasFiber) box.appendChild(mk('fiber', 'Fiber', totals.fiberCount ? totals.fiber : 0, 'g'));
    const det = $('tiles-detail');
    if (det) { det.hidden = !T.ui.tilesDetail; det.textContent = ''; }
    if (T.ui.tilesDetail && det) det.appendChild(h('span', { text: C.fmt1(totals.kcal) + ' kcal · ' + C.fmt1(totals.protein) + ' P · ' + C.fmt1(totals.carbs) + ' C · ' + C.fmt1(totals.fat) + ' F' + (totals.fiberCount ? ' · ' + C.fmt1(totals.fiber) + ' Fib (' + totals.fiberCount + ' of ' + totals.count + ')' : '') + (split ? ' · ' + split.protein + '/' + split.carbs + '/' + split.fat + '%' : '') }));
  }

  // weight box
  function prevWeighIn(before) {
    const keys = Object.keys(T.data.weights).filter((k) => k < before).sort();
    if (!keys.length) return null;
    const k = keys[keys.length - 1];
    return { date: k, w: T.data.weights[k] };
  }
  function renderWeightBox() {
    const box = el.weightbox;
    const existing = $('weight-input');
    if (existing && document.activeElement === existing && existing.dataset.date === T.ui.viewedDate) return;
    clear(box);
    const s = T.settings(), unit = s.weightUnit, date = T.ui.viewedDate;
    const w = T.data.weights[date];
    const prev = prevWeighIn(date);
    const canWrite = T.canWrite();
    box.appendChild(h('div', { class: 'eyebrow', text: 'Weight' }));
    if (date > T.ui.todayKey) {
      // Weight can't be logged ahead of time — only food. Keep the trend chart free of invented future points.
      box.appendChild(h('div', { class: 'hint tiny muted', text: "You'll be able to weigh in once " + C.relativeDay(date, T.ui.todayKey) + ' arrives.' }));
      return;
    }
    const hint = h('div', { class: 'hint tiny muted' });
    if (prev) hint.textContent = (C.daysBetween(prev.date, date) === 1 ? 'yesterday ' : 'last ') + C.fmt1(C.toUnit(prev.w.v, prev.w.u, unit)) + (C.daysBetween(prev.date, date) === 1 ? '' : ' (' + C.fmtDate(prev.date, false) + ')');
    else if (canWrite && !w && date === T.ui.todayKey) hint.textContent = "Log today's weight";
    if (w && !T.ui.editWeight) {
      box.appendChild(h('div', { class: 'weight-stored' },
        h('span', { class: 'tick', text: '✓', 'aria-hidden': 'true' }),
        h('button', { class: 'link-btn', type: 'button', title: 'Edit', disabled: !canWrite, onclick: () => { T.ui.editWeight = true; renderWeightBox(); const i = $('weight-input'); if (i) { i.focus(); i.select(); } } }, h('b', { text: C.fmt1(C.toUnit(w.v, w.u, unit)) }), ' ' + unit),
        canWrite ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove weigh-in', title: 'Remove', onclick: () => removeWeight(date) }, '×') : null));
      box.appendChild(hint);
      return;
    }
    const input = h('input', { id: 'weight-input', type: 'text', inputmode: 'decimal', enterkeyhint: 'done', class: 'mono', placeholder: prev ? C.fmt1(C.toUnit(prev.w.v, prev.w.u, unit)) : '0.0', 'aria-label': 'Weight in ' + unit, dataset: { date }, disabled: !canWrite });
    if (w) input.value = C.fmt1(C.toUnit(w.v, w.u, unit));
    const msg = h('div', { class: 'hint tiny' });
    const save = () => {
      const r = C.parseNum(input.value);
      if (r.empty) { if (T.ui.editWeight) { T.ui.editWeight = false; renderWeightBox(); } else if (!T.ui.touch) el.search.focus(); return; }
      if (!r.ok) { msg.textContent = r.error; msg.className = 'hint tiny crit'; input.classList.add('err'); return; }
      const chk = C.checkWeight(r.value, unit, prev ? prev.w : null);
      if (!chk.ok) { msg.textContent = chk.error; msg.className = 'hint tiny crit'; input.classList.add('err'); return; }
      const old = w ? Object.assign({}, w) : null;
      T.ui.editWeight = false;
      T.saveWeighIn(date, { v: chk.value, u: unit, at: T.now() });
      if (old) T.toast(C.fmt1(C.toUnit(old.v, old.u, unit)) + ' → ' + C.fmt1(chk.value) + ' ' + unit, { undo: () => T.saveWeighIn(date, old) });
      else if (chk.warning) T.toast(chk.warning, { undo: () => T.removeWeighIn(date) });
      if (!T.ui.touch) el.search.focus();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { T.ui.editWeight = false; renderWeightBox(); if (!T.ui.touch) el.search.focus(); } });
    input.addEventListener('input', () => { input.classList.remove('err'); msg.textContent = ''; });
    if (!w && canWrite && date === T.ui.todayKey && s.weightFirst) input.classList.add('attention');
    box.appendChild(h('div', { class: 'row' }, h('div', { class: 'unit-input' }, input, h('span', { class: 'unit', text: unit })), h('button', { class: 'btn', type: 'button', disabled: !canWrite, onclick: save }, 'Save')));
    box.appendChild(hint);
    box.appendChild(msg);
  }
  function removeWeight(date) {
    const old = T.data.weights[date];
    if (!old) return;
    T.removeWeighIn(date);
    T.toast('Weigh-in removed', { undo: () => T.saveWeighIn(date, old) });
  }

  // ----------------------------------------------------------- add flow
  function searchItems() {
    const items = Object.values(T.data.foods).map((f) => ({ type: 'food', food: f })).concat(Object.values(T.data.meals).map((m) => ({ type: 'meal', meal: m })));
    return C.rankItems(T.ui.query, items, T.use30(), 8);
  }
  function currentRows() { return searchItems().map((it) => ({ kind: 'item', it })).concat([{ kind: 'new' }, { kind: 'quick' }]); }
  function renderDropdown() {
    const dd = el.dropdown;
    const open = T.ui.ddOpen && !T.ui.picked && !T.ui.quickAdd && T.ui.query.trim().length > 0 && T.canWrite();
    el.search.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) { dd.hidden = true; clear(dd); el.search.removeAttribute('aria-activedescendant'); return; }
    clear(dd);
    const q = T.ui.query.trim();
    const all = currentRows();
    if (T.ui.ddIndex >= all.length) T.ui.ddIndex = all.length - 1;
    if (T.ui.ddIndex < 0) T.ui.ddIndex = 0;
    all.forEach((row, i) => {
      let node;
      if (row.kind === 'item') {
        const it = row.it;
        if (it.type === 'food') {
          const f = it.food;
          node = h('div', { class: 'dd-item', role: 'option' },
            h('div', { class: 'dd-name' }, f.name, f.brand ? h('span', { class: 'brand', text: ' · ' + f.brand }) : null),
            h('div', { class: 'dd-kcal', text: C.fmtInt(f.kcal) + ' kcal / ' + C.fmt1(f.basis) + ' ' + C.unitLabel(f.unit) }),
            h('div', { class: 'dd-meta', text: f.lastAmount ? 'last ' + C.fmt1(f.lastAmount) + ' ' + C.unitLabel(f.unit) : 'P ' + C.fmt1(f.protein) + ' · C ' + C.fmt1(f.carbs) + ' · F ' + C.fmt1(f.fat) }));
        } else {
          const m = it.meal;
          const t = C.dayTotals(C.expandMeal(m, T.data.foods, '', () => 'x').entries);
          node = h('div', { class: 'dd-item', role: 'option' }, h('div', { class: 'dd-name' }, h('span', { 'aria-hidden': 'true', text: '≡ ' }), h('span', { class: 'vh', text: 'Meal: ' }), m.name), h('div', { class: 'dd-kcal', text: C.fmtInt(t.kcal) + ' kcal' }), h('div', { class: 'dd-meta', text: 'meal — ' + m.items.length + ' item' + (m.items.length === 1 ? '' : 's') }));
        }
      } else if (row.kind === 'new') node = h('div', { class: 'dd-item tail', role: 'option' }, h('div', { class: 'dd-name', text: '+ New food "' + q + '"' }));
      else node = h('div', { class: 'dd-item tail', role: 'option' }, h('div', { class: 'dd-name', text: 'Quick add (just calories and macros)' }));
      if (i === T.ui.ddIndex) { node.classList.add('on'); node.setAttribute('aria-selected', 'true'); }
      node.id = 'dd-' + i;
      // Mouse: keep focus in the search box. Touch: never pick on pointerdown, so the list can be scrolled.
      node.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') e.preventDefault(); });
      node.addEventListener('click', () => pickRow(row));
      dd.appendChild(node);
    });
    dd.hidden = false;
    el.search.setAttribute('aria-activedescendant', 'dd-' + T.ui.ddIndex);
    const on = dd.querySelector('.dd-item.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function onSearchKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const s = el.search;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!T.ui.ddOpen) { if (s.value.trim()) { T.ui.ddOpen = true; renderDropdown(); } return; }
      e.preventDefault();
      const n = currentRows().length;
      T.ui.ddIndex = (T.ui.ddIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderDropdown();
    } else if (e.key === 'Enter') {
      if (!s.value.trim()) return;
      e.preventDefault();
      const rows = currentRows();
      pickRow(rows[Math.min(T.ui.ddIndex, rows.length - 1)]);
    } else if (e.key === 'Escape') {
      if (T.ui.ddOpen) { T.ui.ddOpen = false; renderDropdown(); }
      else if (s.value) { s.value = ''; T.ui.query = ''; }
    }
  }
  function pickRow(row) {
    if (!T.canWrite()) return;
    if (row.kind === 'new') { if (T.hooks.newFood) T.hooks.newFood({ name: T.ui.query.trim(), fromSearch: true }); return; }
    if (row.kind === 'quick') { T.ui.quickAdd = true; T.ui.picked = null; T.ui.ddOpen = false; el.pickbox.dataset.foodId = ''; renderDropdown(); renderPick(); return; }
    const it = row.it;
    if (it.type === 'meal') { addMeal(it.meal); return; }
    T.pickFood(it.food);
  }
  T.pickFood = (food) => {
    if (!T.canWrite()) return;
    T.ui.picked = food; T.ui.ddOpen = false; T.ui.quickAdd = false;
    el.pickbox.dataset.foodId = '';
    renderDropdown(); renderPick();
    const input = $('pick-amount');
    if (input) { input.focus(); try { input.setSelectionRange(0, input.value.length); } catch (e) { /* ignore */ } }
  };
  function renderPick() {
    const box = el.pickbox;
    if (T.ui.quickAdd) { renderQuickAdd(box); return; }
    const f = T.ui.picked;
    if (!f) { box.hidden = true; clear(box); el.search.parentElement.hidden = false; return; }
    if (box.dataset.foodId === f.id && !box.hidden) return;
    clear(box);
    box.dataset.foodId = f.id;
    el.search.parentElement.hidden = true;
    const prefill = f.lastAmount || (f.quick[0] && f.quick[0].amount) || f.basis;
    const input = h('input', { id: 'pick-amount', type: 'text', inputmode: 'decimal', enterkeyhint: 'done', maxlength: '64', class: 'amount-input', value: C.fmt1(prefill), 'aria-label': 'Amount in ' + C.unitName(f.unit), autocomplete: 'off' });
    const hint = h('div', { class: 'pick-hint' });
    const updateHint = () => {
      T.ui.amountExpr = input.value;
      const r = C.evalExpr(input.value);
      hint.classList.remove('err', 'warn');
      if (!r.ok) { hint.textContent = r.empty ? '' : r.error; if (!r.empty) hint.classList.add('err'); return; }
      const chk = C.checkAmount(r.value, f.lastAmount, f.unit);
      if (!chk.ok) { hint.textContent = chk.error; hint.classList.add('err'); return; }
      const v = C.scale(f, chk.value, f.basis);
      hint.textContent = '= ' + C.fmtInt(v.kcal) + ' kcal · ' + C.fmt1(v.protein) + ' P · ' + C.fmt1(v.carbs) + ' C · ' + C.fmt1(v.fat) + ' F' + (/[+\-*/()]/.test(input.value) ? '  (' + C.fmt1(chk.value) + ' ' + C.unitLabel(f.unit) + ')' : '');
      if (chk.warning) { hint.textContent += ' — ' + chk.warning; hint.classList.add('warn'); }
    };
    input.addEventListener('input', updateHint);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); commitPick(false); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); commitPick(true); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelPick(); }
    });
    box.appendChild(h('div', { class: 'pick-name' },
      h('button', { class: 'pick-unpick', type: 'button', 'aria-label': 'Choose a different food', title: 'Back to search', onclick: cancelPick }, h('span', {}, f.name, f.brand ? h('span', { class: 'brand', text: ' · ' + f.brand }) : null), h('span', { class: 'x', text: '×', 'aria-hidden': 'true' })),
      h('span', { class: 'tiny muted', text: 'label per ' + C.fmt1(f.basis) + ' ' + C.unitLabel(f.unit) })));
    box.appendChild(h('div', { class: 'pick-row' },
      h('div', { class: 'unit-input' }, input, h('span', { class: 'unit', text: C.unitLabel(f.unit) })),
      h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => commitPick(false) }, 'Add')));
    if (f.quick.length) box.appendChild(h('div', { class: 'quick-btns' }, f.quick.map((q) => h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { input.value = C.fmt1(q.amount); updateHint(); input.focus(); } }, q.label + ' = ' + C.fmt1(q.amount) + ' ' + C.unitLabel(f.unit)))));
    box.appendChild(hint);
    box.hidden = false;
    updateHint();
  }
  function cancelPick() {
    T.ui.picked = null; T.ui.quickAdd = false; T.ui.amountExpr = '';
    el.pickbox.dataset.foodId = '';
    renderPick();
    el.search.focus();
    if (el.search.value.trim()) { T.ui.ddOpen = true; renderDropdown(); }
  }
  function afterAdd(tabbed) {
    T.ui.picked = null; T.ui.quickAdd = false; T.ui.query = ''; el.search.value = ''; T.ui.ddOpen = false; T.ui.amountExpr = '';
    el.pickbox.dataset.foodId = '';
    renderPick(); renderDropdown();
    render();
    if (tabbed) { const rows = el.entries.querySelectorAll('.entry-row .amt input'); const last = rows[rows.length - 1]; if (last) { last.focus(); return; } }
    if (T.ui.touch) el.search.blur(); else el.search.focus();
  }
  function commitPick(tabbed) {
    const f = T.ui.picked, input = $('pick-amount');
    if (!f || !input || !T.canWrite()) return;
    const r = C.evalExpr(input.value);
    const chk = r.ok ? C.checkAmount(r.value, f.lastAmount, f.unit) : { ok: false };
    if (!chk.ok) { input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake', 'err'); input.focus(); return; }
    const date = T.ui.viewedDate;
    const e = C.makeEntry(f, chk.value, { id: T.newId('e_'), at: T.now() });
    T.batch(() => { T.appendEntries(date, [e]); T.bumpFood(f.id, chk.value); });
    afterAdd(tabbed);
  }
  function addMeal(meal) {
    if (!T.canWrite()) return;
    const ex = C.expandMeal(meal, T.data.foods, T.now(), () => T.newId('e_'));
    if (!ex.entries.length) { T.toast("None of that meal's foods exist any more"); return; }
    const date = T.ui.viewedDate;
    let ids = [];
    T.batch(() => {
      ids = T.appendEntries(date, ex.entries);
      ex.entries.forEach((e) => T.bumpFood(e.foodId, null));
      const m = T.data.meals[meal.id];
      if (m) T.patch('meals/' + m.id, { useCount: (m.useCount || 0) + 1, lastUsedAt: T.now(), updatedAt: T.now() });
    });
    const t = C.dayTotals(ex.entries);
    T.toast('Added ' + meal.name + ' — ' + plural(ex.entries.length, 'item') + ', ' + C.fmtInt(t.kcal) + ' kcal' + (ex.skipped.length ? ' (' + plural(ex.skipped.length, 'missing food') + ' skipped)' : ''), { undo: () => T.tombstone(date, ids) });
    afterAdd(false);
  }
  function renderQuickAdd(box) {
    if (box.dataset.foodId === 'quick' && !box.hidden) return;
    clear(box); box.dataset.foodId = 'quick';
    el.search.parentElement.hidden = true;
    const fields = {};
    const order = ['name', 'kcal', 'protein', 'carbs', 'fat'];
    const mk = (key, label) => { const first = key === 'name'; fields[key] = h('input', { type: 'text', inputmode: first ? 'text' : 'decimal', enterkeyhint: key === 'fat' ? 'done' : 'next', class: first ? '' : 'mono', placeholder: first ? 'Name (e.g. restaurant bowl)' : '0', 'aria-label': label, autocomplete: 'off', autocorrect: 'off', autocapitalize: first ? 'words' : 'off', spellcheck: 'false' }); return h('div', { class: 'field' }, h('label', { text: label }), fields[key]); };
    const msg = h('div', { class: 'pick-hint err' });
    const submit = () => {
      if (!T.canWrite()) return;
      const name = fields.name.value.trim() || 'Quick entry';
      const vals = {};
      for (const k of ['kcal', 'protein', 'carbs', 'fat']) { const r = C.parseNum(fields[k].value); if (!r.ok && !r.empty) { msg.textContent = C.LABEL[k] + ': ' + r.error; fields[k].focus(); return; } vals[k] = r.ok ? r.value : 0; if (vals[k] < 0 || vals[k] > 10000) { msg.textContent = C.LABEL[k] + ': enter 0 to 10,000'; fields[k].focus(); return; } }
      if (!vals.kcal && (vals.protein || vals.carbs || vals.fat)) vals.kcal = Math.round(C.macroKcal(vals.protein, vals.carbs, vals.fat));
      if (!vals.kcal && !vals.protein && !vals.carbs && !vals.fat) { msg.textContent = 'Enter at least the calories'; fields.kcal.focus(); return; }
      T.appendEntries(T.ui.viewedDate, [C.makeQuickEntry({ name, kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat }, { id: T.newId('e_'), at: T.now() })]);
      afterAdd(false);
    };
    const form = h('div', { class: 'quick-form' }, order.map((k) => mk(k, k === 'name' ? 'Name' : (k === 'kcal' ? 'kcal' : C.LABEL[k] + ' g'))));
    order.forEach((k, i) => fields[k].addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); if (i < order.length - 1) { fields[order[i + 1]].focus(); fields[order[i + 1]].select(); } else submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelPick(); }
    }));
    if (T.ui.query.trim()) fields.name.value = T.ui.query.trim();
    box.appendChild(h('div', { class: 'pick-name' }, h('span', { text: 'Quick add' }), h('span', { class: 'tiny muted', text: 'one-off, not saved as a food' })));
    box.appendChild(form);
    box.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, 'Add'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: cancelPick }, 'Cancel')));
    box.appendChild(msg);
    box.hidden = false;
    (fields.name.value ? fields.kcal : fields.name).focus(); // synchronous: this runs inside the user's tap/Enter
  }

  // chips
  function renderChips() {
    const box = el.chips;
    const left = box.scrollLeft;
    clear(box);
    if (!T.canWrite()) return;
    C.chips(T.data.foods, T.data.meals, T.use30(), 12).forEach((c) => {
      if (c.type === 'food') {
        const f = c.food;
        box.appendChild(h('button', { class: 'chip', type: 'button', title: f.name + (f.brand ? ' · ' + f.brand : ''), onclick: () => T.pickFood(f) }, h('span', { class: 'name', text: f.name }), f.lastAmount ? h('span', { class: 'amt', text: C.fmt1(f.lastAmount) + ' ' + C.unitLabel(f.unit) }) : null));
      } else box.appendChild(h('button', { class: 'chip meal', type: 'button', onclick: () => addMeal(c.meal) }, h('span', { class: 'name', text: c.meal.name })));
    });
    box.scrollLeft = left;
  }

  // entries
  function lastLoggedDayBefore(date) {
    const keys = Object.keys(T.data.days).filter((k) => k < date && C.isLogged(T.data.days[k])).sort();
    return keys.length ? keys[keys.length - 1] : null;
  }
  function renderEntries() {
    const box = el.entries;
    if (T.ui.editingEntryId && box.querySelector('.entry-row .amt input:focus')) { T.ui.entriesDirty = true; return; }
    clear(box);
    const date = T.ui.viewedDate;
    const entries = T.entries(date);
    const tg = T.targetFor(date);
    const hasFiber = !!(tg && tg.fiber != null);
    box.classList.toggle('has-fiber', hasFiber);
    const canWrite = T.canWrite();
    if (!entries.length) {
      const src = lastLoggedDayBefore(date);
      const emptyText = date === T.ui.todayKey ? 'Nothing logged yet today' : (date > T.ui.todayKey ? 'Nothing planned for ' + C.relativeDay(date, T.ui.todayKey) + ' yet' : 'Nothing logged');
      const empty = h('div', { class: 'empty' }, h('div', { text: emptyText }));
      if (src && canWrite) {
        const es = T.entries(src), t = C.dayTotals(es);
        // Label the source day relative to the REAL today, not the day being viewed — copying today's
        // breakfast into tomorrow's plan should say "Copy today", not "Copy yesterday".
        empty.appendChild(h('button', { class: 'btn btn-lg', type: 'button', onclick: () => copyDay(src) }, 'Copy ' + C.relativeDay(src, T.ui.todayKey) + ' (' + plural(es.length, 'item') + ', ' + C.fmtInt(t.kcal) + ' kcal)'));
      } else if (canWrite && !Object.keys(T.data.foods).length) {
        empty.appendChild(h('div', { class: 'small', text: 'Start by adding a few foods from their labels, then log them here by weight.' }));
        empty.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => T.go('foods') }, 'Go to Foods'));
      }
      const unread = C.unreadableEntries(T.data.days[date]);
      if (unread) empty.appendChild(h('div', { class: 'tiny muted', text: unread + ' unreadable record' + (unread > 1 ? 's' : '') + ' on this day' }));
      box.appendChild(empty);
      return;
    }
    box.appendChild(h('div', { class: 'entry-head' }, h('span', { text: 'Food' }), h('span', { text: 'Amount' }), h('span', { text: '' }), h('span', { text: 'kcal' }), h('span', { text: 'P' }), h('span', { text: 'C' }), h('span', { text: 'F' }), hasFiber ? h('span', { text: 'Fib' }) : null, h('span', { text: '' })));
    entries.forEach((e) => box.appendChild(entryRow(e, hasFiber, canWrite)));
    const t = C.dayTotals(entries);
    const fib = hasFiber ? (t.fiberCount ? (t.fiberCount < t.count ? '≥ ' : '') + C.fmt1(t.fiber) : '—') : null;
    box.appendChild(h('div', { class: 'entry-foot' }, h('span', { text: 'Total' }), h('span'), h('span'), h('span', { text: C.fmt1(t.kcal) }), h('span', { text: C.fmt1(t.protein) }), h('span', { text: C.fmt1(t.carbs) }), h('span', { text: C.fmt1(t.fat) }), hasFiber ? h('span', { text: fib }) : null, h('span'),
      h('div', { class: 'foot-mobile', text: 'Total ' + C.fmt1(t.kcal) + ' kcal · ' + C.fmt1(t.protein) + ' P · ' + C.fmt1(t.carbs) + ' C · ' + C.fmt1(t.fat) + ' F' + (hasFiber ? ' · ' + fib + ' Fib' : '') })));
    const unread = C.unreadableEntries(T.data.days[date]);
    if (unread) box.appendChild(h('div', { class: 'tiny muted', style: 'padding:6px 4px', text: unread + ' unreadable record' + (unread > 1 ? 's' : '') + ' on this day (kept, not counted)' }));
  }
  function entryRow(e, hasFiber, canWrite) {
    const v = C.entryValues(e);
    const food = e.foodId ? T.data.foods[e.foodId] : null;
    const name = food ? food.name : e.name, brand = food ? food.brand : e.brand;
    const tags = [];
    if (!e.foodId) tags.push('quick');
    else if (!food) tags.push('deleted');
    else if (food.archived) tags.push('archived');
    if (e.mealId) tags.push(T.data.meals[e.mealId] ? T.data.meals[e.mealId].name : '(deleted meal)');
    const input = h('input', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', maxlength: '64', value: C.fmt1(e.amount), 'aria-label': 'Amount of ' + name, autocomplete: 'off', disabled: !canWrite });
    let startValue = null;
    const finish = (save) => {
      if (T.ui.editingEntryId !== e.id) return;
      if (T.ui.rendering || !input.isConnected) return;
      T.ui.editingEntryId = null;
      if (save) {
        const live = T.entries(T.ui.viewedDate).find((x) => x.id === e.id);
        const r = C.evalExpr(input.value);
        const chk = r.ok ? C.checkAmount(r.value, food ? food.lastAmount : null, e.unit) : { ok: false };
        if (!live) { T.toast('That row was deleted on another device'); }
        else if (chk.ok && chk.value !== live.amount) {
          const prevAmount = live.amount;
          const updated = Object.assign({}, live, { amount: chk.value, name, brand });
          T.putEntry(T.ui.viewedDate, updated);
          T.toast(C.fmt1(prevAmount) + ' → ' + C.fmt1(chk.value) + ' ' + (C.unitLabel(e.unit)), { undo: () => { const cur = T.entries(T.ui.viewedDate).find((x) => x.id === e.id); if (cur) T.putEntry(T.ui.viewedDate, Object.assign({}, cur, { amount: prevAmount })); else T.toast('Entry no longer exists'); } });
        }
      }
      if (T.ui.entriesDirty || save) { T.ui.entriesDirty = false; render(); }
    };
    input.addEventListener('focus', () => { T.ui.editingEntryId = e.id; startValue = input.value; requestAnimationFrame(() => { try { input.setSelectionRange(0, input.value.length); } catch (x) { /* ignore */ } }); });
    input.addEventListener('keydown', (ev) => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); if (!T.ui.touch) setTimeout(() => el.search.focus(), 0); }
      else if (ev.key === 'Escape') { ev.preventDefault(); input.value = startValue != null ? startValue : C.fmt1(e.amount); T.ui.editingEntryId = null; input.blur(); if (!T.ui.touch) el.search.focus(); }
      else if (ev.key === 'Delete' && ev.shiftKey) { ev.preventDefault(); T.ui.editingEntryId = null; deleteEntry(e.id); if (!T.ui.touch) el.search.focus(); }
    });
    input.addEventListener('blur', () => { setTimeout(() => finish(true), 0); });
    const warn = e.unit !== 'serving' && !!C.checkAmount(e.amount, food ? food.lastAmount : null, e.unit).warning;
    const expanded = T.ui.expandedEntryId === e.id;
    const nameCell = h('div', { class: 'name', onclick: () => { T.ui.expandedEntryId = expanded ? null : e.id; render(); } },
      h('b', { text: name, title: name + (brand ? ' · ' + brand : '') + ' — label per ' + C.fmt1(e.basis) + ' ' + C.unitLabel(e.unit) }),
      (brand || tags.length) ? h('span', { class: 'sub' }, tags.map((t) => h('span', { class: 'tag', text: t })), brand || '') : null,
      expanded ? h('span', { class: 'sub', text: 'label per ' + C.fmt1(e.basis) + ' ' + C.unitLabel(e.unit) + ': ' + C.fmtInt(e.n.kcal) + ' kcal · ' + C.fmt1(e.n.protein) + ' P · ' + C.fmt1(e.n.carbs) + ' C · ' + C.fmt1(e.n.fat) + ' F' + (e.n.fiber != null ? ' · ' + C.fmt1(e.n.fiber) + ' Fib' : '') + (e.at ? ' · logged ' + e.at.slice(11, 16) : '') }) : null);
    return h('div', { class: 'entry-row', dataset: { id: e.id } },
      nameCell,
      h('div', { class: 'amt' }, input),
      h('span', { class: 'unit' }, C.unitLabel(e.unit), warn ? h('span', { class: 'dot-warn', title: 'unusually large — typo?', text: ' typo?' }) : null),
      h('span', { class: 'n kcal', text: C.fmtInt(v.kcal) }),
      h('span', { class: 'n', text: C.fmt1(v.protein) }),
      h('span', { class: 'n', text: C.fmt1(v.carbs) }),
      h('span', { class: 'n', text: C.fmt1(v.fat) }),
      hasFiber ? h('span', { class: 'n', text: v.fiber == null ? '—' : C.fmt1(v.fiber) }) : null,
      h('button', { class: 'x', type: 'button', tabindex: '-1', 'aria-label': 'Remove ' + name, disabled: !canWrite, onclick: () => deleteEntry(e.id) }, '×'),
      h('div', { class: 'nums' }, h('span', { class: 'kcal', text: C.fmtInt(v.kcal) + ' kcal' }), h('span', { text: C.fmt1(v.protein) + ' P' }), h('span', { text: C.fmt1(v.carbs) + ' C' }), h('span', { text: C.fmt1(v.fat) + ' F' }), hasFiber && v.fiber != null ? h('span', { text: C.fmt1(v.fiber) + ' Fib' }) : null));
  }
  function deleteEntry(id) {
    const date = T.ui.viewedDate;
    const removed = T.entries(date).find((e) => e.id === id);
    if (!removed) return;
    T.tombstone(date, [id]);
    T.toast('Removed ' + removed.name, { undo: () => { if (!T.entries(date).some((e) => e.id === id)) T.putEntry(date, removed); } });
  }
  function copyDay(src) {
    if (!T.canWrite()) return;
    const date = T.ui.viewedDate;
    const from = T.entries(src);
    if (!from.length) { T.toast('Nothing to copy'); return; }
    const copies = C.copyEntries(from, T.now(), () => T.newId('e_'));
    const ids = T.appendEntries(date, copies);
    T.toast('Copied ' + plural(copies.length, 'item') + ' from ' + C.fmtDate(src, false), { undo: () => T.tombstone(date, ids) });
  }
  T.copyDay = copyDay;
  function renderDayLinks() {
    const box = clear(el['day-links']);
    if (!T.canWrite()) return;
    const date = T.ui.viewedDate;
    const dateInput = h('input', { type: 'date', max: T.ui.todayKey, min: C.MIN_KEY, tabindex: '-1', style: 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none', 'aria-label': 'Copy from date' });
    dateInput.addEventListener('change', () => { const v = dateInput.value; if (C.isKey(v) && v !== date && v <= T.ui.todayKey) { if (!T.data.days[v] && v.slice(0, 4) !== T.thisYear() && v.slice(0, 4) !== T.lastYear()) T.loadYear(v.slice(0, 4)).then(() => copyDay(v)); else copyDay(v); } });
    box.appendChild(h('button', { class: 'link-btn', type: 'button', onclick: () => { dateInput.value = C.addDays(date, -1); if (dateInput.showPicker) { try { dateInput.showPicker(); } catch (e) { dateInput.focus(); } } else dateInput.click(); } }, 'Copy from…'));
    box.appendChild(dateInput);
    if (T.entries(date).length && T.hooks.saveAsMeal) box.appendChild(h('button', { class: 'link-btn', type: 'button', onclick: () => T.hooks.saveAsMeal(date) }, 'Save as meal…'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
