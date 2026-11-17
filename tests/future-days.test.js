'use strict';
// Planning ahead: logging foods for an upcoming day (e.g. tonight's meal-prepped breakfast for tomorrow).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

test('relativeDay names near-future days the way it names near-past days', () => {
  const today = '2026-09-29';
  assert.equal(C.relativeDay('2026-09-30', today), 'tomorrow');
  assert.equal(C.relativeDay('2026-10-02', today), 'in 3 days');
  assert.equal(C.relativeDay('2026-10-05', today), 'in 6 days');
  assert.equal(C.relativeDay('2026-10-06', today), C.fmtDate('2026-10-06', false), '7+ days out falls back to the date, mirroring "N days ago" stopping at 6');
  assert.equal(C.relativeDay('2026-10-13', today), C.fmtDate('2026-10-13', false), 'far future falls back to the date, like far past does');
  assert.equal(C.relativeDay('2026-09-28', today), 'yesterday');
  assert.equal(C.relativeDay(today, today), 'today');
});

test('MAX_FUTURE_DAYS is a small, explicit bound', () => {
  assert.equal(C.MAX_FUTURE_DAYS, 14);
  assert.equal(C.addDays('2026-09-29', C.MAX_FUTURE_DAYS), '2026-10-13');
});

test('a day up to the future bound is a normal, fully valid key', () => {
  assert.equal(C.isKey(C.addDays('2026-09-29', 14)), true);
  assert.equal(C.isKey(C.addDays('2026-09-29', 400)), true, 'core has no upper bound — the app layer enforces the planning horizon');
});

test('day totals and targets work identically for a future-dated day', () => {
  const food = { id: 'f1', name: 'Oats', unit: 'g', basis: 100, kcal: 380, protein: 13, carbs: 68, fat: 6.5, fiber: 10 };
  const e = C.makeEntry(food, 80, { id: 'e1', at: '2026-09-29T20:00:00' }); // prepped the night before
  const t = C.dayTotals([e]);
  assert.equal(C.fmtInt(t.kcal), '304');
  const targets = { '2026-09-01': { kcal: 2400, protein: 180, carbs: 250, fat: 80, fiber: null } };
  assert.equal(C.targetFor(targets, '2026-09-30').kcal, 2400, 'the target in force still applies to a planned future day');
});
