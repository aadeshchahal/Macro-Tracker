'use strict';
// Regression tests for the issues found by the code review.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const S = require('../store.js');

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));
function fakeStore() {
  const docs = {}, calls = [], fail = { set: [], update: [], delete: [] };
  return {
    docs, calls, fail,
    set(path, body) { calls.push(['set', path]); const f = fail.set.shift(); if (f) return Promise.reject(f); docs[path] = C.clone(body); return Promise.resolve(); },
    update(path, patch) { calls.push(['update', path]); const f = fail.update.shift(); if (f) return Promise.reject(f); if (!docs[path]) return Promise.reject({ code: 'invalid_argument' }); docs[path] = C.deepMerge(docs[path], patch); return Promise.resolve(); },
    delete(path) { calls.push(['delete', path]); const f = fail.delete.shift(); if (f) return Promise.reject(f); delete docs[path]; return Promise.resolve(); },
    get(path) { return Promise.resolve({ exists: !!docs[path], data: docs[path] || null }); },
  };
}
const memStash = (initial) => { let t = initial == null ? null : JSON.stringify(initial); return { read: () => t, write: (x) => { t = x; }, get list() { return t ? JSON.parse(t) : null; } }; };

test('dates before 2000 are rejected everywhere keys are validated', () => {
  assert.equal(C.isKey('1026-01-01'), false);
  assert.equal(C.isKey('1999-12-31'), false);
  assert.equal(C.isKey('2000-01-01'), true);
  assert.equal(C.isYear('1026'), false);
  assert.equal(C.sanitizeApp({ firstYear: '0100' }).firstYear, null);
  const p = C.parseBackup(JSON.stringify({ app: 'tare', schemaVersion: 1, docs: { 'years/1026/days/1026-01-01': { entries: {} } } }));
  assert.equal(p.ok, true); assert.equal(p.summary.days, 0); assert.equal(p.docs['meta/app'].firstYear, null);
});

test('amount expressions are length-capped so the parser never overflows the stack', () => {
  assert.equal(C.evalExpr('('.repeat(20000) + '1').ok, false);
  assert.equal(C.evalExpr('-'.repeat(20000) + '1').ok, false);
  assert.equal(C.evalExpr('412-187').value, 225);
});

test('ids that collide with Object.prototype are rejected', () => {
  assert.equal(C.isId('__proto__'), false);
  assert.equal(C.isId('constructor'), false);
  assert.equal(C.isId('f_abc_12345678'), true);
  const p = C.parseBackup('{"app":"tare","schemaVersion":1,"docs":{"foods/__proto__":{"name":"X","unit":"g","basis":100,"kcal":1,"protein":0,"carbs":0,"fat":0}}}');
  assert.equal(p.summary.foods, 0); assert.equal(p.skipped, 1);
});

test('a backup whose settings record claims a newer schema is refused; accepted ones are stamped with ours', () => {
  const bad = C.parseBackup(JSON.stringify({ app: 'tare', schemaVersion: 1, docs: { 'meta/app': { schemaVersion: 2 } } }));
  assert.equal(bad.ok, false); assert.match(bad.error, /newer version/);
  const ok = C.parseBackup(JSON.stringify({ app: 'tare', schemaVersion: 1, docs: { 'meta/app': { settings: { weightUnit: 'kg' } } } }));
  assert.equal(ok.docs['meta/app'].schemaVersion, C.SCHEMA);
});

test('malformed exportedAt is treated as unknown', () => {
  assert.equal(C.parseBackup(JSON.stringify({ app: 'tare', schemaVersion: 1, exportedAt: 'zzz', docs: {} })).summary.exportedAt, null);
  assert.equal(C.parseBackup(JSON.stringify({ app: 'tare', schemaVersion: 1, exportedAt: '2026-09-12T10:00:00', docs: {} })).summary.exportedAt, '2026-09-12T10:00:00');
});

test('percent and energy split never print Infinity or NaN', () => {
  assert.equal(C.pct(Infinity, 2400), null);
  assert.equal(C.energySplit(Infinity, 1, 1), null);
});

test('previous session stash survives writes made before restore()', async () => {
  const st = fakeStore();
  st.docs['years/2026/days/2026-09-01'] = { date: '2026-09-01', entries: { a: null } };
  st.docs['years/2026/days/2026-09-12'] = { date: '2026-09-12', entries: {} };
  const stash = memStash([{ path: 'years/2026/days/2026-09-12', verb: 'update', body: { entries: { e1: { amount: 5 } } } }, { path: '../evil', verb: 'update', body: {} }]);
  const q = S.createQueue(st, { stash, online: () => true });
  assert.equal(q.heldCount, 1, 'invalid stashed ops are ignored');
  q.delete('years/2026/days/2026-09-01'); // housekeeping before restore
  assert.deepEqual(stash.list.map((o) => o.verb), ['update', 'delete'], 'held ops stay in the stash');
  await tick();
  assert.deepEqual(stash.list.map((o) => o.verb), ['update']);
  assert.equal(q.restore(), 1);
  assert.equal(q.heldCount, 0);
  await tick();
  assert.equal(st.docs['years/2026/days/2026-09-12'].entries.e1.amount, 5);
  assert.deepEqual(stash.list, []);
});

