'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const seq = () => { let i = 0; return () => 'e_test_' + (++i); };
const day = (entries, date) => ({ date: date || '2026-09-12', updatedAt: null, entries: C.entriesPatch(entries) });

test('scaling multiplies first: 120 kcal per 240 ml, 245 ml -> 122.5 -> "123"', () => {
  const v = C.scale({ kcal: 120, protein: 13, carbs: 6, fat: 4.5, fiber: null }, 245, 240);
  assert.equal(v.kcal, 122.5);
  assert.equal(C.fmtInt(v.kcal), '123');
  assert.equal(v.fiber, null);
  assert.equal(C.fmt1(v.protein), '13.3');
});

test('critic example 1: granola per 30 g, log 85 g', () => {
  const e = C.makeEntry({ id: 'f1', name: 'Granola', brand: '', unit: 'g', basis: 30, kcal: 140, protein: 3, carbs: 22, fat: 5, fiber: 3 }, 85, { id: 'e1', at: 'x' });
  const v = C.entryValues(e);
  assert.equal(C.fmtInt(v.kcal), '397');
  assert.equal(C.fmt1(v.protein), '8.5');
  assert.equal(C.fmt1(v.carbs), '62.3');
  assert.equal(C.fmt1(v.fat), '14.2');
  assert.equal(C.fmt1(v.fiber), '8.5');
});

test('critic examples 2+3 and day totals sum unrounded', () => {
  const oj = C.makeEntry({ id: 'f2', name: 'OJ', unit: 'ml', basis: 100, kcal: 45, protein: 0.5, carbs: 10, fat: 0, fiber: null }, 250, { id: 'e2' });
  const oats = C.makeEntry({ id: 'f3', name: 'Oats', unit: 'g', basis: 40, kcal: 150, protein: 5, carbs: 27, fat: 2.5, fiber: 4 }, 71, { id: 'e3' });
  const gran = C.makeEntry({ id: 'f1', name: 'Granola', unit: 'g', basis: 30, kcal: 140, protein: 3, carbs: 22, fat: 5, fiber: 3 }, 85, { id: 'e1' });
  const vo = C.entryValues(oj), vt = C.entryValues(oats);
  assert.equal(C.fmtInt(vo.kcal), '113');
  assert.equal(C.fmt1(vo.protein), '1.3');
  assert.equal(C.fmtInt(vt.kcal), '266');
  assert.equal(C.fmt1(vt.protein), '8.9');
  assert.equal(C.fmt1(vt.carbs), '47.9');
  assert.equal(C.fmt1(vt.fat), '4.4');
  const t = C.dayTotals([gran, oj, oats]);
  assert.equal(C.fmtInt(t.kcal), '775');
  assert.equal(C.fmt1(t.kcal), '775.4');
  assert.equal(C.fmtInt(t.protein), '19');
  assert.equal(t.fiberCount, 2);
  assert.equal(C.fmt1(t.fiber), '15.6');
});

test('energy split uses largest remainder and sums to 100', () => {
  assert.deepEqual(C.energySplit(180, 250, 80), { protein: 30, carbs: 41, fat: 29 });
  assert.equal(C.energySplit(0, 0, 0), null);
  const s = C.energySplit(18.625, 135.26, 18.6);
  assert.equal(s.protein + s.carbs + s.fat, 100);
  assert.equal(C.targetsLine(180, 250, 80), 'P 180 g + C 250 g + F 80 g = 2,440 kcal (30% / 41% / 29%)');
});

test('kcal vs macro check thresholds and kJ', () => {
  assert.equal(C.kcalCheck(140, 3, 22, 5).mismatch, false);
  assert.equal(C.kcalCheck(120, 13, 6, 4.5).mismatch, false);
  assert.equal(C.kcalCheck(100, 10, 10, 10).mismatch, true);
  assert.equal(C.kcalCheck(5, 10, 10, 10).mismatch, false);
  const r = C.parseEnergy('502 kJ');
  assert.equal(r.ok, true); assert.equal(r.value, 120); assert.equal(r.fromKj, 502);
  assert.equal(C.parseEnergy('120').fromKj, null);
  assert.equal(C.kjToKcal(502), 120);
});

