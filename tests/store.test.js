'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const S = require('../store.js');

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

test('LocalStore: set/update/get/delete, frozen bodies, subscriptions, queries', async () => {
  const st = new S.LocalStore(S.memoryBackend());
  const seenDoc = [];
  const unsubDoc = st.onDoc('years/2026/days/2026-09-12', (b) => seenDoc.push(b));
  const seenQ = [];
  const unsubQ = st.onQuery('years/2026/days', {}, (docs) => seenQ.push(docs.map((d) => d.id)));
  await tick();
  assert.deepEqual(seenDoc, [null]);
  assert.deepEqual(seenQ, [[]]);
  await assert.rejects(st.update('years/2026/days/2026-09-12', { entries: { a: 1 } }), (e) => e.code === 'invalid_argument');
  await st.set('years/2026/days/2026-09-12', { date: '2026-09-12', entries: { a: { amount: 1 } } });
  await st.update('years/2026/days/2026-09-12', { entries: { b: { amount: 2 }, a: null }, updatedAt: 'x' });
  const g = await st.get('years/2026/days/2026-09-12');
  assert.equal(g.exists, true);
  assert.deepEqual(g.data, { date: '2026-09-12', entries: { a: null, b: { amount: 2 } }, updatedAt: 'x' });
  assert.ok(Object.isFrozen(g.data) && Object.isFrozen(g.data.entries.b));
  assert.equal(seenDoc.length, 3);
  assert.deepEqual(seenQ[seenQ.length - 1], ['2026-09-12']);
  await st.set('years/2026/days/2026-09-10', { date: '2026-09-10', entries: {} });
  await st.set('years/2025/days/2025-01-01', { date: '2025-01-01', entries: {} });
  assert.deepEqual(seenQ[seenQ.length - 1], ['2026-09-10', '2026-09-12']);
  const older = await st.query('years/2026/days', { where: ['date', '<', '2026-09-12'], orderBy: 'date' });
  assert.deepEqual(older.map((d) => d.id), ['2026-09-10']);
  await st.delete('years/2026/days/2026-09-12');
  assert.equal(seenDoc[seenDoc.length - 1], null);
  assert.equal((await st.get('years/2026/days/2026-09-12')).exists, false);
  unsubDoc(); unsubQ();
  await assert.rejects(st.set('foods', { a: 1 }), (e) => e.code === 'invalid_argument');
  await assert.rejects(st.set('foods/f2', [1]), (e) => e.code === 'invalid_argument');
  const be = S.memoryBackend();
  const a = new S.LocalStore(be);
  await a.set('meta/app', { schemaVersion: 1 });
  assert.deepEqual((await new S.LocalStore(be).get('meta/app')).data, { schemaVersion: 1 });
  const full = S.memoryBackend({ 'meta/app': { x: 1 } });
  full.write = () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(new S.LocalStore(full).set('meta/app', { x: 2 }), (e) => e.code === 'quota_exceeded');
});

function fakeStore() {
  const calls = [];
  const docs = {};
  const fail = { set: [], update: [], delete: [] };
  return {
    calls, docs, fail,
    set(path, body) { calls.push(['set', path, C.clone(body)]); const f = fail.set.shift(); if (f) return Promise.reject(f); docs[path] = C.clone(body); return Promise.resolve(); },
    update(path, patch) { calls.push(['update', path, C.clone(patch)]); const f = fail.update.shift(); if (f) return Promise.reject(f); if (!docs[path]) return Promise.reject({ code: 'invalid_argument', message: 'missing' }); docs[path] = C.deepMerge(docs[path], patch); return Promise.resolve(); },
    delete(path) { calls.push(['del', path]); const f = fail.delete.shift(); if (f) return Promise.reject(f); delete docs[path]; return Promise.resolve(); },
    get(path) { return Promise.resolve({ exists: !!docs[path], data: docs[path] || null }); },
  };
}
function fakeTimers() {
  const timers = [];
  return { timers, setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; }, fire: () => { const t = timers.filter((x) => x.live); t.forEach((x) => { x.live = false; }); t.forEach((x) => x.fn()); } };
}