test('a stale stashed whole-document set never overwrites a newer document', async () => {
  const st = fakeStore();
  st.docs['foods/f1'] = { id: 'f1', name: 'Oats', kcal: 380, updatedAt: '2026-09-12T09:00:00' };
  const stash = memStash([
    { path: 'foods/f1', verb: 'set', body: { id: 'f1', name: 'Oats', kcal: 300, updatedAt: '2026-09-10T09:00:00' } },
    { path: 'foods/f2', verb: 'set', body: { id: 'f2', name: 'Rice', kcal: 130, updatedAt: '2026-09-10T09:00:00' } },
  ]);
  const q = S.createQueue(st, { stash, online: () => true });
  q.restore();
  await tick(); await tick();
  assert.equal(st.docs['foods/f1'].kcal, 380, 'newer remote record kept');
  assert.equal(st.docs['foods/f2'].name, 'Rice', 'missing record created');
  assert.equal(q.size, 0);
});

test('create-on-miss only creates documents the app allows; stray stats patches are dropped', async () => {
  const st = fakeStore();
  const dropped = [];
  const q = S.createQueue(st, {
    online: () => true,
    skeleton: (p) => (p.indexOf('years/') === 0 ? { entries: {} } : null),
    canCreate: (p, body) => p.indexOf('foods/') === 0 && !!body.name,
    onDropped: (p) => dropped.push(p),
  });
  q.update('foods/gone', { useCount: 3, lastAmount: 50 });
  q.update('years/2026/days/2026-09-12', { entries: { e: { amount: 1 } } });
  await tick(); await tick();
  assert.equal(st.docs['foods/gone'], undefined);
  assert.deepEqual(dropped, ['foods/gone']);
  assert.ok(st.docs['years/2026/days/2026-09-12']);
  assert.equal(q.size, 0);
});

test('a fatal error keeps unsaved ops visible and stashed instead of discarding them', async () => {
  const st = fakeStore();
  st.docs['years/2026/days/2026-09-12'] = { entries: {} };
  const stash = memStash(null);
  const errors = [];
  const q = S.createQueue(st, { stash, online: () => true, onError: (c) => errors.push(c) });
  st.fail.update = [{ code: 'revoked' }];
  q.update('years/2026/days/2026-09-12', { entries: { e1: { amount: 1 } } });
  await tick();
  assert.deepEqual(errors, ['revoked']);
  assert.equal(q.isReadonly(), true);
  assert.equal(q.size, 1);
  assert.equal(q.overlay('years/2026/days/2026-09-12', st.docs['years/2026/days/2026-09-12']).entries.e1.amount, 1);
  assert.equal(stash.list.length, 1);
  q.discard();
  assert.equal(q.size, 0); assert.deepEqual(stash.list, []);
});

test('a synchronous throw from the store does not wedge the path', async () => {
  let n = 0;
  const st = fakeStore();
  const orig = st.set;
  st.set = (path, body) => { n++; if (n === 1) throw new TypeError('bad path grammar'); return orig(path, body); };
  const errors = [];
  const q = S.createQueue(st, { online: () => true, onError: (c) => errors.push(c) });
  q.set('foods/a', { id: 'a' });
  await tick();
  assert.deepEqual(errors, ['invalid_argument']);
  q.set('foods/a', { id: 'a', name: 'ok' });
  await tick();
  assert.equal(st.docs['foods/a'].name, 'ok');
  assert.equal(q.state, 'idle');
});

test('concurrency returns to normal after a rate-limit pause', async () => {
  const timers = [];
  let inflight = 0, maxInflight = 0;
  const resolvers = [];
  const st = {
    set() { inflight++; maxInflight = Math.max(maxInflight, inflight); return new Promise((r) => resolvers.push(() => { inflight--; r(); })); },
    update() { return Promise.reject({ code: 'resource_exhausted' }); },
    delete() { return Promise.resolve(); }, get() { return Promise.resolve({ exists: false }); },
  };
  const q = S.createQueue(st, { online: () => true, concurrency: 2, setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, random: () => 0.5 });
  q.update('foods/x', { a: 1 });
  await tick();
  assert.equal(q.isPaused(), true);
  st.update = () => Promise.resolve();
  timers.shift()();
  await tick();
  for (let i = 0; i < 4; i++) q.set('foods/s' + i, { i });
  await tick();
  maxInflight = inflight;
  resolvers.splice(0).forEach((r) => r());
  await tick();
  assert.ok(maxInflight <= 2);
  resolvers.splice(0).forEach((r) => r());
  await tick();
  assert.equal(inflight, 0);
});

test('live(): a throwing snapshot handler does not kill the subscription', () => {
  let next = null, calls = 0;
  const l = S.live((n) => { next = n; return () => {}; }, () => { calls++; throw new Error('render bug'); }, {});
  next('a'); next('b');
  assert.equal(calls, 2);
  l.stop();
});
