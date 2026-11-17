'use strict';
// DbStore against a mock of the artifact `db` capability that follows db.d.ts:
// frozen data(), update() rejects invalid_argument when absent, snapshots with metadata, query windows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const S = require('../store.js');

function mockDb() {
  const docs = new Map();
  const listeners = [];
  const err = (code, message) => ({ code, message });
  const segs = (p) => p.split('/');
  const snapOf = (path) => {
    const body = docs.get(path);
    return { id: segs(path).pop(), exists: body !== undefined, data: () => (body === undefined ? undefined : body), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const notify = () => listeners.forEach((l) => l());
  function docRef(path) {
    if (segs(path).length % 2 !== 0) throw new TypeError('document path needs an even number of segments: ' + path);
    return {
      id: segs(path).pop(), path,
      get() { return Promise.resolve(snapOf(path)); },
      set(body) { docs.set(path, C.deepFreeze(C.clone(body))); notify(); return Promise.resolve(); },
      update(patch) { if (!docs.has(path)) return Promise.reject(err('invalid_argument', 'document does not exist')); docs.set(path, C.deepFreeze(C.deepMerge(docs.get(path), C.clone(patch)))); notify(); return Promise.resolve(); },
      delete() { docs.delete(path); notify(); return Promise.resolve(); },
      onSnapshot(next, error) { const fn = () => next(snapOf(path)); listeners.push(fn); setTimeout(fn, 0); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      collection(sub) { return colRef(path + '/' + sub); },
    };
  }
  function colRef(path, q) {
    if (segs(path).length % 2 !== 1) throw new TypeError('collection path needs an odd number of segments: ' + path);
    q = q || { where: [], orderBy: null, limit: null };
    const run = () => {
      let out = [];
      docs.forEach((body, p) => { if (p.indexOf(path + '/') === 0 && segs(p).length === segs(path).length + 1) out.push(snapOf(p)); });
      q.where.forEach(([f, op, v]) => { out = out.filter((s) => { const a = s.data()[f]; return op === '<' ? a < v : op === '==' ? a === v : op === '>' ? a > v : true; }); });
      if (q.orderBy) { const [f, dir] = q.orderBy; out.sort((a, b) => (a.data()[f] < b.data()[f] ? -1 : 1) * (dir === 'desc' ? -1 : 1)); } else out.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (q.limit) out = out.slice(0, q.limit);
      return { docs: out, size: out.length, empty: !out.length, docChanges: () => out.map((d) => ({ type: 'added', doc: d, oldIndex: -1, newIndex: 0 })), metadata: { fromCache: false, hasPendingWrites: false } };
    };
    return {
      path,
      where(f, op, v) { return colRef(path, { where: q.where.concat([[f, op, v]]), orderBy: q.orderBy, limit: q.limit }); },
      orderBy(f, dir) { return colRef(path, { where: q.where, orderBy: [f, dir || 'asc'], limit: q.limit }); },
      limit(n) { return colRef(path, { where: q.where, orderBy: q.orderBy, limit: n }); },
      get() { return Promise.resolve(run()); },
      onSnapshot(next) { const fn = () => next(run()); listeners.push(fn); setTimeout(fn, 0); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      doc(id) { return docRef(path + '/' + (id || 'auto_' + docs.size)); },
      add(body) { const r = docRef(path + '/auto_' + docs.size); return r.set(body).then(() => r); },
    };
  }
  return { doc: docRef, collection: colRef, _docs: docs };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('DbStore maps get/set/update/delete and subscriptions onto the db contract', async () => {
  const db = mockDb();
  const st = new S.DbStore(db);
  assert.equal(st.mode, 'db');
  assert.deepEqual(await st.get('meta/app'), { exists: false, data: null });
  await assert.rejects(st.update('meta/app', { x: 1 }), (e) => e.code === 'invalid_argument');
  await st.set('meta/app', { schemaVersion: 1, targets: { '2026-09-01': { kcal: 2400 } } });
  await st.update('meta/app', { targets: { '2026-09-01': null, '2026-09-10': { kcal: 2200 } }, lastBackupAt: 'x' });
  const g = await st.get('meta/app');
  assert.equal(g.exists, true);
  assert.deepEqual(g.data, { schemaVersion: 1, targets: { '2026-09-01': null, '2026-09-10': { kcal: 2200 } }, lastBackupAt: 'x' });
  assert.ok(Object.isFrozen(g.data), 'db snapshots are frozen; the app must never mutate them');
  const seen = [];
  const unsub = st.onDoc('meta/app', (body, meta) => seen.push([body && body.lastBackupAt, meta.fromCache]));
  await tick();
  assert.deepEqual(seen, [['x', false]]);
  await st.delete('meta/app');
  assert.deepEqual(seen[seen.length - 1], [null, false]);
  unsub();
  // year collection query + snapshots
  await st.set('years/2026/days/2026-09-12', { date: '2026-09-12', entries: {} });
  await st.set('years/2026/days/2026-09-10', { date: '2026-09-10', entries: {} });
  await st.set('years/2025/days/2025-12-31', { date: '2025-12-31', entries: {} });
  const qs = [];
  const unq = st.onQuery('years/2026/days', {}, (docs, meta) => qs.push(docs.map((d) => d.id)));
  await tick();
  assert.deepEqual(qs, [['2026-09-10', '2026-09-12']]);
  await st.update('years/2026/days/2026-09-12', { entries: { e1: { amount: 1 } } });
  assert.deepEqual(qs[qs.length - 1], ['2026-09-10', '2026-09-12']);
  unq();
  const older = await st.query('years/2026/days', { where: ['date', '<', '2026-09-12'], orderBy: 'date', dir: 'desc', limit: 5 });
  assert.deepEqual(older.map((d) => d.id), ['2026-09-10']);
  assert.throws(() => st.onDoc('years/2026/days', () => {}), TypeError, 'odd segment count is a document-path error');
});

test('queue + DbStore: create-on-miss, patch merge on a frozen body, overlay while pending', async () => {
  const db = mockDb();
  const st = new S.DbStore(db);
  const skeleton = (p) => { const m = C.PATH_RE.day.exec(p); return m ? { date: m[2], entries: {}, updatedAt: null } : {}; };
  const q = S.createQueue(st, { skeleton, online: () => true });
  const path = C.dayPath('2026-09-12');
  const e = C.makeEntry({ id: 'f1', name: 'Milk', brand: '', unit: 'ml', basis: 240, kcal: 120, protein: 13, carbs: 6, fat: 4.5, fiber: null }, 245, { id: 'e1', at: '2026-09-12T08:00:00' });
  q.update(path, { date: '2026-09-12', entries: C.entriesPatch([e]), updatedAt: 'a' });
  assert.deepEqual(C.dayEntries(q.overlay(path, null)).map((x) => x.id), ['e1'], 'overlay shows the row before the write lands');
  await tick(); await tick();
  const stored = (await st.get(path)).data;
  assert.equal(stored.entries.e1.amount, 245);
  assert.equal(stored.date, '2026-09-12');
  // a second device adds e2 directly; our next patch (tombstone e1) must not clobber it
  await db.doc(path).update({ entries: { e2: Object.assign({}, e, { id: 'e2' }) } });
  q.update(path, { entries: { e1: null }, updatedAt: 'b' });
  await tick(); await tick();
  const after = (await st.get(path)).data;
  assert.equal(after.entries.e1, null);
  assert.equal(after.entries.e2.amount, 245);
  assert.deepEqual(C.dayEntries(after).map((x) => x.id), ['e2']);
  // C.dayEntries never mutates the frozen doc
  assert.ok(Object.isFrozen(after) && Object.isFrozen(after.entries.e2));
  assert.equal(q.state, 'idle');
});