test('queue: create-on-miss for updates, coalescing, overlay, per-path order', async () => {
  const st = fakeStore(), tm = fakeTimers();
  const changes = [];
  const q = S.createQueue(st, { skeleton: (p) => (p.indexOf('years/') === 0 ? { date: p.slice(-10), entries: {}, updatedAt: null } : null), onChange: () => changes.push(1), setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, random: () => 0.5 });
  const path = 'years/2026/days/2026-09-12';
  q.update(path, { entries: { e1: { amount: 1 } }, updatedAt: 'a' });
  // overlay applies immediately, before the write settles
  assert.deepEqual(q.overlay(path, null), { entries: { e1: { amount: 1 } }, updatedAt: 'a' });
  assert.equal(q.hasPending(path), true);
  await tick();
  assert.deepEqual(st.calls.map((c) => c[0]), ['update', 'set']);
  assert.deepEqual(st.docs[path], { date: '2026-09-12', entries: { e1: { amount: 1 } }, updatedAt: 'a' });
  assert.equal(q.size, 0); assert.equal(q.state, 'idle');
  assert.equal(q.overlay(path, st.docs[path]), st.docs[path]);
  // two quick updates coalesce while the first is not yet sent? (first goes in flight immediately; second waits then merges on its own)
  q.update(path, { entries: { e2: { amount: 2 } } });
  q.update(path, { entries: { e3: { amount: 3 } } });
  q.update(path, { entries: { e2: null } });
  await tick();
  assert.deepEqual(st.docs[path].entries, { e1: { amount: 1 }, e2: null, e3: { amount: 3 } });
  const updates = st.calls.filter((c) => c[0] === 'update' && c[1] === path);
  assert.ok(updates.length >= 2 && updates.length <= 4);
  assert.ok(changes.length > 0);
  // delete then update recreates via skeleton
  q.delete(path);
  q.update(path, { entries: { e9: { amount: 9 } } });
  await tick();
  assert.deepEqual(Object.keys(st.docs[path].entries), ['e9']);
});

test('queue: retry on unavailable, pause on resource_exhausted, block on quota, unblock after delete', async () => {
  const st = fakeStore(), tm = fakeTimers();
  const states = [], errors = [], retries = [];
  const q = S.createQueue(st, { onState: (s) => states.push(s), onError: (c, p) => errors.push(c + ':' + p), onRetry: (c) => retries.push(c), setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, random: () => 0.5 });
  st.docs['foods/a'] = { id: 'a' };
  st.fail.update = [{ code: 'unavailable' }];
  q.update('foods/a', { useCount: 1 });
  await tick();
  assert.equal(q.state, 'pending');
  assert.equal(tm.timers[0].ms, 1000);
  assert.deepEqual(retries, ['unavailable']);
  tm.fire(); await tick();
  assert.equal(st.docs['foods/a'].useCount, 1);
  assert.equal(q.state, 'idle');
  // resource_exhausted pauses the whole queue with backoff and drops concurrency to 1
  st.fail.update = [{ code: 'resource_exhausted' }];
  q.update('foods/a', { useCount: 2 });
  await tick();
  assert.equal(q.isPaused(), true);
  const live = tm.timers.filter((t) => t.live);
  assert.equal(live.length, 1);
  assert.ok(live[0].ms >= 1600 && live[0].ms <= 2400);
  tm.fire(); await tick();
  assert.equal(st.docs['foods/a'].useCount, 2);
  assert.equal(q.isPaused(), false);
  // quota: op blocked, stays in the list, retried after a successful delete
  st.fail.set = [{ code: 'quota_exceeded', message: 'full' }];
  q.set('foods/b', { id: 'b' });
  await tick();
  assert.equal(q.blockedCount, 1);
  assert.equal(q.state, 'blocked');
  assert.deepEqual(errors, ['quota_exceeded:foods/b']);
  q.delete('foods/a');
  await tick();
  assert.deepEqual(st.docs['foods/b'], { id: 'b' });
  assert.equal(q.state, 'idle');
  // invalid_argument on an existing doc is terminal: op dropped, reported
  st.docs['foods/c'] = { id: 'c' };
  st.fail.update = [{ code: 'invalid_argument', message: 'bad' }];
  q.update('foods/c', { x: 1 });
  await tick();
  assert.ok(errors.indexOf('invalid_argument:foods/c') >= 0);
  assert.equal(q.size, 0);
  // fatal -> readonly
  st.fail.update = [{ code: 'revoked' }];
  q.update('foods/c', { x: 2 });
  await tick();
  assert.equal(q.isReadonly(), true);
  assert.equal(q.update('foods/c', { x: 3 }), false);
});

