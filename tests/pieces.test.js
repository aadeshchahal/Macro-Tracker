'use strict';
// Foods measured in pieces ("per 1 taco"), logged by count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const taco = { id: 'f_taco', name: 'Taco', brand: '', unit: 'pc', basis: 1, kcal: 170, protein: 8, carbs: 13, fat: 9.5, fiber: 2 };

test('a food can be saved per piece, with macros larger than the piece count', () => {
  const r = C.validateFood({ name: 'Taco', unit: 'pc', basis: '1', kcal: '170', protein: '8', carbs: '13', fat: '9.5', fiber: '2' });
  assert.equal(r.ok, true);
  assert.equal(r.food.unit, 'pc');
  assert.equal(r.food.basis, 1);
  assert.equal(r.warnings.dense, undefined, 'no grams-vs-ml warning for pieces');
  const two = C.validateFood({ name: 'Cookies', unit: 'pc', basis: '2', kcal: '160', protein: '2', carbs: '22', fat: '7' });
  assert.equal(two.ok, true);
  assert.equal(C.validateFood({ name: 'X', unit: 'oz', basis: '1', kcal: '1', protein: '0', carbs: '0', fat: '0' }).errors.unit, 'Choose g, ml or pieces');
});

test('logging 2 tacos doubles the label; half an orange works too', () => {
  const e = C.makeEntry(taco, 2, { id: 'e1', at: 'x' });
  assert.equal(e.unit, 'pc');
  const v = C.entryValues(e);
  assert.equal(v.kcal, 340); assert.equal(v.protein, 16); assert.equal(v.fat, 19); assert.equal(v.fiber, 4);
  const cookies = { id: 'f_c', name: 'Cookies', unit: 'pc', basis: 2, kcal: 160, protein: 2, carbs: 22, fat: 7, fiber: null };
  assert.equal(C.entryValues(C.makeEntry(cookies, 3, { id: 'e2' })).kcal, 240);
  assert.equal(C.entryValues(C.makeEntry(taco, 0.5, { id: 'e3' })).kcal, 85);
});

test('piece counts are not flagged as typos the way gram jumps are', () => {
  assert.equal(C.checkAmount(6, 1, 'pc').warning, null);
  assert.match(C.checkAmount(60, 1, 'pc').warning, /typo/);
  assert.match(C.checkAmount(600, 100, 'g').warning, /typo/);
  assert.equal(C.checkAmount(0.5, 1, 'pc').ok, true);
});

test('sanitizers, placeholders and backups keep the pieces unit', () => {
  assert.equal(C.sanitizeFood(taco).unit, 'pc');
  const e = C.makeEntry(taco, 2, { id: 'e1', at: '2026-09-13T12:00:00' });
  assert.equal(C.sanitizeEntry(e).unit, 'pc');
  assert.equal(C.placeholderFood(Object.assign({}, e, { foodId: 'gone' }), 'now').unit, 'pc');
  const docs = { 'foods/f_taco': C.sanitizeFood(taco), 'years/2026/days/2026-09-13': { date: '2026-09-13', entries: { e1: e } } };
  const p = C.parseBackup(JSON.stringify(C.buildBackup(docs, '2026-09-13T12:00:00')));
  assert.equal(p.docs['foods/f_taco'].unit, 'pc');
  assert.equal(p.docs['years/2026/days/2026-09-13'].entries.e1.unit, 'pc');
});

test('unit labels read naturally', () => {
  assert.equal(C.unitLabel('pc'), 'pc');
  assert.equal(C.unitLabel('serving'), '×');
  assert.equal(C.unitName('pc'), 'pieces');
  assert.equal(C.unitName('g'), 'grams');
});
