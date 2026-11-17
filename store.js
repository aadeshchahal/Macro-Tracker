/* Tare — store.js
   One interface over two backends plus the write queue and a resilient subscription helper.
     DbStore    — the claude.ai artifact `db` capability (realtime, synced between devices)
     LocalStore — one localStorage key (or an in-memory string in tests); same interface
   Interface:
     get(path) -> Promise<{exists, data}>
     set(path, body) -> Promise<void>              whole-document replace
     update(path, patch) -> Promise<void>          deepMerge patch; rejects invalid_argument when the doc is absent
     delete(path) -> Promise<void>
     onDoc(path, cb(body|null, meta), onErr) -> unsubscribe
     onQuery(collection, opts, cb(docs[{id,body}], meta), onErr) -> unsubscribe
     query(collection, opts) -> Promise<docs>
   Bodies delivered by LocalStore are deep-frozen (the db store freezes its own).
   createQueue(): ordered per-path write ops with coalescing, create-on-miss for updates (only where the
   app allows it), retry/backoff, quota blocking, fatal -> read-only (ops kept so nothing silently vanishes),
   a localStorage stash that survives until restored, and an overlay() for the mirror.
   live(): re-subscribing onSnapshot wrapper with backoff. */
(function (root) {
  'use strict';
  const S = {};
  const core = () => root.TareCore || (typeof require === 'function' ? require('./core.js') : null);
  const segs = (p) => String(p).split('/');
  const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const SEG_RE = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
  S.isDocPath = (p) => typeof p === 'string' && segs(p).length % 2 === 0 && segs(p).length <= 16 && segs(p).every((s) => SEG_RE.test(s));

  // ------------------------------------------------------------- DbStore
  function DbStore(db) { this.mode = 'db'; this.db = db; }
  DbStore.prototype.get = function (path) { return this.db.doc(path).get().then((s) => ({ exists: !!s.exists, data: s.exists ? s.data() : null })); };
  DbStore.prototype.set = function (path, body) { return this.db.doc(path).set(body); };
  DbStore.prototype.update = function (path, patch) { return this.db.doc(path).update(patch); };
  DbStore.prototype.delete = function (path) { return this.db.doc(path).delete(); };
  DbStore.prototype.onDoc = function (path, cb, onErr) {
    return this.db.doc(path).onSnapshot((s) => cb(s.exists ? s.data() : null, s.metadata || {}), onErr || (() => {}));
  };
  DbStore.prototype._q = function (col, opts) {
    let q = this.db.collection(col);
    if (opts && opts.where) q = q.where(opts.where[0], opts.where[1], opts.where[2]);
    if (opts && opts.orderBy) q = q.orderBy(opts.orderBy, opts.dir || 'asc');
    if (opts && opts.limit) q = q.limit(opts.limit);
    return q;
  };
  const mapSnap = (snap) => snap.docs.map((d) => ({ id: d.id, body: d.data() }));
  DbStore.prototype.onQuery = function (col, opts, cb, onErr) {
    return this._q(col, opts).onSnapshot((snap) => cb(mapSnap(snap), snap.metadata || {}), onErr || (() => {}));
  };
  DbStore.prototype.query = function (col, opts) { return this._q(col, opts).get().then(mapSnap); };

  // ---------------------------------------------------------- LocalStore
  function LocalStore(backend) {
    this.mode = backend.mode || 'local';
    this.backend = backend;
    this.docs = backend.read() || {};
    this.docSubs = new Map();
    this.querySubs = new Set();
    if (backend.watch) backend.watch(() => { this.docs = backend.read() || {}; this._notifyAll(); });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const ops = {
    '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
    'in': (a, b) => Array.isArray(b) && b.indexOf(a) >= 0, 'not-in': (a, b) => Array.isArray(b) && b.indexOf(a) < 0,
    'array-contains': (a, b) => Array.isArray(a) && a.indexOf(b) >= 0,
  };
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const frozen = (x) => core().deepFreeze(clone(x));
  const safeCall = (cb, ...args) => { try { cb(...args); } catch (e) { console.error('Tare: subscriber failed', e); } };
  LocalStore.prototype._inCol = function (col, path) { return path.indexOf(col + '/') === 0 && segs(path).length === segs(col).length + 1; };
  LocalStore.prototype._run = function (col, opts) {
    let out = [];
    Object.keys(this.docs).forEach((p) => {
      if (!this._inCol(col, p)) return;
      const body = this.docs[p];
      if (opts && opts.where) { const [f, op, v] = opts.where; if (!(ops[op] && ops[op](body[f], v))) return; }
      out.push({ id: segs(p)[segs(p).length - 1], body: frozen(body) });
    });
    if (opts && opts.orderBy) {
      const f = opts.orderBy, dir = opts.dir === 'desc' ? -1 : 1;
      out.sort((a, b) => { const av = a.body[f], bv = b.body[f]; if (av === undefined && bv === undefined) return cmp(a.id, b.id); if (av === undefined) return 1; if (bv === undefined) return -1; return cmp(av, bv) * dir || cmp(a.id, b.id); });
    } else out.sort((a, b) => cmp(a.id, b.id));
    if (opts && opts.limit) out = out.slice(0, opts.limit);
    return out;
  };
  LocalStore.prototype._persist = function () {
    try { this.backend.write(JSON.stringify(this.docs)); }
    catch (e) { throw { code: 'quota_exceeded', message: 'Browser storage is full: ' + (e && e.message) }; }
  };
  // Notifications are deferred to a microtask so a subscriber can never unwind through a write.
  LocalStore.prototype._notifyDoc = function (path) {
    Promise.resolve().then(() => {
      const subs = this.docSubs.get(path);
      if (subs) subs.forEach((cb) => safeCall(cb, this.docs[path] ? frozen(this.docs[path]) : null, META));
      this.querySubs.forEach((qs) => { if (this._inCol(qs.col, path)) safeCall(qs.cb, this._run(qs.col, qs.opts), META); });
    });
  };
  LocalStore.prototype._notifyAll = function () {
    this.docSubs.forEach((subs, path) => subs.forEach((cb) => safeCall(cb, this.docs[path] ? frozen(this.docs[path]) : null, META)));
    this.querySubs.forEach((qs) => safeCall(qs.cb, this._run(qs.col, qs.opts), META));
  };
  const badBody = (body) => !isObj(body);
  LocalStore.prototype.get = function (path) { const d = this.docs[path]; return Promise.resolve({ exists: !!d, data: d ? frozen(d) : null }); };
  LocalStore.prototype.set = function (path, body) {
    if (!S.isDocPath(path)) return Promise.reject({ code: 'invalid_argument', message: 'not a document path: ' + path });
    if (badBody(body)) return Promise.reject({ code: 'invalid_argument', message: 'body must be an object' });
    this.docs[path] = clone(body);
    try { this._persist(); } catch (e) { return Promise.reject(e); }
    this._notifyDoc(path);
    return Promise.resolve();
  };
  LocalStore.prototype.update = function (path, patch) {
    if (!S.isDocPath(path)) return Promise.reject({ code: 'invalid_argument', message: 'not a document path: ' + path });
    if (badBody(patch)) return Promise.reject({ code: 'invalid_argument', message: 'patch must be an object' });
    if (!this.docs[path]) return Promise.reject({ code: 'invalid_argument', message: 'document does not exist: ' + path });
    this.docs[path] = core().deepMerge(this.docs[path], clone(patch));
    try { this._persist(); } catch (e) { return Promise.reject(e); }
    this._notifyDoc(path);
    return Promise.resolve();
  };
  LocalStore.prototype.delete = function (path) {
    delete this.docs[path];
    try { this._persist(); } catch (e) { return Promise.reject(e); }
    this._notifyDoc(path);
    return Promise.resolve();
  };
  LocalStore.prototype.onDoc = function (path, cb) {
    if (!this.docSubs.has(path)) this.docSubs.set(path, new Set());
    this.docSubs.get(path).add(cb);
    const t = setTimeout(() => { const s = this.docSubs.get(path); if (s && s.has(cb)) safeCall(cb, this.docs[path] ? frozen(this.docs[path]) : null, META); }, 0);
    return () => { clearTimeout(t); const s = this.docSubs.get(path); if (s) s.delete(cb); };
  };
  LocalStore.prototype.onQuery = function (col, opts, cb) {
    const qs = { col, opts: opts || {}, cb };
    this.querySubs.add(qs);
    const t = setTimeout(() => { if (this.querySubs.has(qs)) safeCall(cb, this._run(col, qs.opts), META); }, 0);
    return () => { clearTimeout(t); this.querySubs.delete(qs); };
  };
  LocalStore.prototype.query = function (col, opts) { return Promise.resolve(this._run(col, opts || {})); };

  S.localBackend = function (key) {
    return {
      mode: 'local',
      read() { try { const t = root.localStorage.getItem(key); return t ? JSON.parse(t) : null; } catch (e) { return null; } },
      write(text) { root.localStorage.setItem(key, text); },
      watch(cb) { if (root.addEventListener) root.addEventListener('storage', (ev) => { if (ev.key === key) cb(); }); },
    };
  };
  S.memoryBackend = function (initial) {
    let text = initial ? JSON.stringify(initial) : null;
    return { mode: 'memory', read() { return text ? JSON.parse(text) : null; }, write(t) { text = t; }, get text() { return text; } };
  };
  S.DbStore = DbStore;
  S.LocalStore = LocalStore;
  S.create = function (db, localKey) { return db ? new DbStore(db) : new LocalStore(S.localBackend(localKey || 'tare.docs')); };

  // --------------------------------------------------------- write queue
  const FATAL = { revoked: 1, not_granted: 1, capability_disabled: 1, capability_removed: 1 };
  const DROP = { invalid_argument: 1, transform_error: 1 };
  S.classify = (e) => {
    const code = e && typeof e.code === 'string' ? e.code : 'unavailable';
    if (code === 'resource_exhausted') return { code, kind: 'pause' };
    if (code === 'quota_exceeded') return { code, kind: 'block' };
    if (code === 'unavailable') return { code, kind: 'retry' };
    if (FATAL[code]) return { code, kind: 'fatal' };
    if (DROP[code]) return { code, kind: 'drop' };
    return { code, kind: 'retry' };
  };
  S.validOp = (o) => !!(o && S.isDocPath(o.path) && (o.verb === 'set' || o.verb === 'update' || o.verb === 'delete') && (o.verb === 'delete' || isObj(o.body)));
  const DROPPED = { dropped: true };
  // opts: { concurrency, skeleton(path) -> body|null, canCreate(path, body) -> bool, stash: {read(), write(text)},
  //         onState(state, size), onChange(), onError(code, path, err), onDropped(path, op), onRetry(code, path),
  //         onWrite(path, op), setTimeout, clearTimeout, random, retryMs, online() }
  S.createQueue = function (store, opts) {
    opts = opts || {};
    const C = core();
    const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimeout || ((t) => clearTimeout(t));
    const rand = opts.random || Math.random;
    const online = opts.online || (() => (typeof navigator === 'undefined' || navigator.onLine !== false));
    const baseConcurrency = opts.concurrency || 2;
    let concurrency = baseConcurrency;
    let ops = [];            // ordered [{id, path, verb, body, attempts, blocked, inflight}]
    let nextId = 1;
    let state = 'idle', timer = null, retryAttempt = 0, pauseHits = 0, readonly = false, paused = false;
    // The previous session's unsent ops. Kept in the stash until restore() runs, so writes made before
    // restore (e.g. startup housekeeping) can never overwrite them.
    let held = null;
    if (opts.stash && opts.stash.read) {
      try { const l = JSON.parse(opts.stash.read() || 'null'); if (Array.isArray(l)) { const v = l.filter(S.validOp); if (v.length) held = v; } } catch (e) { /* ignore */ }
    }
    const inflightPaths = new Set();
    const emit = () => { if (opts.onState) opts.onState(state, ops.length); };
    const setState = (s) => { state = s; emit(); };
    const changed = () => { stash(); if (opts.onChange) opts.onChange(); };
    function stash() {
      if (!opts.stash || !opts.stash.write) return;
      const live = ops.filter((o) => !o.done).map((o) => ({ path: o.path, verb: o.verb === 'setIfNewer' ? 'set' : o.verb, body: o.body }));
      try { opts.stash.write(JSON.stringify((held || []).concat(live))); } catch (e) { /* ignore */ }
    }
    function settle() {
      if (readonly) { setState('readonly'); return; }
      const blocked = ops.some((o) => o.blocked);
      if (inflightPaths.size) setState('saving');
      else if (blocked && ops.every((o) => o.blocked)) setState('blocked');
      else if (ops.length) setState('pending');
      else setState('idle');
    }
    function enqueue(verb, path, body) {
      if (readonly) return false;
      if (!S.isDocPath(path)) { if (opts.onError) opts.onError('invalid_argument', path, { code: 'invalid_argument', message: 'bad path' }); return false; }
      const prev = ops.slice().reverse().find((o) => o.path === path);
      const prevIsLast = prev && !ops.slice(ops.indexOf(prev) + 1).some((o) => o.path === path);
      if (verb === 'update' && prev && prevIsLast && !prev.inflight && !prev.blocked && (prev.verb === 'update' || prev.verb === 'set')) {
        prev.body = C.deepMerge(prev.body, body);
      } else {
        ops.push({ id: nextId++, path, verb, body: verb === 'delete' ? null : clone(body), attempts: 0, blocked: false, inflight: false });
      }
      changed();
      if (!timer && !paused) flush(); else settle();
      return true;
    }
    function nextRunnable() {
      for (const op of ops) {
        if (op.inflight || op.blocked || op.done) continue;
        if (inflightPaths.has(op.path)) continue; // keep per-path order
        return op;
      }
      return null;
    }
    function flush() {
      if (readonly || paused) { settle(); return; }
      if (opts.canFlush && !opts.canFlush()) { settle(); return; }
      if (!online()) { settle(); return; }
      let op;
      while (inflightPaths.size < concurrency && (op = nextRunnable())) send(op);
      settle();
    }
    function remove(op) { op.done = true; ops = ops.filter((o) => o !== op); changed(); }
    function scheduleRetry() {
      if (timer) return;
      retryAttempt++;
      const delay = retryAttempt === 1 ? 500 + rand() * 1000 : (opts.retryMs || 10000);
      timer = setT(() => { timer = null; flush(); }, delay);
    }
    function pause() {
      pauseHits++;
      paused = true;
      concurrency = 1;
      const delay = Math.min(60000, Math.pow(2, pauseHits) * 1000) * (0.8 + rand() * 0.4);
      if (timer) clearT(timer);
      timer = setT(() => { timer = null; paused = false; flush(); }, delay);
      if (opts.onRetry) opts.onRetry('resource_exhausted', null);
    }
    function createOnMiss(op, err) {
      return store.get(op.path).then((r) => {
        if (r.exists) {
          if (op.verb === 'setIfNewer') {
            const cur = r.data || {};
            if (cur.updatedAt && op.body && op.body.updatedAt && cur.updatedAt > op.body.updatedAt) return DROPPED;
            return store.set(op.path, op.body);
          }
          throw err;
        }
        if (op.verb === 'setIfNewer') return store.set(op.path, op.body); // a full record this device created
        const skel = opts.skeleton ? opts.skeleton(op.path) : null;
        const body = C.deepMerge(skel || {}, op.body);
        if (!skel && !(opts.canCreate && opts.canCreate(op.path, body))) return DROPPED;
        return store.set(op.path, body);
      });
    }
    function send(op) {
      op.inflight = true; op.attempts++;
      inflightPaths.add(op.path);
      setState('saving');
      let p;
      try {
        if (op.verb === 'delete') p = store.delete(op.path);
        else if (op.verb === 'set') p = store.set(op.path, op.body);
        else if (op.verb === 'setIfNewer') p = createOnMiss(op, null);
        else p = store.update(op.path, op.body).catch((e) => { if (!(e && e.code === 'invalid_argument')) throw e; return createOnMiss(op, e); });
      } catch (e) {
        p = Promise.reject({ code: 'invalid_argument', message: String(e && e.message) });
      }
      p.then((res) => {
        retryAttempt = 0;
        if (pauseHits && !paused) { pauseHits = 0; concurrency = baseConcurrency; }
        const wasDelete = op.verb === 'delete';
        remove(op);
        if (res === DROPPED) { if (opts.onDropped) opts.onDropped(op.path, op); }
        else if (opts.onWrite) opts.onWrite(op.path, op);
        if (wasDelete) ops.forEach((o) => { o.blocked = false; }); // freed space: retry blocked creates
      }).catch((e) => {
        const c = S.classify(e);
        if (c.kind === 'retry') { scheduleRetry(); if (opts.onRetry) opts.onRetry(c.code, op.path, e); }
        else if (c.kind === 'pause') { pause(); }
        else if (c.kind === 'block') { op.blocked = true; if (opts.onError) opts.onError(c.code, op.path, e); }
        else if (c.kind === 'fatal') {
          // Keep ops (and the stash) so the overlay still shows them and Export can include them.
          readonly = true;
          if (timer) { clearT(timer); timer = null; }
          if (opts.onError) opts.onError(c.code, op.path, e);
        }
        else { remove(op); if (opts.onError) opts.onError(c.code, op.path, e); }
      }).then(() => {
        op.inflight = false;
        inflightPaths.delete(op.path);
        if (!readonly && !paused && !timer) flush(); else settle();
      });
    }
    return {
      set(path, body) { return enqueue('set', path, body); },
      update(path, patch) { return enqueue('update', path, patch); },
      delete(path) { return enqueue('delete', path, null); },
      retryNow(force) { if (readonly) return; if (force) ops.forEach((o) => { o.blocked = false; }); if (timer) { clearT(timer); timer = null; } paused = false; flush(); },
      // mirror overlay: apply pending ops for a path, in order, to a snapshot body
      overlay(path, base) {
        let out = base;
        ops.forEach((o) => { if (o.path !== path || o.done) return; if (o.verb === 'delete') out = null; else if (o.verb === 'set' || o.verb === 'setIfNewer') out = o.body; else out = C.deepMerge(out || {}, o.body); });
        return out;
      },
      pendingPaths() { const s = new Set(); ops.forEach((o) => s.add(o.path)); return s; },
      hasPending(path) { return ops.some((o) => o.path === path); },
      get heldCount() { return held ? held.length : 0; },
      // Replay a list (default: the previous session's stash). Stale whole-document sets never replace a
      // document that was changed more recently elsewhere.
      restore(list) {
        const src = list || held || [];
        held = null;
        src.filter(S.validOp).forEach((o) => {
          if (readonly) return;
          if (o.verb === 'set') { ops.push({ id: nextId++, path: o.path, verb: 'setIfNewer', body: clone(o.body), attempts: 0, blocked: false, inflight: false }); }
          else if (o.verb === 'update') enqueue('update', o.path, o.body);
          else enqueue('delete', o.path, null);
        });
        changed();
        if (!timer && !paused) flush(); else settle();
        return src.length;
      },
      stop(clear) { readonly = true; if (clear) { ops = []; held = null; changed(); } if (timer) { clearT(timer); timer = null; } settle(); },
      discard() { ops = []; held = null; changed(); settle(); },
      setConcurrency(n) { concurrency = n; },
      get state() { return state; },
      get size() { return ops.length; },
      get blockedCount() { return ops.filter((o) => o.blocked).length; },
      isReadonly() { return readonly; },
      isPaused() { return paused; },
    };
  };

  // --------------------------------------------- resilient subscription
  // live(subscribe, onSnap, opts): subscribe(next, err) -> unsubscribe. Re-subscribes with backoff on
  // transient failures; reports fatal ones. Returns { stop(), retry(), get failures() }.
  S.live = function (subscribe, onSnap, opts) {
    opts = opts || {};
    const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimeout || ((t) => clearTimeout(t));
    let unsub = null, timer = null, failures = 0, stopped = false;
    function start() {
      if (stopped) return;
      try {
        unsub = subscribe((...args) => {
          failures = 0;
          if (opts.onOk) opts.onOk();
          try { onSnap(...args); } catch (e) { console.error('Tare: snapshot handler failed', e); }
        }, (e) => {
          const code = e && e.code;
          if (unsub) { try { unsub(); } catch (x) { /* ignore */ } unsub = null; }
          if (FATAL[code] || code === 'invalid_argument' || code === 'transform_error') { stopped = true; if (opts.onFatal) opts.onFatal(code, e); return; }
          failures++;
          const delay = code === 'resource_exhausted' ? (failures === 1 ? 30000 : 60000) : Math.min(30000, Math.pow(2, failures - 1) * 1000);
          if (opts.onRetry) opts.onRetry(failures, delay, code);
          timer = setT(() => { timer = null; start(); }, delay);
        });
      } catch (e) { stopped = true; if (opts.onFatal) opts.onFatal('invalid_argument', e); }
    }
    start();
    return {
      stop() { stopped = true; if (timer) { clearT(timer); timer = null; } if (unsub) { try { unsub(); } catch (x) { /* ignore */ } unsub = null; } },
      retry() { if (stopped || unsub) return; if (timer) { clearT(timer); timer = null; } start(); },
      get failures() { return failures; },
    };
  };

  root.TareStore = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