test('queue: stash and restore, offline gating, concurrency cap', async () => {
  let stashed = null;
  const st = fakeStore(), tm = fakeTimers();
  let onlineFlag = false;
  const q = S.createQueue(st, { stash: { write: (t) => { stashed = t; } }, online: () => onlineFlag, setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, random: () => 0.5 });
  st.docs['foods/a'] = { id: 'a' };
  q.update('foods/a', { useCount: 5 });
  await tick();
  assert.equal(st.calls.length, 0, 'nothing sent while offline');
  assert.deepEqual(JSON.parse(stashed), [{ path: 'foods/a', verb: 'update', body: { useCount: 5 } }]);
  onlineFlag = true;
  q.retryNow();
  await tick();
  assert.equal(st.docs['foods/a'].useCount, 5);
  assert.deepEqual(JSON.parse(stashed), []);
  // restore replays a stashed list
  const q2 = S.createQueue(st, { online: () => true, setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout });
  q2.restore([{ path: 'foods/a', verb: 'update', body: { useCount: 6 } }, { path: 'foods/z', verb: 'delete', body: null }]);
  await tick();
  assert.equal(st.docs['foods/a'].useCount, 6);
  // concurrency
  let resolvers = [];
  const slow = { set() { return new Promise((r) => resolvers.push(r)); }, update() { return Promise.resolve(); }, delete() { return Promise.resolve(); }, get() { return Promise.resolve({ exists: false }); } };
  const q3 = S.createQueue(slow, { concurrency: 2, online: () => true });
  for (let i = 0; i < 5; i++) q3.set('x/' + i, { i });
  await tick();
  assert.equal(resolvers.length, 2);
  resolvers[0](); resolvers[1](); await tick();
  assert.equal(resolvers.length, 4);
  resolvers[2](); resolvers[3](); await tick();
  resolvers[4](); await tick();
  assert.equal(q3.state, 'idle');
});

test('live(): re-subscribes with backoff on transient errors, stops on fatal', async () => {
  const tm = fakeTimers();
  let subs = 0, errCb = null, deliver = true;
  const snaps = [], retries = [], fatal = [];
  const l = S.live((next, err) => { subs++; errCb = err; if (deliver) next('snap' + subs); return () => {}; }, (s) => snaps.push(s), { onRetry: (n, d, c) => retries.push([n, d, c]), onFatal: (c) => fatal.push(c), setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout });
  assert.deepEqual(snaps, ['snap1']);
  errCb({ code: 'unavailable' });
  assert.deepEqual(retries, [[1, 1000, 'unavailable']]);
  tm.fire();
  assert.equal(subs, 2);
  deliver = false;
  errCb({ code: 'weird' });
  assert.equal(retries[1][1], 1000, 'a delivered snapshot resets the backoff');
  tm.fire();
  errCb({ code: 'weird' });
  assert.equal(retries[2][1], 2000, 'consecutive failures back off');
  tm.fire();
  errCb({ code: 'resource_exhausted' });
  assert.equal(retries[3][1], 60000);
  l.retry();
  assert.equal(subs, 5);
  errCb({ code: 'revoked' });
  assert.deepEqual(fatal, ['revoked']);
  tm.fire();
  assert.equal(subs, 5);
  l.stop();
});