test('number parsing and expression parser', () => {
  assert.equal(C.parseNum('4.5').value, 4.5);
  assert.equal(C.parseNum('.5').value, 0.5);
  assert.equal(C.parseNum('4,5').ok, false);
  assert.match(C.parseNum('4,5').error, /dot/);
  assert.equal(C.parseNum('1e3').ok, false);
  assert.equal(C.parseNum('').empty, true);
  assert.equal(C.evalExpr('412-187').value, 225);
  assert.equal(C.evalExpr('454/2').value, 227);
  assert.equal(C.evalExpr('(412-341)').value, 71);
  assert.equal(C.evalExpr('2*(3+4)').value, 14);
  assert.equal(C.evalExpr('-5').value, -5);
  assert.equal(C.evalExpr('1,5').ok, false);
  assert.equal(C.evalExpr('abc').ok, false);
  assert.equal(C.evalExpr('').empty, true);
  assert.equal(C.evalExpr('(1+2').ok, false);
  assert.equal(C.evalExpr('1/0').ok, false);
  assert.equal(C.evalExpr('5*').ok, false);
});

test('dates are local, noon-anchored and DST safe', () => {
  assert.equal(C.todayKey(new Date(2026, 8, 12, 23, 59)), '2026-09-12');
  assert.equal(C.addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(C.addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(C.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(C.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(C.daysBetween('2026-10-31', '2026-11-02'), 2);
  assert.equal(C.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(C.isKey('2026-02-29'), false);
  assert.equal(C.isKey('2028-02-29'), true);
  assert.equal(C.isKey('abc'), false);
  assert.equal(C.weekMonday('2026-09-12'), '2026-09-07');
  assert.equal(C.weekMonday('2026-09-13'), '2026-09-07');
  assert.equal(C.fmtDate('2026-09-12'), 'Sat 12 Sep 2026');
  assert.equal(C.fmtDate('2026-09-12', false), 'Sat 12 Sep');
  assert.equal(C.fmtMonthYear('2026-09-05'), "Sep '26");
  assert.equal(C.nowLocal(new Date(2026, 8, 12, 8, 5, 3)), '2026-09-12T08:05:03');
  assert.equal(C.relativeDay('2026-09-11', '2026-09-12'), 'yesterday');
  assert.equal(C.timeAgo('2026-09-01T10:00:00', new Date(2026, 8, 12)), '11 days ago');
  assert.equal(C.timeAgo(null), 'never');
  assert.equal(C.yearOf('2026-09-12'), '2026');
  assert.equal(C.dayPath('2026-09-12'), 'years/2026/days/2026-09-12');
  assert.equal(C.daysCol('2026'), 'years/2026/days');
  assert.equal(C.weightsPath('2026'), 'weights/2026');
});

test('ids: prefix, time, sequence + random, valid path segments, ordered within a tick', () => {
  const a = C.newId('e_', 1757700000000, () => 0.5), b = C.newId('e_', 1757700000000, () => 0.5);
  assert.match(a, /^e_[0-9a-z]+_[0-9a-z]{8}$/);
  assert.ok(C.ID_RE.test(a));
  assert.ok(a < b, 'sequence keeps creation order inside one millisecond');
  const real = C.newId('f_');
  assert.match(real, /^f_[0-9a-z]+_[0-9a-z]{8}$/);
});

test('deepMerge follows update semantics and never mutates', () => {
  const base = Object.freeze({ a: 1, entries: Object.freeze({ x: Object.freeze({ amount: 1 }), y: Object.freeze({ amount: 2 }) }), list: Object.freeze([1, 2]) });
  const out = C.deepMerge(base, { entries: { x: null, z: { amount: 3 } }, list: [9], b: 'new' });
  assert.deepEqual(out, { a: 1, entries: { x: null, y: { amount: 2 }, z: { amount: 3 } }, list: [9], b: 'new' });
  assert.deepEqual(base.entries, { x: { amount: 1 }, y: { amount: 2 } });
  assert.deepEqual(C.deepMerge(null, { a: { b: 1 } }), { a: { b: 1 } });
  assert.deepEqual(C.deepMerge({ a: 5 }, { a: { b: 1 } }), { a: { b: 1 } });
  const f = C.deepFreeze({ a: { b: [1, { c: 2 }] } });
  assert.ok(Object.isFrozen(f.a.b[1]));
});

test('dayEntries reads a tombstoned map in (at, id) order and skips unreadable records', () => {
  const doc = { date: '2026-09-12', entries: {
    e2: { foodId: 'f', name: 'B', amount: 2, unit: 'g', basis: 100, n: { kcal: 1, protein: 1, carbs: 1, fat: 1 }, at: '2026-09-12T08:00:01' },
    e1: { foodId: 'f', name: 'A', amount: 1, unit: 'g', basis: 100, n: { kcal: 1, protein: 1, carbs: 1, fat: 1 }, at: '2026-09-12T08:00:00' },
    e3: null,
    bad: { amount: 'x' },
    e0: { foodId: null, name: 'Q', amount: 1, unit: 'serving', basis: 1, n: { kcal: 700, protein: 30, carbs: 60, fat: 30 }, at: null },
  } };
  const es = C.dayEntries(doc);
  assert.deepEqual(es.map((e) => e.id), ['e0', 'e1', 'e2']);
  assert.equal(es[1].name, 'A');
  assert.equal(C.dayEntries(doc), es, 'cached per doc object');
  assert.equal(C.unreadableEntries(doc), 1);
  assert.equal(C.isLogged(doc), true);
  assert.equal(C.isLogged({ entries: { a: null } }), false);
  assert.equal(C.isAllTombstones({ entries: { a: null, b: null } }), true);
  assert.equal(C.isAllTombstones({ entries: {} }), false);
  assert.equal(C.dayEntries(null).length, 0);
  const s = C.sanitizeDay(doc, '2026-09-12');
  assert.deepEqual(Object.keys(s.value.entries).sort(), ['e0', 'e1', 'e2']);
  assert.equal(s.skipped, 1);
  assert.equal(C.sanitizeDay({ entries: { a: null } }, '2026-09-12').value, null);
});

test('weights: per-year docs, tombstones, validity; app targets map', () => {
  const live = C.liveWeights({ '2026': { year: '2026', byDate: { '2026-09-12': { v: 181.2, u: 'lb' }, '2026-09-11': null, '2026-09-10': { v: 5, u: 'kg' }, 'bad': { v: 100, u: 'kg' } } }, '2025': { byDate: { '2025-12-31': { v: 82, u: 'kg', at: 'x' } } } });
  assert.deepEqual(Object.keys(live).sort(), ['2025-12-31', '2026-09-12']);
  const s = C.sanitizeWeightsDoc({ byDate: { '2026-09-12': { v: 181.2, u: 'lb' }, '2025-01-01': { v: 80, u: 'kg' }, '2026-01-01': null } }, '2026');
  assert.equal(s.count, 1); assert.equal(s.skipped, 1); assert.equal(s.value.year, '2026');
  const app = C.sanitizeApp({ settings: { weightUnit: 'stone' }, firstYear: '2025', targets: { '2026-09-10': { kcal: 2200, protein: 99999 }, '2026-09-01': { kcal: 2400 }, 'x': { kcal: 1 }, '2026-09-05': null } });
  assert.equal(app.settings.weightUnit, 'lb'); assert.equal(app.firstYear, '2025');
  assert.deepEqual(Object.keys(app.targets).sort(), ['2026-09-01', '2026-09-10']);
  assert.equal(app.targets['2026-09-10'].protein, null);
  assert.equal(C.targetFor(app.targets, '2026-09-05').kcal, 2400);
  assert.equal(C.targetFor(app.targets, '2026-09-12').kcal, 2200);
  assert.equal(C.targetFor(app.targets, '2026-08-01'), null);
  assert.equal(C.targetsList(app.targets)[0].from, '2026-09-01');
  const legacy = C.sanitizeApp({ targets: [{ from: '2026-09-01', kcal: 2000 }] });
  assert.equal(legacy.targets['2026-09-01'].kcal, 2000);
});

test('weight trend, rate, change, ranges', () => {
  const s = [{ date: '2026-09-10', v: 181.6 }, { date: '2026-09-11', v: 182.4 }, { date: '2026-09-12', v: 181.2 }];
  const t = C.trend(s);
  assert.equal(C.round3(t[1]), 181.68);
  assert.equal(C.round3(t[2]), 181.632);
  const s2 = [{ date: '2026-08-15', v: 183.5 }, { date: '2026-08-20', v: 183 }, { date: '2026-09-12', v: 181.6 }];
  const t2 = C.trend(s2);
  assert.equal(C.round3(C.ratePerWeek(s2, t2)), C.round3((t2[2] - t2[0]) / 28 * 7));
  const cr = C.changeOverRange(s2, t2, '2026-08-15');
  assert.equal(C.round3(cr.perWeek), C.round3(cr.change / 28 * 7));
  assert.equal(C.round1(C.toUnit(100, 'kg', 'lb')), 220.5);
  assert.equal(C.checkWeight(199.5, 'lb', { v: 181.2, u: 'lb' }).warning, '181.2 → 199.5 lb, +10% — looks off?');
  assert.equal(C.checkWeight(197.2, 'lb', { v: 181.2, u: 'lb' }).warning, null);
  assert.equal(C.checkWeight(15, 'kg').ok, false);
  assert.equal(C.sevenDayAvg([{ date: '2026-09-10', v: 180 }, { date: '2026-09-12', v: 182 }], '2026-09-12'), 181);
  assert.deepEqual(C.rangeStart('1M', '2026-09-12'), { start: '2026-08-14', n: 30 });
  assert.deepEqual(C.rangeStart('All', '2026-09-12', '2026-01-01'), { start: '2026-01-01', n: 255 });
});

test('food validation: label rules, kJ unit select, quick amounts', () => {
  const dense = C.validateFood({ name: 'Syrup', unit: 'ml', basis: '10', kcal: '64', protein: '0', carbs: '17', fat: '0' });
  assert.equal(dense.ok, true); assert.match(dense.warnings.dense, /double-check/);
  const bad = C.validateFood({ name: 'Chicken', unit: 'g', basis: '30', kcal: '165', protein: '31', carbs: '0', fat: '3.6' });
  assert.equal(bad.ok, false); assert.match(bad.errors.protein, /can't exceed/);
  const computed = C.validateFood({ name: 'X', unit: 'g', basis: '100', kcal: '', protein: '10', carbs: '10', fat: '10' });
  assert.equal(computed.kcalComputed, true); assert.equal(computed.food.kcal, 170);
  const kj = C.validateFood({ name: 'X', unit: 'g', basis: '100', kcal: '502', energyUnit: 'kJ', protein: '1', carbs: '1', fat: '1' });
  assert.equal(kj.food.kcal, 120); assert.equal(kj.fromKj, 502);
  const kj2 = C.validateFood({ name: 'X', unit: 'g', basis: '100', kcal: '502 kJ', protein: '1', carbs: '1', fat: '1' });
  assert.equal(kj2.food.kcal, 120);
  assert.match(C.validateFood({ name: 'X', unit: 'g', basis: '', kcal: '1', protein: '1', carbs: '1', fat: '1' }).errors.basis, /How much/);
  assert.match(C.validateFood({ name: 'X', unit: 'g', basis: '100', kcal: '100', protein: '10', carbs: '10', fat: '10' }).warnings.kcal, /170 kcal/);
  const q = C.validateFood({ name: 'Whey', unit: 'g', basis: '31', kcal: '120', protein: '24', carbs: '3', fat: '1', quick: [{ label: '1 scoop', amount: '31' }, { label: '', amount: '5' }] });
  assert.deepEqual(q.food.quick, [{ label: '1 scoop', amount: 31 }]);
  assert.equal(C.checkAmount(0).ok, false);
  assert.match(C.checkAmount(600, 100).warning, /typo/);
  const v = C.validateTargets({ from: '2026-09-01', kcal: '2400', protein: '180', carbs: '', fat: '80', fiber: '' });
  assert.equal(v.ok, true); assert.equal(v.target.carbs, null);
});

test('sanitizers accept quick entries and reject broken records', () => {
  const quick = C.sanitizeEntry({ id: 'e1', foodId: null, name: 'Bowl', amount: 1, unit: 'serving', basis: 1, n: { kcal: 700, protein: 30, carbs: 60, fat: 30 } });
  assert.equal(quick.unit, 'serving'); assert.equal(quick.n.fiber, null);
  assert.equal(C.sanitizeEntry({ id: 'e2', amount: '85', unit: 'g', basis: 100, n: { kcal: 1, protein: 1, carbs: 1, fat: 1 } }), null);
  assert.equal(C.sanitizeEntry({ amount: 85, unit: 'g', basis: 100, n: { kcal: 1, protein: 1, carbs: 1, fat: 1 } }, 'key1').id, 'key1');
  assert.equal(C.sanitizeFood({ id: 'f', name: 'A', unit: 'oz', basis: 100, kcal: 1, protein: 1, carbs: 1, fat: 1 }), null);
  assert.equal(C.sanitizeFood({ id: 'bad id', name: 'A', unit: 'g', basis: 100, kcal: 1, protein: 1, carbs: 1, fat: 1 }), null);
  const f = C.sanitizeFood({ id: 'f', name: ' A ', unit: 'g', basis: 100, kcal: 1, protein: 1, carbs: 1, fat: 1, useCount: -2 });
  assert.equal(f.name, 'A'); assert.equal(f.useCount, 0);
  assert.equal(C.sanitizeMeal({ id: 'm', name: 'Shake', items: [] }), null);
  assert.equal(C.sanitizeMeal({ id: 'm', name: 'Shake', items: [{ foodId: 'f', amount: 30 }, { foodId: 'g', amount: 0 }] }).items.length, 1);
});

test('search, use30, chips, references over map-shaped days', () => {
  const foods = { a: { id: 'a', name: 'Chicken breast', brand: '' }, b: { id: 'b', name: 'Greek yogurt', brand: 'Fage', favorite: true }, c: { id: 'c', name: 'Chicken thigh', brand: '', archived: true }, d: { id: 'd', name: 'Chickpeas', brand: '' } };
  const items = Object.values(foods).map((f) => ({ type: 'food', food: f })).concat([{ type: 'meal', meal: { id: 'm', name: 'Morning shake' } }]);
  const mk = (foodId, mealId, at) => ({ foodId, mealId, name: 'x', amount: 1, unit: 'g', basis: 1, n: { kcal: 1, protein: 1, carbs: 1, fat: 1 }, at });
  const days = { '2026-09-12': { entries: { e1: mk('d', 'm', '1'), e2: mk('d', 'm', '2'), e3: mk('a', null, '3'), e4: null } }, '2026-07-01': { entries: { e5: mk('a', null, '1') } } };
  const u = C.use30(days, '2026-09-12');
  assert.equal(u.foods.get('d'), 2); assert.equal(u.foods.get('a'), 1); assert.equal(u.meals.get('m'), 1);
  const names = (q) => C.rankItems(q, items, u).map((it) => (it.type === 'food' ? it.food.name : it.meal.name));
  assert.deepEqual(names('chi'), ['Chickpeas', 'Chicken breast']);
  assert.deepEqual(names('gr yo'), ['Greek yogurt']);
  assert.deepEqual(names('ck'), []);
  const chips = C.chips(foods, { m: { id: 'm', name: 'M' } }, u, 12).map((c) => (c.type === 'food' ? c.food.id : c.meal.id));
  assert.deepEqual(chips, ['b', 'd', 'a', 'm']);
  const refs = C.foodReferences('a', days, { m: { name: 'Shake', items: [{ foodId: 'a', amount: 1 }] } });
  assert.equal(refs.entries, 2); assert.deepEqual(refs.mealNames, ['Shake']);
});

test('copy, meals, placeholders, patches', () => {
  const e = C.makeEntry({ id: 'f1', name: 'Milk', brand: 'Fairlife', unit: 'ml', basis: 240, kcal: 120, protein: 13, carbs: 6, fat: 4.5, fiber: null }, 245, { id: 'e1', at: 'a', mealId: 'm1' });
  const copies = C.copyEntries([e], 'b', seq());
  assert.equal(copies[0].id, 'e_test_1'); assert.equal(copies[0].mealId, 'm1');
  copies[0].n.kcal = 1; assert.equal(e.n.kcal, 120);
  const foods = { f1: { id: 'f1', name: 'Milk', unit: 'ml', basis: 240, kcal: 120, protein: 13, carbs: 6, fat: 4.5, fiber: null, archived: true } };
  const r = C.expandMeal({ id: 'm1', name: 'Shake', items: [{ foodId: 'f1', amount: 250 }, { foodId: 'gone', amount: 10 }] }, foods, 'now', seq());
  assert.equal(r.entries.length, 1); assert.deepEqual(r.skipped, ['gone']);
  assert.deepEqual(Object.keys(C.entriesPatch(r.entries)), [r.entries[0].id]);
  const ph = C.placeholderFood(Object.assign({}, e, { foodId: 'missing' }), 'now');
  assert.equal(ph.archived, true); assert.equal(ph.unit, 'ml');
  const qe = C.makeQuickEntry({ name: 'Bowl', kcal: 700, protein: 30, carbs: 60, fat: 30 }, { id: 'q1', at: 'now' });
  assert.equal(C.entryValues(Object.assign({}, qe, { amount: 2 })).kcal, 1400);
});

test('weekly rows over map docs', () => {
  const days = { '2026-09-12': day([C.makeQuickEntry({ name: 'x', kcal: 2000, protein: 100, carbs: 200, fat: 50 }, { id: 'q', at: '1' })]), '2026-09-08': day([C.makeQuickEntry({ name: 'y', kcal: 1000, protein: 50, carbs: 100, fat: 25 }, { id: 'r', at: '1' })], '2026-09-08') };
  const series = [{ date: '2026-09-02', v: 182 }, { date: '2026-09-09', v: 181 }, { date: '2026-09-12', v: 180 }];
  const trend = C.trend(series);
  const rows = C.weeklyRows(days, series, trend, '2026-08-20', '2026-09-12', 52);
  assert.equal(rows[0].week, '2026-09-07'); assert.equal(rows[0].logged, 2); assert.equal(rows[0].avgKcal, 1500); assert.equal(rows[0].avgWeight, 180.5);
  assert.equal(rows[1].week, '2026-08-31'); assert.equal(rows[1].logged, 0); assert.equal(rows[1].avgWeight, 182);
  assert.equal(rows.length, 2);
});

test('backup: build strips tombstones, parse validates paths and migrates firstYear', () => {
  const e = C.makeEntry({ id: 'f1', name: 'Milk', unit: 'ml', basis: 240, kcal: 120, protein: 13, carbs: 6, fat: 4.5, fiber: null }, 245, { id: 'e1', at: 'a' });
  const docs = {
    'meta/app': { schemaVersion: 1, settings: { weightUnit: 'kg' }, targets: { '2026-09-01': { kcal: 2400 }, '2026-09-02': null } },
    'weights/2026': { year: '2026', byDate: { '2026-09-12': { v: 82.2, u: 'kg', at: null }, '2026-09-11': null } },
    'weights/2024': { year: '2024', byDate: { '2024-01-01': null } },
    'foods/f1': C.sanitizeFood({ id: 'f1', name: 'Milk', unit: 'ml', basis: 240, kcal: 120, protein: 13, carbs: 6, fat: 4.5 }),
    'meals/m1': { id: 'm1', name: 'Shake', items: [{ foodId: 'f1', amount: 250 }] },
    'years/2026/days/2026-09-12': { date: '2026-09-12', entries: { e1: e, dead: null } },
    'years/2026/days/2026-09-10': { date: '2026-09-10', entries: { dead: null } },
    'years/2025/days/2025-03-03': { date: '2025-03-03', entries: { e9: Object.assign({}, e, { id: 'e9' }) } },
  };
  const b = C.buildBackup(docs, '2026-09-12T10:00:00');
  assert.deepEqual(Object.keys(b.docs).sort(), ['foods/f1', 'meals/m1', 'meta/app', 'weights/2026', 'years/2025/days/2025-03-03', 'years/2026/days/2026-09-12']);
  assert.deepEqual(Object.keys(b.docs['years/2026/days/2026-09-12'].entries), ['e1']);
  assert.deepEqual(Object.keys(b.docs['weights/2026'].byDate), ['2026-09-12']);
  assert.deepEqual(Object.keys(b.docs['meta/app'].targets), ['2026-09-01']);
  const p = C.parseBackup(JSON.stringify(b));
  assert.equal(p.ok, true);
  assert.equal(p.summary.foods, 1); assert.equal(p.summary.meals, 1); assert.equal(p.summary.days, 2); assert.equal(p.summary.weights, 1);
  assert.equal(p.summary.firstDay, '2025-03-03'); assert.equal(p.skipped, 0);
  assert.equal(p.docs['meta/app'].firstYear, '2025');
  assert.equal(p.docs['meta/app'].settings.weightUnit, 'kg');
  const junk = C.parseBackup(JSON.stringify({ app: 'tare', schemaVersion: 1, docs: { 'junk/x': {}, 'years/2026/days/2025-01-01': { entries: { a: e } }, 'foods/f2': { name: '' }, 'days/2026-01-01': {} } }));
  assert.equal(junk.ok, true); assert.equal(junk.skipped, 4);
  assert.equal(C.parseBackup('{').ok, false);
  assert.match(C.parseBackup('{"app":"other"}').error, /not a Tare backup/);
  assert.match(C.parseBackup('{"app":"tare","schemaVersion":2,"docs":{}}').error, /newer version/);
});
