/* Tare — screens.js
   Foods (list + Nutrition-Facts-style editor + meals), Progress (charts, weekly table, weigh-ins),
   Settings (targets, weight, backup/restore, data, help, erase). Registers on window.Tare (see app.js). */
(function (root) {
  'use strict';
  const T = root.Tare, C = root.TareCore, h = T.h, $ = T.$, clear = T.clear;
  const perLine = (f) => 'per ' + C.fmt1(f.basis) + ' ' + C.unitLabel(f.unit) + ': ' + C.fmtInt(f.kcal) + ' kcal · ' + C.fmt1(f.protein) + ' P · ' + C.fmt1(f.carbs) + ' C · ' + C.fmt1(f.fat) + ' F' + (f.fiber != null ? ' · Fib ' + C.fmt1(f.fiber) : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ================================================================ Foods
  let foodsBound = false;
  function bindFoods() {
    if (foodsBound) return; foodsBound = true;
    $('food-search').addEventListener('input', (e) => { T.ui.foodQuery = e.target.value; renderFoodList(); });
    $('food-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; T.ui.foodQuery = ''; renderFoodList(); } });
    $('food-filter').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { T.ui.foodFilter = b.dataset.f; renderFoodList(); }));
    $('food-sort').addEventListener('change', (e) => { T.ui.foodSort = e.target.value; renderFoodList(); });
    $('food-new').addEventListener('click', () => openFoodForm({}));
  }
  T.renderers.foods = function () {
    bindFoods();
    $('food-filter').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === T.ui.foodFilter));
    $('food-sort').value = T.ui.foodSort;
    $('food-new').disabled = !T.canCreate();
    renderFoodList();
  };
  function renderFoodList() {
    const box = clear($('food-list'));
    if (!T.baseReady() && !Object.keys(T.data.foods).length) { box.appendChild(h('div', { class: 'loading', text: 'Loading…' })); return; }
    const q = T.ui.foodQuery.trim();
    const filter = T.ui.foodFilter;
    const canWrite = T.canWrite();
    if (filter === 'meals') { renderMealList(box, q); return; }
    let foods = Object.values(T.data.foods).filter((f) => filter === 'archived' ? f.archived : (!f.archived && (filter !== 'fav' || f.favorite)));
    if (q) {
      const items = foods.map((f) => ({ type: 'food', food: Object.assign({}, f, { archived: false }), real: f }));
      foods = C.rankItems(q, items, T.use30()).map((it) => it.real);
    } else if (T.ui.foodSort === 'used') foods.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || a.name.localeCompare(b.name));
    else foods.sort((a, b) => a.name.localeCompare(b.name));
    if (!Object.keys(T.data.foods).length) {
      box.appendChild(h('div', { class: 'empty' },
        h('div', { text: 'No foods yet.' }),
        h('div', { class: 'small', style: 'max-width:46ch', text: 'Grab your packages: for each one, type the name and the numbers exactly as printed, including the "per" amount (per 100 g, per 55 g serving, per 240 ml).' }),
        h('div', { class: 'row', style: 'justify-content:center' },
          h('button', { class: 'btn btn-primary', type: 'button', disabled: !T.canCreate(), onclick: () => openFoodForm({}) }, '+ New food'),
          h('button', { class: 'btn', type: 'button', disabled: !T.canCreate(), onclick: addStarterFoods }, 'Add 12 starter foods')),
        h('div', { class: 'tiny muted', text: 'Starter foods use generic values per 100 g — replace them with your own labels.' })));
      return;
    }
    if (!foods.length) { box.appendChild(h('div', { class: 'empty', text: q ? 'No foods match "' + q + '"' : 'Nothing here' })); return; }
    foods.forEach((f) => box.appendChild(foodRow(f, canWrite)));
  }
  function foodRow(f, canWrite) {
    const star = h('button', { class: 'star' + (f.favorite ? ' on' : ''), type: 'button', 'aria-label': f.favorite ? 'Remove from favorites' : 'Add to favorites', title: 'Favorite', disabled: !canWrite, onclick: (e) => { e.stopPropagation(); T.patch('foods/' + f.id, { favorite: !f.favorite, updatedAt: T.now() }); } }, f.favorite ? '★' : '☆');
    return h('div', { class: 'food-row', onclick: () => openFoodForm({ food: f }) },
      star,
      h('button', { class: 'fname', type: 'button', onclick: (e) => { e.stopPropagation(); openFoodForm({ food: f }); } }, f.name, f.brand ? h('span', { class: 'brand', text: ' · ' + f.brand }) : null, f.archived ? h('span', { class: 'tag', style: 'margin-left:6px;font-size:11px;padding:0 5px;border-radius:3px;background:var(--surface-2);color:var(--ink-2)', text: 'archived' }) : null),
      h('div', { class: 'factions' },
        h('span', { class: 'fused', text: f.useCount ? 'used ' + f.useCount + '×' : '' }),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: !T.canCreate(), onclick: (e) => { e.stopPropagation(); duplicateFood(f); } }, 'Duplicate')),
      h('div', { class: 'fmeta', text: perLine(f) }));
  }
  function duplicateFood(f) {
    const copy = Object.assign({}, f, { id: null, name: f.name + ' (copy)', useCount: 0, lastUsedAt: null, lastAmount: null, archived: false, quick: f.quick.map((q) => Object.assign({}, q)) });
    openFoodForm({ food: copy, isCopy: true });
  }
  function addStarterFoods() {
    if (!T.canCreate()) return;
    const existing = new Set(Object.values(T.data.foods).map((f) => (f.name + '|' + f.brand).toLowerCase()));
    let n = 0;
    T.batch(() => {
      C.STARTER_FOODS.forEach((r) => {
        if (existing.has((r[0] + '|Starter').toLowerCase())) return;
        const f = C.sanitizeFood({ id: T.newId('f_'), name: r[0], brand: 'Starter', unit: r[1], basis: 100, kcal: r[2], protein: r[3], carbs: r[4], fat: r[5], fiber: r[6], quick: [], createdAt: T.now(), updatedAt: T.now() });
        T.setDoc('foods/' + f.id, f); n++;
      });
    });
    T.toast(n ? 'Added ' + n + ' starter foods — edit or delete them any time' : 'Starter foods are already in your list');
  }

  // ------------------------------------------------- Nutrition-Facts food form
  function openFoodForm(opts) {
    if (!T.canWrite()) { T.toast(T.readonly() ? 'Read-only right now' : 'Still loading your data…'); return; }
    if (!(opts.food && opts.food.id && !opts.isCopy) && !T.canCreate()) { T.toast('The database is full — free some space before adding foods'); return; }
    const orig = opts.food || null;
    const editing = !!(orig && orig.id && !opts.isCopy);
    const F = {};
    const mkIn = (key, attrs) => { F[key] = h('input', Object.assign({ type: 'text', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' }, attrs || {})); return F[key]; };
    const v = (x) => (x == null ? '' : String(x));
    mkIn('name', { placeholder: 'Food name', value: orig ? orig.name : (opts.name || ''), 'aria-label': 'Name', maxlength: '80', autocapitalize: 'words' });
    mkIn('brand', { placeholder: 'Brand (optional)', value: orig ? orig.brand : '', 'aria-label': 'Brand', maxlength: '80', autocapitalize: 'words' });
    mkIn('basis', { inputmode: 'decimal', value: orig ? v(orig.basis) : (T.ui.lastBasis || '100'), 'aria-label': 'Label amount' });
    F.unit = h('select', { 'aria-label': 'Unit' }, h('option', { value: 'g', text: 'g' }), h('option', { value: 'ml', text: 'ml' }), h('option', { value: 'pc', text: 'pieces' }));
    F.unit.value = orig ? orig.unit : (T.ui.lastUnit || 'g');
    mkIn('kcal', { inputmode: 'decimal', value: orig ? v(orig.kcal) : '', placeholder: '0', 'aria-label': 'Calories' });
    F.energy = h('select', { 'aria-label': 'Energy unit', style: 'width:auto' }, h('option', { value: 'kcal', text: 'kcal' }), h('option', { value: 'kJ', text: 'kJ' }));
    ['protein', 'carbs', 'fat'].forEach((k) => mkIn(k, { inputmode: 'decimal', value: orig ? v(orig[k]) : '', placeholder: '0', 'aria-label': C.LABEL[k] + ' grams' }));
    mkIn('fiber', { inputmode: 'decimal', value: orig && orig.fiber != null ? v(orig.fiber) : '', placeholder: '—', 'aria-label': 'Fiber grams' });
    F.favorite = h('input', { type: 'checkbox' }); F.favorite.checked = !!(orig && orig.favorite);
    const msgs = {}; const msg = (k) => { msgs[k] = h('div', { class: 'lf-msg' }); return msgs[k]; };
    const quickBox = h('div', { class: 'quick-amounts' });
    const quickRows = [];
    let dirty = false;
    function addQuickRow(q) {
      const label = h('input', { type: 'text', placeholder: 'e.g. 1 scoop', value: q ? q.label : '', 'aria-label': 'Quick amount label', maxlength: '30', autocomplete: 'off' });
      const amt = h('input', { type: 'text', inputmode: 'decimal', class: 'mono', placeholder: '31', value: q ? C.fmt1(q.amount) : '', 'aria-label': 'Quick amount' });
      const row = h('div', { class: 'qa-row' }, label, amt, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove quick amount', style: 'width:32px;height:32px', onclick: () => { row.remove(); const i = quickRows.findIndex((r) => r.row === row); if (i >= 0) quickRows.splice(i, 1); dirty = true; } }, '×'));
      quickRows.push({ row, label, amt });
      quickBox.insertBefore(row, quickBox.lastChild);
      [label, amt].forEach((i) => i.addEventListener('input', () => { dirty = true; }));
      return row;
    }
    quickBox.appendChild(h('button', { class: 'link-btn small', type: 'button', onclick: () => { const r = addQuickRow(null); r.querySelector('input').focus(); } }, '+ add a quick amount (e.g. 1 scoop = 31 g)'));
    (orig ? orig.quick : []).forEach(addQuickRow);
    const gSpan = () => h('span', { class: 'unit', text: 'g' });
    const propBox = h('label', { class: 'check', hidden: true }, h('input', { type: 'checkbox' }), h('span'));
    const propInput = propBox.querySelector('input'), propText = propBox.querySelector('span');
    propInput.checked = true;
    const readInput = () => ({ name: F.name.value, brand: F.brand.value, unit: F.unit.value, basis: F.basis.value, kcal: F.kcal.value, energyUnit: F.energy.value, protein: F.protein.value, carbs: F.carbs.value, fat: F.fat.value, fiber: F.fiber.value, favorite: F.favorite.checked, quick: quickRows.map((r) => ({ label: r.label.value, amount: r.amt.value })) });
    const NUTR = ['basis', 'unit', 'kcal', 'protein', 'carbs', 'fat', 'fiber'];
    function nutritionChanged() {
      if (!editing) return false;
      const r = C.validateFood(readInput());
      if (!r.ok) return true;
      return NUTR.some((k) => r.food[k] !== orig[k]);
    }
    function refreshLive() {
      const e = C.parseEnergy(F.kcal.value);
      const p = C.parseNum(F.protein.value), c = C.parseNum(F.carbs.value), f = C.parseNum(F.fat.value);
      const m = msgs.kcal; m.className = 'lf-msg';
      const kj = F.energy.value === 'kJ';
      const kcalVal = e.ok ? (e.fromKj != null ? e.value : (kj ? C.kjToKcal(e.value) : e.value)) : null;
      if (e.ok && (e.fromKj != null || kj)) { m.textContent = 'from ' + C.fmt1(e.fromKj != null ? e.fromKj : e.value) + ' kJ = ' + C.fmt1(kcalVal) + ' kcal'; m.classList.add('ok'); }
      else if (p.ok && c.ok && f.ok) {
        const mk = Math.round(C.macroKcal(p.value, c.value, f.value));
        if (!F.kcal.value.trim()) { m.textContent = 'Macros add up to ' + mk + ' kcal — will be used if Calories stays blank'; m.classList.add('ok'); }
        else if (e.ok) { const chk = C.kcalCheck(kcalVal, p.value, c.value, f.value); if (chk.mismatch) { m.textContent = 'Check this — the macros add up to ' + mk + ' kcal, the label says ' + C.fmt1(kcalVal); m.classList.add('warn'); } else { m.textContent = 'Macros add up to ' + mk + ' kcal'; m.classList.add('ok'); } }
        else m.textContent = '';
      } else m.textContent = '';
      if (editing) {
        const n = T.entries(T.ui.todayKey).filter((en) => en.foodId === orig.id).length;
        const changed = nutritionChanged();
        propBox.hidden = !(changed && n > 0);
        if (!propBox.hidden) {
          const unitChanged = F.unit.value !== orig.unit;
          propInput.disabled = unitChanged;
          if (unitChanged) { propInput.checked = false; propText.textContent = "Today's " + n + ' entr' + (n === 1 ? 'y' : 'ies') + ' not updated — amounts were entered in ' + C.unitName(orig.unit); }
          else propText.textContent = "Also update today's " + n + ' entr' + (n === 1 ? 'y' : 'ies') + ' of this food (' + C.fmtDate(T.ui.todayKey, false) + ')';
        }
      }
    }
    ['name', 'brand', 'basis', 'kcal', 'protein', 'carbs', 'fat', 'fiber'].forEach((k) => F[k].addEventListener('input', () => { dirty = true; F[k].classList.remove('err'); if (msgs[k] && msgs[k].classList.contains('err')) { msgs[k].textContent = ''; msgs[k].className = 'lf-msg'; } refreshLive(); }));
    let prevUnit = F.unit.value;
    F.unit.addEventListener('change', () => {
      dirty = true;
      // Switching to pieces: a label is usually "per 1"; switching back: "per 100".
      const b = F.basis.value.trim();
      if (F.unit.value === 'pc' && prevUnit !== 'pc' && (b === '' || b === '100')) F.basis.value = '1';
      else if (F.unit.value !== 'pc' && prevUnit === 'pc' && (b === '' || b === '1')) F.basis.value = '100';
      prevUnit = F.unit.value;
      refreshLive();
    });
    F.energy.addEventListener('change', () => { dirty = true; refreshLive(); });
    F.favorite.addEventListener('change', () => { dirty = true; });
    const order = ['name', 'brand', 'basis', 'kcal', 'protein', 'carbs', 'fat', 'fiber'];
    order.forEach((k, i) => F[k].addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.isComposing) return;
      e.preventDefault();
      if (i < order.length - 1) { const nx = F[order[i + 1]]; nx.focus(); nx.select(); } else primary();
    }));
    const body = h('div', { class: 'label-form' },
      h('div', { class: 'lf-title' }, F.name), msg('name'),
      h('div', { class: 'lf-brand' }, F.brand),
      h('div', { class: 'lf-per' }, h('span', { text: 'Nutrition per' }), F.basis, F.unit), msg('basis'),
      h('div', { class: 'lf-kcal' }, h('span', { class: 'lf-k', text: 'Calories' }), h('div', { class: 'row', style: 'flex-wrap:nowrap;gap:6px' }, F.kcal, F.energy)), msg('kcal'),
      h('div', { class: 'lf-row' }, h('label', { text: 'Protein' }), h('div', { class: 'unit-input' }, F.protein, gSpan())), msg('protein'),
      h('div', { class: 'lf-row' }, h('label', { text: 'Carbs' }), h('div', { class: 'unit-input' }, F.carbs, gSpan())), msg('carbs'),
      h('div', { class: 'lf-row' }, h('label', { text: 'Fat' }), h('div', { class: 'unit-input' }, F.fat, gSpan())), msg('fat'),
      h('div', { class: 'lf-row' }, h('label', {}, 'Fiber ', h('span', { class: 'opt', text: 'optional — enter 0 when the label says 0' })), h('div', { class: 'unit-input' }, F.fiber, gSpan())), msg('fiber'),
      h('div', { class: 'lf-foot', text: 'Type the numbers exactly as printed on the label. For things you count (1 taco, 1 orange), choose pieces. Calories accepts kJ too (pick kJ, or type "502 kJ").' }));
    const extra = h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { text: 'Quick amounts' }), quickBox),
      h('label', { class: 'check' }, F.favorite, h('span', { text: 'Favorite (always shown in the chips row)' })),
      propBox);
    const mode = opts.fromSearch ? 'search' : (editing ? 'edit' : 'new');
    let dupWarned = false;
    function collect() {
      const r = C.validateFood(readInput());
      Object.keys(msgs).forEach((k) => { msgs[k].textContent = ''; msgs[k].className = 'lf-msg'; });
      Object.keys(r.errors).forEach((k) => { if (F[k]) F[k].classList.add('err'); if (msgs[k]) { msgs[k].textContent = r.errors[k]; msgs[k].className = 'lf-msg err'; } });
      if (!r.ok) { if (r.errors.unit) { F.unit.classList.add('err'); msgs.basis.textContent = r.errors.unit; msgs.basis.className = 'lf-msg err'; } const first = Object.keys(r.errors).find((k) => F[k]); if (first) F[first].focus(); return null; }
      if (r.warnings.dense) T.toast(r.warnings.dense);
      if (r.kcalComputed) T.toast('Calories computed from the macros: ' + C.fmtInt(r.food.kcal));
      return r.food;
    }
    function dupWarn(food) {
      const dup = Object.values(T.data.foods).find((f) => f.name.toLowerCase() === food.name.toLowerCase() && (!orig || f.id !== orig.id));
      if (dup && !dupWarned) { dupWarned = true; T.toast('You already have a food called ' + dup.name + (dup.brand ? ' (' + dup.brand + ')' : '') + ' — saved anyway'); }
    }
    function saveFood(food) {
      T.ui.lastBasis = String(food.basis); T.ui.lastUnit = food.unit;
      if (editing) {
        const cur = T.data.foods[orig.id] || orig;
        const nutrChanged = NUTR.some((k) => cur[k] !== food[k]);
        const f = Object.assign({}, cur, food, { id: orig.id, updatedAt: T.now(), createdAt: cur.createdAt || T.now() });
        const updateToday = nutrChanged && !propBox.hidden && propInput.checked && !propInput.disabled;
        T.batch(() => {
          T.setDoc('foods/' + f.id, f);
          if (updateToday) {
            const today = T.ui.todayKey;
            const affected = T.entries(today).filter((e) => e.foodId === f.id).map((e) => Object.assign({}, e, { name: f.name, brand: f.brand, basis: f.basis, unit: f.unit, n: { kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, fiber: f.fiber } }));
            if (affected.length) T.patch(C.dayPath(today), { entries: C.entriesPatch(affected), updatedAt: T.now() });
          }
        });
        dupWarn(f);
        return f;
      }
      const f = C.sanitizeFood(Object.assign({ id: T.newId('f_'), archived: false, useCount: 0, lastUsedAt: null, lastAmount: null, createdAt: T.now(), updatedAt: T.now() }, food));
      T.setDoc('foods/' + f.id, f);
      dupWarn(f);
      return f;
    }
    function primary() {
      const food = collect(); if (!food) return;
      const f = saveFood(food);
      dirty = false;
      if (mode === 'search') { T.closeModal(true); T.go('today'); T.pickFood(f); return; }
      if (mode === 'edit' || T.ui.touch) { T.closeModal(true); if (opts.onSaved) opts.onSaved(f); return; }
      T.toast('Saved ' + f.name + ' — ' + Object.keys(T.data.foods).length + ' foods');
      ['name', 'brand', 'kcal', 'protein', 'carbs', 'fat', 'fiber'].forEach((k) => { F[k].value = ''; });
      quickRows.splice(0).forEach((r) => r.row.remove());
      F.favorite.checked = false; F.energy.value = 'kcal'; dupWarned = false;
      refreshLive(); F.name.focus();
    }
    function saveClose() { const food = collect(); if (!food) return; const f = saveFood(food); dirty = false; T.closeModal(true); if (opts.onSaved) opts.onSaved(f); }
    function saveAnother() { const food = collect(); if (!food) return; const f = saveFood(food); dirty = false; T.toast('Saved ' + f.name); ['name', 'brand', 'kcal', 'protein', 'carbs', 'fat', 'fiber'].forEach((k) => { F[k].value = ''; }); quickRows.splice(0).forEach((r) => r.row.remove()); F.favorite.checked = false; F.energy.value = 'kcal'; dupWarned = false; refreshLive(); F.name.focus(); }
    const footer = [];
    if (mode === 'edit') {
      const refs = C.foodReferences(orig.id, T.data.days, T.data.meals);
      const referenced = refs.entries > 0 || refs.mealNames.length > 0 || (orig.useCount || 0) > 0 || !!orig.lastUsedAt;
      if (referenced) {
        footer.push(h('button', { class: 'btn btn-ghost', type: 'button', title: orig.archived ? 'Show this food again in search and chips' : 'Hide from search and chips; history keeps its numbers', onclick: () => { T.patch('foods/' + orig.id, { archived: !orig.archived, updatedAt: T.now() }); T.closeModal(true); T.toast(orig.archived ? 'Unarchived ' + orig.name : 'Archived ' + orig.name); } }, orig.archived ? 'Unarchive' : 'Archive'));
      } else {
        footer.push(h('button', { class: 'btn btn-ghost btn-danger', type: 'button', onclick: () => { if (!confirm('Delete ' + orig.name + '? It has never been logged and is not in any meal.')) return; T.del('foods/' + orig.id); T.closeModal(true); T.toast('Deleted ' + orig.name); } }, 'Delete'));
      }
      footer.push(h('span', { class: 'spacer' }));
      footer.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'));
      footer.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: primary }, 'Save'));
    } else if (mode === 'search') {
      footer.push(h('span', { class: 'spacer' }));
      footer.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'));
      footer.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: primary }, 'Save'));
    } else if (T.ui.touch) {
      footer.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'));
      footer.push(h('span', { class: 'spacer' }));
      footer.push(h('button', { class: 'btn', type: 'button', onclick: saveAnother }, 'Save & add another'));
      footer.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: saveClose }, 'Save'));
    } else {
      footer.push(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'));
      footer.push(h('span', { class: 'spacer' }));
      footer.push(h('button', { class: 'btn', type: 'button', onclick: saveClose }, 'Save & close'));
      footer.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: primary }, 'Save & add another'));
    }
    T.openModal({
      title: mode === 'edit' ? 'Edit food' : (opts.isCopy ? 'Duplicate food' : 'New food'),
      body: h('div', { class: 'stack' }, body, extra), footer, onPrimary: primary,
      guard: () => !dirty || confirm('Discard changes?'),
      focus: opts.name ? '[aria-label="Brand"]' : '[aria-label="Name"]',
    });
    refreshLive();
  }
  T.hooks.newFood = (o) => openFoodForm(o || {});
  T.openFoodForm = openFoodForm;

  // ------------------------------------------------------------- Meals
  function mealTotals(m) { return C.dayTotals(C.expandMeal(m, T.data.foods, '', () => 'x').entries); }
  function renderMealList(box, q) {
    let meals = Object.values(T.data.meals);
    if (q) meals = C.rankItems(q, meals.map((m) => ({ type: 'meal', meal: m })), T.use30()).map((it) => it.meal);
    else meals.sort((a, b) => a.name.localeCompare(b.name));
    if (!meals.length) { box.appendChild(h('div', { class: 'empty' }, h('div', { text: q ? 'No meals match' : 'No saved meals yet.' }), h('div', { class: 'small', text: 'On Today, log the foods you eat together, then use "Save as meal…" under the list. A meal adds all its foods with one tap.' }))); return; }
    meals.forEach((m) => {
      const t = mealTotals(m);
      box.appendChild(h('div', { class: 'food-row', onclick: () => openMeal(m) },
        h('span', { class: 'star', style: 'cursor:default', 'aria-hidden': 'true', text: '≡' }),
        h('button', { class: 'fname', type: 'button', onclick: (e) => { e.stopPropagation(); openMeal(m); } }, m.name),
        h('div', { class: 'factions' }, h('span', { class: 'fused', text: m.useCount ? 'used ' + m.useCount + '×' : '' })),
        h('div', { class: 'fmeta', text: m.items.length + ' item' + (m.items.length === 1 ? '' : 's') + ' · ' + C.fmtInt(t.kcal) + ' kcal · ' + C.fmt1(t.protein) + ' P · ' + C.fmt1(t.carbs) + ' C · ' + C.fmt1(t.fat) + ' F' })));
    });
  }
  function openMeal(m) {
    if (!T.canWrite()) return;
    const name = h('input', { type: 'text', value: m.name, maxlength: '60', 'aria-label': 'Meal name', autocomplete: 'off', autocapitalize: 'words' });
    const items = h('div', { class: 'stack', style: 'gap:4px' }, m.items.map((it) => { const f = T.data.foods[it.foodId]; return h('div', { class: 'row small' }, h('span', { class: 'grow', text: f ? f.name + (f.archived ? ' (archived)' : '') : 'Missing food' }), h('span', { class: 'mono muted', text: C.fmt1(it.amount) + ' ' + (f ? C.unitLabel(f.unit) : '') })); }));
    const todayItems = T.entries(T.ui.todayKey).filter((e) => e.foodId).map((e) => ({ foodId: e.foodId, amount: e.amount }));
    const save = () => { const n = name.value.trim(); if (!n) { name.classList.add('err'); name.focus(); return; } T.setDoc('meals/' + m.id, Object.assign({}, m, { name: n.slice(0, 60), updatedAt: T.now() })); T.closeModal(true); };
    const replace = () => {
      if (!confirm('Replace the items of ' + m.name + ' with the ' + todayItems.length + ' foods logged today?')) return;
      const prev = m.items;
      T.setDoc('meals/' + m.id, Object.assign({}, m, { items: todayItems, updatedAt: T.now() }));
      T.closeModal(true);
      T.toast('Updated ' + m.name, { undo: () => { const cur = T.data.meals[m.id]; if (cur) T.setDoc('meals/' + m.id, Object.assign({}, cur, { items: prev, updatedAt: T.now() })); } });
    };
    T.openModal({
      title: 'Meal', onPrimary: save,
      body: h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', { text: 'Name' }), name), h('div', { class: 'field' }, h('label', { text: 'Items' }), items),
        todayItems.length ? h('button', { class: 'btn btn-sm', type: 'button', onclick: replace }, "Replace items with today's " + todayItems.length + ' foods') : h('div', { class: 'tiny muted', text: 'To change the items: log them on Today, then open this meal and replace its items. (Nothing is logged today yet.)' })),
      footer: [
        h('button', { class: 'btn btn-ghost btn-danger', type: 'button', onclick: () => { if (!confirm('Delete meal ' + m.name + '?')) return; T.del('meals/' + m.id); T.closeModal(true); } }, 'Delete'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, 'Save')],
    });
  }
  T.hooks.saveAsMeal = function (date) {
    if (!T.canCreate()) { T.toast(T.canWrite() ? 'The database is full — free some space first' : 'Read-only right now'); return; }
    const entries = T.entries(date).slice();
    if (!entries.length) return;
    const boxes = [];
    const list = h('div', { class: 'stack', style: 'gap:6px' }, entries.map((e) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = !!e.foodId; cb.disabled = !e.foodId; boxes.push({ cb, e });
      return h('label', { class: 'check' }, cb, h('span', { text: e.name + ' · ' + C.fmt1(e.amount) + ' ' + (e.unit === 'serving' ? "(quick entries can't be saved)" : C.unitLabel(e.unit)) }));
    }));
    const name = h('input', { type: 'text', placeholder: 'e.g. Morning shake', maxlength: '60', 'aria-label': 'Meal name', autocomplete: 'off', autocapitalize: 'words' });
    const save = () => {
      const n = name.value.trim();
      if (!n) { name.classList.add('err'); name.focus(); return; }
      const items = boxes.filter((b) => b.cb.checked && b.e.foodId).map((b) => ({ foodId: b.e.foodId, amount: b.e.amount }));
      if (!items.length) { T.toast('Pick at least one food'); return; }
      const m = { id: T.newId('m_'), name: n.slice(0, 60), items, useCount: 0, lastUsedAt: null, createdAt: T.now(), updatedAt: T.now() };
      T.setDoc('meals/' + m.id, m); T.closeModal(true); T.toast('Saved meal ' + m.name);
    };
    T.openModal({ title: 'Save as meal', onPrimary: save, body: h('div', { class: 'stack' }, list, h('div', { class: 'field' }, h('label', { text: 'Meal name' }), name)), focus: '[aria-label="Meal name"]',
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, 'Save meal')] });
  };

  // ============================================================== Progress
  const P = { charts: {}, bound: false, loadingAll: false };
  function bindProgress() {
    if (P.bound) return; P.bound = true;
    const rng = $('range');
    C.RANGES.forEach((r) => rng.appendChild(h('button', { type: 'button', text: r, dataset: { r }, onclick: () => { T.setGraphRange(r); T.renderers.progress(); } })));
    const met = $('intake-metric');
    [['kcal', 'Calories'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].forEach(([k, l]) => met.appendChild(h('button', { type: 'button', text: l, dataset: { m: k }, onclick: () => { T.ui.intakeMetric = k; T.renderers.progress(); } })));
  }
  function firstKey() {
    const w = Object.keys(T.data.weights).sort()[0];
    const d = Object.keys(T.data.days).filter((k) => C.isLogged(T.data.days[k])).sort()[0];
    if (w && d) return w < d ? w : d;
    return w || d || null;
  }
  T.renderers.progress = function () {
    bindProgress();
    const range = T.ui.graphRange;
    $('range').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.r === range));
    $('intake-metric').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === T.ui.intakeMetric));
    const unit = T.settings().weightUnit;
    $('unit-label').textContent = unit === 'kg' ? 'kilograms' : 'pounds';
    if (!T.baseReady() && !T.data.app) { clear($('stats')).appendChild(h('div', { class: 'loading', text: 'Loading…' })); return; }
    if (range === 'All' && !P.loadingAll) { P.loadingAll = true; T.loadAllYears().catch(() => T.toast("Couldn't load older years")); }
    const today = T.ui.todayKey;
    const series = C.weightSeries(T.data.weights, unit);
    const trend = C.trend(series);
    const rs = C.rangeStart(range, today, firstKey());
    renderStats(series, trend, rs.start, unit);
    const kcalByDate = {}, sevenByDate = {};
    Object.keys(T.data.days).forEach((k) => { const es = T.entries(k); if (es.length) kcalByDate[k] = C.dayTotals(es).kcal; });
    series.forEach((p) => { sevenByDate[p.date] = C.sevenDayAvg(series, p.date); });
    const gw = T.settings().goalWeight;
    const goal = gw ? C.toUnit(gw.value, gw.unit, unit) : null;
    const wOpts = { series, trend, unit, start: rs.start, n: rs.n, today, goal, kcalByDate, sevenDayAvgByDate: sevenByDate, onSelect: (date) => { T.ui.selectedWeightDate = date; renderWeightTable(series, trend, unit, true); } };
    if (root.TareCharts) {
      if (!P.charts.weight) P.charts.weight = root.TareCharts.weightChart($('weight-chart'), wOpts); else P.charts.weight.update(wOpts);
      const metric = T.ui.intakeMetric;
      const values = {};
      Object.keys(kcalByDate).forEach((k) => { if (k >= rs.start && k <= today) values[k] = C.dayTotals(T.entries(k))[metric]; });
      const iOpts = { values, metric, unitLabel: metric === 'kcal' ? 'kcal' : 'g', start: rs.start, n: rs.n, today,
        targetFor: (date) => { const tg = T.targetFor(date); return tg && tg[metric] != null ? tg[metric] : null; },
        status: (date, value, target) => { if (target == null) return null; if (metric === 'kcal' && value > target) return 'over'; if (metric === 'protein' && value >= target) return 'met'; return null; },
        onSelect: (date) => T.setDate(date) };
      if (!P.charts.intake) P.charts.intake = root.TareCharts.intakeChart($('intake-chart'), iOpts); else P.charts.intake.update(iOpts);
    }
    renderWeekly(series, trend, rs.start, today);
    renderWeightTable(series, trend, unit, false);
  };
  function renderStats(series, trend, start, unit) {
    const box = clear($('stats'));
    const n = series.length;
    const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'eyebrow', text: label }), h('div', { class: 'stat-v num', text: value }), h('div', { class: 'stat-s', text: sub || '' }));
    if (!n) { box.appendChild(stat('Latest', '—', 'no weigh-ins yet')); return; }
    const last = series[n - 1];
    box.appendChild(stat('Latest', C.fmt1(last.v) + ' ' + unit, C.fmtDate(last.date, false)));
    box.appendChild(stat('Trend', C.fmt1(trend[n - 1]) + ' ' + unit, 'smoothed'));
    const avg = C.sevenDayAvg(series, last.date);
    box.appendChild(stat('7-day avg', avg == null ? '—' : C.fmt1(avg) + ' ' + unit, 'as of ' + C.fmtDate(last.date, false)));
    const ch = C.changeOverRange(series, trend, start);
    box.appendChild(stat('Change', ch ? C.fmtSigned(ch.change, 1) + ' ' + unit : '—', ch && ch.perWeek != null ? '(' + C.fmtSigned(ch.perWeek) + '/wk) over ' + ch.days + ' days' : 'over the range'));
    const rate = C.ratePerWeek(series, trend);
    box.appendChild(stat('Rate', rate == null ? '—' : C.fmtSigned(rate) + '/wk', unit + ' · trend, ~4 weeks'));
  }
  function renderWeekly(series, trend, start, today) {
    const box = clear($('weekly'));
    const rows = C.weeklyRows(T.data.days, series, trend, start, today, 52);
    if (!rows.length) { box.appendChild(h('div', { class: 'empty', text: 'Nothing logged in this range' })); return; }
    const table = h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Week', 'Logged', 'Avg kcal', 'Avg P', 'Avg C', 'Avg F', 'Avg weight', 'Trend Δ'].map((t) => h('th', { text: t })))));
    const tb = h('tbody');
    rows.forEach((r) => tb.appendChild(h('tr', { class: 'click', onclick: () => T.setDate(r.week > today ? today : r.week) },
      h('td', { text: 'Mon ' + C.fmtMonthDay(r.week) }), h('td', { text: r.logged + '/7' }), h('td', { text: C.fmtInt(r.avgKcal) }), h('td', { text: C.fmtInt(r.avgProtein) }), h('td', { text: C.fmtInt(r.avgCarbs) }), h('td', { text: C.fmtInt(r.avgFat) }),
      h('td', { text: r.avgWeight == null ? '—' : C.fmt1(r.avgWeight) }), h('td', { text: r.trendChange == null ? '—' : C.fmtSigned(r.trendChange) }))));
    table.appendChild(tb);
    box.appendChild(table);
  }
  function renderWeightTable(series, trend, unit, scrollToSel) {
    // Never rebuild the table under a value being typed; re-render once focus leaves it.
    const wrap = $('weight-table');
    const act = document.activeElement;
    if (!scrollToSel && act && act.tagName === 'INPUT' && wrap.contains(act)) { P.weightDirty = true; return; }
    P.weightDirty = false;
    const box = clear($('weight-table'));
    const canWrite = T.canWrite();
    const table = h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Date', 'Weight', 'Trend', 'vs previous', ''].map((t) => h('th', { text: t })))));
    const tb = h('tbody');
    if (canWrite) {
      const di = h('input', { type: 'date', max: T.ui.todayKey, min: C.MIN_KEY, style: 'width:150px;font-family:var(--font-ui)', 'aria-label': 'Date' });
      const vi = h('input', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', placeholder: unit, 'aria-label': 'Weight' });
      const add = () => {
        const d = di.value, r = C.parseNum(vi.value);
        if (!C.isKey(d) || d > T.ui.todayKey) { di.focus(); return; }
        if (!r.ok) { vi.classList.add('err'); vi.focus(); return; }
        const prevKeys = Object.keys(T.data.weights).filter((k) => k < d).sort();
        const prev = prevKeys.length ? T.data.weights[prevKeys[prevKeys.length - 1]] : null;
        const chk = C.checkWeight(r.value, unit, prev);
        if (!chk.ok) { T.toast(chk.error); vi.classList.add('err'); return; }
        const old = T.data.weights[d] || null;
        T.saveWeighIn(d, { v: chk.value, u: unit, at: T.now() });
        T.toast((old ? 'Replaced' : 'Added') + ' weigh-in for ' + C.fmtDate(d, false) + (chk.warning ? ' — ' + chk.warning : ''), { undo: () => { if (old) T.saveWeighIn(d, old); else T.removeWeighIn(d); } });
      };
      vi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      tb.appendChild(h('tr', {}, h('td', {}, di), h('td', {}, vi), h('td', { text: '' }), h('td', { text: '' }), h('td', {}, h('button', { class: 'btn btn-sm', type: 'button', onclick: add }, 'Add'))));
    }
    const rows = series.slice().reverse();
    const shown = rows.slice(0, T.ui.weightRows);
    shown.forEach((p, i) => {
      const idx = series.length - 1 - i;
      const prev = idx > 0 ? series[idx - 1] : null;
      const inp = h('input', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', value: C.fmt1(p.v), 'aria-label': 'Weight on ' + p.date, disabled: !canWrite });
      let startVal = null;
      inp.addEventListener('focus', () => { startVal = inp.value; requestAnimationFrame(() => { try { inp.setSelectionRange(0, inp.value.length); } catch (e) { /* ignore */ } }); });
      const commit = () => {
        if (T.ui.rendering || !inp.isConnected) return;
        const r = C.parseNum(inp.value);
        if (!r.ok || C.round1(r.value) === C.round1(p.v)) { inp.value = C.fmt1(p.v); return; }
        const chk = C.checkWeight(r.value, unit, prev ? prev.raw : null);
        if (!chk.ok) { T.toast(chk.error); inp.value = C.fmt1(p.v); return; }
        const old = T.data.weights[p.date];
        T.saveWeighIn(p.date, { v: chk.value, u: unit, at: T.now() });
        T.toast(C.fmt1(p.v) + ' → ' + C.fmt1(chk.value) + ' ' + unit, { undo: () => { if (old) T.saveWeighIn(p.date, old); } });
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } else if (e.key === 'Escape') { inp.value = startVal != null ? startVal : C.fmt1(p.v); inp.blur(); } });
      inp.addEventListener('blur', () => setTimeout(() => { commit(); if (P.weightDirty && !$('weight-table').contains(document.activeElement)) T.renderers.progress(); }, 0));
      const tr = h('tr', { class: T.ui.selectedWeightDate === p.date ? 'sel' : '', dataset: { date: p.date } },
        h('td', {}, h('button', { class: 'link-btn', type: 'button', style: 'font-weight:400;color:var(--ink)', onclick: () => T.setDate(p.date) }, C.fmtDate(p.date))),
        h('td', {}, inp),
        h('td', { text: C.fmt1(trend[idx]) }),
        h('td', { text: prev ? C.fmtSigned(p.v - prev.v, 1) : '—' }),
        h('td', {}, canWrite ? h('button', { class: 'x', type: 'button', 'aria-label': 'Remove weigh-in', onclick: () => { const old = T.data.weights[p.date]; T.removeWeighIn(p.date); T.toast('Removed weigh-in for ' + C.fmtDate(p.date, false), { undo: () => { if (old) T.saveWeighIn(p.date, old); } }); } }, '×') : null));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.appendChild(table);
    if (rows.length > shown.length) box.appendChild(h('button', { class: 'btn btn-sm show-more', type: 'button', onclick: () => { T.ui.weightRows += 60; renderWeightTable(series, trend, unit, false); } }, 'Show more (' + (rows.length - shown.length) + ' older)'));
    if (scrollToSel && T.ui.selectedWeightDate) {
      const tr = tb.querySelector('tr[data-date="' + T.ui.selectedWeightDate + '"]');
      if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      else { const i = rows.findIndex((p) => p.date === T.ui.selectedWeightDate); if (i >= T.ui.weightRows) { T.ui.weightRows = i + 10; renderWeightTable(series, trend, unit, true); } }
    }
  }

  // ============================================================== Settings
  T.renderers.settings = function (force) {
    const box = $('settings-root');
    if (!force && box.contains(document.activeElement) && document.activeElement !== document.body) return;
    clear(box);
    if (!T.baseReady() || !T.data.app) { box.appendChild(h('div', { class: 'loading', text: T.data.app ? 'Loading…' : 'Set up Tare on the Today tab first' })); return; }
    box.appendChild(targetsCard());
    box.appendChild(unitsCard());
    box.appendChild(backupCard());
    box.appendChild(dataCard());
    box.appendChild(helpCard());
    box.appendChild(dangerCard());
  };
  function targetsCard() {
    const app = T.data.app;
    const cur = C.targetFor(app.targets, T.ui.todayKey) || {};
    const F = {};
    const mk = (k, label, ph) => { F[k] = h('input', { type: 'text', inputmode: 'decimal', class: 'mono', value: cur[k] == null ? '' : String(cur[k]), placeholder: ph || '—', 'aria-label': label }); return h('div', { class: 'field' }, h('label', { text: label }), F[k]); };
    F.from = h('input', { type: 'date', value: T.ui.todayKey, max: T.ui.todayKey, min: C.MIN_KEY, 'aria-label': 'Effective from' });
    const line = h('div', { class: 'targets-line' });
    const refresh = () => { const p = C.parseNum(F.protein.value), c = C.parseNum(F.carbs.value), f = C.parseNum(F.fat.value); line.textContent = (p.ok || c.ok || f.ok) ? C.targetsLine(p.ok ? p.value : 0, c.ok ? c.value : 0, f.ok ? f.value : 0) : ''; };
    const msg = h('div', { class: 'err-msg small crit' });
    const save = () => {
      if (!T.canWrite()) return;
      const r = C.validateTargets({ from: F.from.value, kcal: F.kcal.value, protein: F.protein.value, carbs: F.carbs.value, fat: F.fat.value, fiber: F.fiber.value });
      if (!r.ok) { msg.textContent = Object.values(r.errors)[0]; return; }
      const t = r.target;
      T.patchApp({ targets: { [t.from]: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, fiber: t.fiber } }, updatedAt: T.now() });
      T.toast('Targets saved from ' + C.fmtDate(t.from, false));
      T.renderers.settings(true);
    };
    const card = h('div', { class: 'card' },
      h('h2', {}, 'Daily targets', h('span', { class: 'tiny muted', text: 'blank = no target' })),
      h('div', { class: 'fields' }, mk('kcal', 'Calories', '2400'), mk('protein', 'Protein g', '180'), mk('carbs', 'Carbs g', '250'), mk('fat', 'Fat g', '80'), mk('fiber', 'Fiber g', '30')),
      line,
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { text: 'Effective from' }), F.from), h('span', { class: 'grow' }), h('button', { class: 'btn btn-primary', type: 'button', disabled: !T.canWrite(), onclick: save }, 'Save targets')),
      msg);
    ['kcal', 'protein', 'carbs', 'fat', 'fiber'].forEach((k) => { F[k].addEventListener('input', refresh); F[k].addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }); });
    refresh();
    const list = C.targetsList(app.targets);
    if (list.length) {
      const det = h('details', {}, h('summary', { text: 'Targets history (' + list.length + ')' }));
      const tb = h('tbody');
      list.slice().reverse().forEach((t) => tb.appendChild(h('tr', {},
        h('td', { text: C.fmtDate(t.from) }), h('td', { text: t.kcal == null ? '—' : C.fmtInt(t.kcal) }), h('td', { text: t.protein == null ? '—' : C.fmt1(t.protein) }), h('td', { text: t.carbs == null ? '—' : C.fmt1(t.carbs) }), h('td', { text: t.fat == null ? '—' : C.fmt1(t.fat) }), h('td', { text: t.fiber == null ? '—' : C.fmt1(t.fiber) }),
        h('td', {}, h('button', { class: 'x', type: 'button', 'aria-label': 'Delete', onclick: () => { T.patchApp({ targets: { [t.from]: null }, updatedAt: T.now() }); T.renderers.settings(true); } }, '×')))));
      det.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['From', 'kcal', 'P', 'C', 'F', 'Fib', ''].map((x) => h('th', { text: x })))), tb)));
      card.appendChild(det);
    }
    return card;
  }
  function unitsCard() {
    const s = T.data.app.settings;
    const seg = h('div', { class: 'seg' }, ['lb', 'kg'].map((u) => h('button', { type: 'button', class: s.weightUnit === u ? 'on' : '', text: u, onclick: () => { T.patchApp({ settings: { weightUnit: u }, updatedAt: T.now() }); T.renderers.settings(true); } })));
    const goal = h('input', { type: 'text', inputmode: 'decimal', class: 'mono', placeholder: '—', value: s.goalWeight ? C.fmt1(C.toUnit(s.goalWeight.value, s.goalWeight.unit, s.weightUnit)) : '', 'aria-label': 'Goal weight' });
    const saveGoal = () => {
      const r = C.parseNum(goal.value);
      let gw;
      if (r.empty) gw = null; else if (r.ok && r.value > 0) gw = { value: C.round1(r.value), unit: s.weightUnit }; else { goal.classList.add('err'); return; }
      T.patchApp({ settings: { goalWeight: gw }, updatedAt: T.now() });
      T.toast(gw ? 'Goal weight saved' : 'Goal weight cleared'); T.renderers.settings(true);
    };
    goal.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveGoal(); } });
    const wf = h('input', { type: 'checkbox' }); wf.checked = s.weightFirst;
    wf.addEventListener('change', () => T.patchApp({ settings: { weightFirst: wf.checked }, updatedAt: T.now() }));
    return h('div', { class: 'card' },
      h('h2', { text: 'Weight' }),
      h('div', { class: 'row' }, h('span', { class: 'small', text: 'Unit' }), seg, h('span', { class: 'tiny muted', text: 'each weigh-in keeps the unit it was typed in; switching only changes the display' })),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { text: 'Goal weight (' + s.weightUnit + ')' }), h('div', { class: 'row' }, goal, h('button', { class: 'btn btn-sm', type: 'button', onclick: saveGoal }, 'Save'))), h('span', { class: 'tiny muted', text: 'drawn as a dashed line on the chart' })),
      h('label', { class: 'check' }, wf, h('span', { text: 'Put the cursor in the weigh-in box first each morning (desktop)' })));
  }
  // Import stays available in a read-only "newer version" state so a bad restore can always be undone.
  function canImport() { return !!T.queue && T.baseReady() && !T.ui.readonlyCode && !T.ui.remoteErased && !T.ui.importing && !T.queue.blockedCount; }
  function exportAvailable() { return !!T.downloads || (!T.framed && T.mode !== 'db'); }
  function backupCard() {
    const app = T.data.app;
    const status = h('div', { class: 'small ink2', text: 'Last backup: ' + C.timeAgo(app.lastBackupAt) });
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', 'aria-label': 'Backup file' });
    fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; if (f) importFile(f); fileInput.value = ''; });
    const exportBtn = h('button', { class: 'btn', type: 'button', disabled: B.exporting, onclick: () => exportBackup(status) }, 'Export backup');
    return h('div', { class: 'card' },
      h('h2', { text: 'Backup' }),
      h('p', { class: 'small ink2', text: T.mode === 'db' ? 'Your data lives in your Claude account. A backup file is your own copy: keep one somewhere safe about once a month, and use it to restore everything on any copy of Tare.' : 'Local mode: the browser is the only copy of your data. Export a backup regularly.' }),
      status,
      h('div', { class: 'row' },
        exportAvailable() ? exportBtn : h('span', { class: 'small muted', text: "Backups aren't available in this view — open Tare in the Claude app or on claude.ai." }),
        h('button', { class: 'btn', type: 'button', disabled: !canImport(), onclick: () => fileInput.click() }, 'Import backup…'), fileInput));
  }
  function dataCard() {
    const days = Object.keys(T.data.days).length;
    const years = T.allYears();
    const unloaded = years.filter((y) => !T.years.loaded[y]).length;
    const docs = Object.keys(T.data.foods).length + Object.keys(T.data.meals).length + Object.keys(T.snap.weights).length + 1 + days;
    let unread = 0;
    Object.keys(T.data.days).forEach((k) => { unread += C.unreadableEntries(T.data.days[k]); });
    const cls = docs >= 4900 ? 'crit' : docs >= 4500 ? 'warn' : '';
    return h('div', { class: 'card' },
      h('h2', { text: 'Data' }),
      h('div', { class: 'small ' + cls, text: 'Documents: ' + (unloaded ? 'at least ' : '') + docs.toLocaleString('en-US') + ' of ' + C.DOC_CAP.toLocaleString('en-US') + ' (one per food, meal, weigh-in year and logged day)' + (unloaded ? ' — ' + unloaded + ' older year' + (unloaded > 1 ? 's' : '') + ' not counted until opened' : '') }),
      unread ? h('div', { class: 'small warn', text: 'Unreadable entries: ' + unread + ' (kept in place, not counted in totals)' }) : null,
      Object.keys(T.ui.unreadable).length ? h('div', { class: 'stack', style: 'gap:6px' },
        h('div', { class: 'small warn', text: 'Unreadable records — they are not shown and nothing can be saved into them:' }),
        Object.keys(T.ui.unreadable).map((path) => h('div', { class: 'row small' },
          h('span', { class: 'mono grow', text: path }),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { const t = JSON.stringify(T.ui.unreadable[path], null, 2); if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => T.toast('Copied'), () => T.toast("Couldn't copy")); } }, 'Copy JSON'),
          h('button', { class: 'btn btn-sm btn-danger', type: 'button', disabled: !T.canWrite(), onclick: () => { if (confirm('Delete ' + path + '? This cannot be undone.')) { T.del(path); T.renderers.settings(true); } } }, 'Delete')))) : null,
      h('details', {}, h('summary', { text: 'Data format (for you or a future Claude session)' }),
        h('div', { class: 'help' },
          h('p', { class: 'mono tiny', text: 'meta/app { schemaVersion, firstYear, settings{weightUnit,goalWeight,weightFirst}, targets{ "YYYY-MM-DD": {kcal,protein,carbs,fat,fiber}|null } }' }),
          h('p', { class: 'mono tiny', text: 'weights/YYYY { year, byDate{ "YYYY-MM-DD": {v,u,at}|null } }' }),
          h('p', { class: 'mono tiny', text: 'foods/ID { id,name,brand,unit(g|ml|pc),basis,kcal,protein,carbs,fat,fiber|null,quick[],favorite,archived,useCount,lastUsedAt,lastAmount }' }),
          h('p', { class: 'mono tiny', text: 'meals/ID { id,name,items[{foodId,amount}],useCount }' }),
          h('p', { class: 'mono tiny', text: 'years/YYYY/days/YYYY-MM-DD { date, entries{ ID: {id,foodId|null,name,brand,amount>0,unit(g|ml|pc|serving),basis,n{kcal,protein,carbs,fat,fiber|null},mealId|null,at}|null } } — a day up to MAX_FUTURE_DAYS ahead of today is a planned day, same shape' }),
          h('p', { class: 'tiny muted', text: 'null = removed. Nutrition values are per "basis" g/ml exactly as printed on the label. Keep firstYear equal to the earliest year that has a day document.' }))));
  }
  function helpCard() {
    const p = (t) => h('p', { text: t });
    return h('div', { class: 'card' },
      h('h2', { text: 'Help' }),
      h('div', { class: 'help' },
        h('h3', { text: 'Where your data lives' }),
        p(T.mode === 'db' ? 'In your Claude account, private to you, and synced live to every device where you open this page. You can also ask Claude to analyse or bulk-edit it in a later session (tell it to keep the shapes shown under Data).' : 'In this browser only (local mode).'),
        p('Storage holds up to 5,000 documents: one per food, one per meal, one per logged day and one per year of weigh-ins — about 12 years of daily logging. Other database pages in your account share an organisation-wide limit.'),
        h('h3', { text: 'Logging' }),
        p('Type a few letters, press Enter, type the grams (or ml) off the scale, press Enter. For things you count, save the food "per 1 piece" and log 2 for two tacos. Repeat foods remember the amount you used last time. The amount box does arithmetic: "412-187" is bowl minus tare, "454/2" is half a pack.'),
        p('Each entry keeps a copy of the label numbers at the time you logged it, so editing a food later never changes your history — except today\'s entries, if you tick the box when you fix a typo. Logging becomes available once your data has finished loading.'),
        p('Enter 0 when a label says 0 g fiber; leave it blank when the label doesn\'t list it. Row values are rounded for display, so they can differ from the total by 1 kcal or 0.1 g.'),
        h('h3', { text: 'Planning ahead' }),
        p('The › button and the date picker go up to ' + C.MAX_FUTURE_DAYS + ' days ahead, so you can log tomorrow\'s meal-prepped breakfast tonight. An empty future day offers "Copy today" to repeat what you already logged. Weight can only be logged for today or earlier.'),
        h('h3', { text: 'Two devices' }),
        p('Logging on both devices at the same time is safe, even after a lost connection. Only changing the very same row on both devices at the same moment keeps one of the two edits. If Tare says it can\'t reach your data, reload and allow access when asked; nothing typed under that banner is saved.'),
        h('h3', { text: 'Phone' }),
        p('Open this same link on your phone and use "Add to Home Screen". The Add button commits an amount because the number pad has no Return key. kJ-only label? Pick kJ next to Calories.'),
        h('h3', { text: 'Backups' }),
        p('Export a backup about once a month; the file restores everything on any copy of Tare. Check that the file exists after your first export. An interrupted restore is safe to repeat.'),
        h('h3', { text: 'Keyboard shortcuts' }),
        h('p', {}, h('kbd', { text: '/' }), ' search · ', h('kbd', { text: 'Enter' }), ' pick / log · ', h('kbd', { text: 'Tab' }), ' log and edit the row · ', h('kbd', { text: 'Esc' }), ' back out · ', h('kbd', { text: 'Alt' }), '+', h('kbd', { text: '←' }), '/', h('kbd', { text: '→' }), ' previous / next day · ', h('kbd', { text: 'Alt' }), '+', h('kbd', { text: 'T' }), ' today · ', h('kbd', { text: 'Ctrl' }), '+', h('kbd', { text: 'Z' }), ' undo · ', h('kbd', { text: 'N' }), ' new food (on Foods)'),
        h('p', { class: 'tiny muted', text: 'Tare v1 · data schema ' + C.SCHEMA + ' · ' + (T.mode === 'db' ? 'synced' : 'local') })));
  }
  function dangerCard() {
    return h('div', { class: 'card danger' },
      h('h2', { text: 'Danger zone' }),
      h('p', { class: 'small ink2', text: 'Erase deletes every food, meal, weigh-in and logged day from your account. A backup is saved first. Close Tare on your other device before erasing.' }),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-danger', type: 'button', disabled: !T.canWrite() || !exportAvailable(), onclick: eraseAll }, 'Erase all data…')));
  }

  // ------------------------------------------------------------ backup I/O
  const B = { exporting: false };
  function overlayRaw(path, base) { return T.queue ? T.queue.overlay(path, base) : base; }
  // Full enumeration of the store (mirror + overlay), loading every year first.
  async function enumerateDocs() {
    await T.loadAllYears();
    const docs = {};
    docs[C.PATHS.app] = overlayRaw(C.PATHS.app, T.snap.app || null);
    Object.keys(T.snap.weights).forEach((y) => { const b = overlayRaw(C.weightsPath(y), T.snap.weights[y]); if (b) docs[C.weightsPath(y)] = b; });
    Object.keys(T.snap.foods).forEach((id) => { const b = overlayRaw('foods/' + id, T.snap.foods[id]); if (b) docs['foods/' + id] = b; });
    Object.keys(T.snap.meals).forEach((id) => { const b = overlayRaw('meals/' + id, T.snap.meals[id]); if (b) docs['meals/' + id] = b; });
    Object.keys(T.snap.days).forEach((k) => { const b = overlayRaw(C.dayPath(k), T.snap.days[k]); if (b) docs[C.dayPath(k)] = b; });
    (T.queue ? T.queue.pendingPaths() : new Set()).forEach((p) => { if (!(p in docs)) { const b = overlayRaw(p, null); if (b) docs[p] = b; } });
    return docs;
  }
  async function exportBackup(statusEl) {
    if (B.exporting) return { ok: false };
    B.exporting = true;
    try {
      let docs;
      try { docs = await enumerateDocs(); } catch (e) { T.toast("Couldn't read all your data — backup not written"); return { ok: false }; }
      const exportedAt = T.now();
      const backup = C.buildBackup(docs, exportedAt);
      const counts = { foods: 0, meals: 0, days: 0, weights: 0 };
      Object.keys(backup.docs).forEach((p) => { if (C.PATH_RE.food.test(p)) counts.foods++; else if (C.PATH_RE.meal.test(p)) counts.meals++; else if (C.PATH_RE.day.test(p)) counts.days++; else if (C.PATH_RE.weights.test(p)) counts.weights += Object.keys(backup.docs[p].byDate).length; });
      const filename = 'tare-backup-' + exportedAt.slice(0, 10) + '.json';
      const text = JSON.stringify(backup, null, 2);
      const done = () => { if (T.data.app) T.patchApp({ lastBackupAt: exportedAt }); if (statusEl) statusEl.textContent = 'Last backup: today'; T.toast('Backup saved: ' + counts.foods + ' foods, ' + counts.meals + ' meals, ' + counts.days + ' days, ' + counts.weights + ' weigh-ins'); };
      if (T.downloads) {
        try { const r = await T.downloads.save({ filename, data: text }); if (r && r.status === 'saved') { done(); return { ok: true }; } return { ok: false }; }
        catch (e) {
          const code = e && e.code;
          if (code === 'declined') return { ok: false, declined: true };
          if (code === 'rate_limited') { T.toast('Try again in a moment'); return { ok: false }; }
          if (code === 'bad_request' || code === 'transform_error' || code === 'rejected_extension' || code === 'too_large' || code === 'request_unknown') { console.error('Tare export', code, e && e.message); T.toast('Export failed (' + code + ')'); return { ok: false }; }
          T.downloads = null; T.toast("Backups aren't available in this view"); T.renderers.settings(true); return { ok: false };
        }
      }
      if (T.framed) { T.toast("Backups aren't available in this view"); return { ok: false }; }
      try {
        const blob = new Blob([text], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: filename });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        done();
        return { ok: true };
      } catch (e) { T.toast("Couldn't save the backup"); return { ok: false }; }
    } finally { B.exporting = false; }
  }
  T.hooks.exportBackup = () => exportBackup(null);
  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => reviewImport(C.parseBackup(String(reader.result)));
    reader.onerror = () => T.toast("Couldn't read that file");
    reader.readAsText(file);
  }
  T.hooks.importBackup = function () {
    const fi = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    fi.addEventListener('change', () => { const f = fi.files && fi.files[0]; if (f) importFile(f); fi.remove(); });
    document.body.appendChild(fi); fi.click();
  };
  async function reviewImport(p) {
    if (!p.ok) { T.openModal({ title: "Can't import", body: h('p', { text: p.error }), footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => T.closeModal() }, 'OK')] }); return; }
    if (!canImport()) { T.toast(T.readonly() ? "Import isn't available right now — reload the page" : 'Still loading your data — try again in a moment'); return; }
    const s = p.summary;
    let current = {};
    try { current = await enumerateDocs(); } catch (e) { T.toast("Couldn't read your current data"); return; }
    const storeEmpty = !T.data.app && !Object.keys(current).some((k) => k !== C.PATHS.app);
    // data-derived age comparison
    // A missing, malformed or future export time is treated as unknown, which always shows the "newer data" warning.
    const ex = s.exportedAt && s.exportedAt.slice(0, 10) <= C.addDays(T.ui.todayKey, 1) ? s.exportedAt : '';
    let K = 0, W = 0, F = 0;
    Object.keys(current).forEach((path) => {
      const d = current[path];
      if (C.PATH_RE.day.test(path)) { if (C.isLogged(d) && (!p.docs[path] || (d.updatedAt && d.updatedAt > ex))) K++; }
      else if (C.PATH_RE.weights.test(path)) { Object.keys(d.byDate || {}).forEach((k) => { const w = d.byDate[k]; if (w && w.at && w.at > ex) W++; }); }
      else if (C.PATH_RE.food.test(path) || C.PATH_RE.meal.test(path)) { if (d.updatedAt && d.updatedAt > ex) F++; }
    });
    const newer = !storeEmpty && (!ex || K || W || F);
    const total = new Set(Object.keys(current).concat(Object.keys(p.docs))).size;
    if (total > C.DOC_CAP) { T.openModal({ title: "Can't import", body: h('p', { text: 'This backup plus your current data would exceed ' + C.DOC_CAP.toLocaleString('en-US') + ' documents. Erase first, or import a smaller backup.' }), footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => T.closeModal() }, 'OK')] }); return; }
    const cb = h('input', { type: 'checkbox' });
    const skip = h('input', { type: 'checkbox' });
    let missingFoods = 0;
    Object.keys(p.docs).forEach((path) => { if (C.PATH_RE.day.test(path)) Object.values(p.docs[path].entries).forEach((e) => { if (e.foodId && !p.docs['foods/' + e.foodId]) missingFoods++; }); });
    const lines = h('div', { class: 'review' },
      h('div', { text: 'Backup from ' + (ex ? C.fmtDate(ex.slice(0, 10)) : 'unknown date') }),
      h('div', { text: s.foods + ' foods · ' + s.meals + ' meals · ' + s.days + ' logged days' + (s.firstDay ? ' (' + C.fmtDate(s.firstDay, false) + ' – ' + C.fmtDate(s.lastDay, false) + ')' : '') + ' · ' + s.weights + ' weigh-ins' }),
      p.skipped ? h('div', { class: 'warn', text: p.skipped + ' damaged record' + (p.skipped > 1 ? 's' : '') + ' will be skipped' }) : null,
      missingFoods ? h('div', { class: 'small', text: missingFoods + ' entries refer to foods missing from the backup; placeholder foods will be created' }) : null,
      newer ? h('div', { class: 'crit', text: 'Your current data is newer: ' + K + ' logged day' + (K === 1 ? '' : 's') + ', ' + W + ' weigh-in' + (W === 1 ? '' : 's') + ' and ' + F + ' food' + (F === 1 ? '' : 's') + '/meals changed since this backup will be deleted.' }) : null);
    const body = h('div', { class: 'stack' }, lines,
      storeEmpty ? null : h('label', { class: 'check' }, cb, h('span', { text: newer ? 'I understand this deletes newer data' : 'I understand this replaces everything currently in Tare' })),
      storeEmpty || !exportAvailable() ? null : h('label', { class: 'check' }, skip, h('span', { text: 'Skip the safety copy (a backup of the current data is saved first unless ticked)' })));
    const go = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { if (!storeEmpty && !cb.checked) { cb.focus(); return; } T.closeModal(true); replaceAll(p.docs, current, storeEmpty || skip.checked || !exportAvailable(), ex); } }, storeEmpty ? 'Restore' : 'Replace everything');
    T.openModal({ title: 'Restore from backup', body, footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'), go] });
  }
  // A direct-write job with its own retry policy (never through the interactive queue).
  async function writeJob(items, label, fn) {
    const prog = h('div', { class: 'small', text: label + '…' });
    const modal = T.openModal({ title: label, body: h('div', { class: 'stack' }, prog, h('div', { class: 'tiny muted', text: "Don't close this page." })), dismissible: false, guard: () => false });
    const unload = (e) => { e.preventDefault(); e.returnValue = ''; };
    root.addEventListener('beforeunload', unload);
    let done = 0, failed = null;
    const worker = async () => {
      while (items.length && !failed) {
        const it = items.shift();
        let attempt = 0;
        for (;;) {
          try { await fn(it); break; }
          catch (e) {
            const code = e && e.code;
            if ((code === 'unavailable' || code === 'resource_exhausted' || !code) && attempt < 5) { attempt++; await sleep(500 * Math.pow(2, attempt)); continue; }
            failed = { code: code || 'error', item: it }; break;
          }
        }
        done++;
        prog.textContent = label + '… ' + done + ' / ' + (done + items.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    root.removeEventListener('beforeunload', unload);
    T.closeModal(true);
    void modal;
    return { done, failed };
  }
  async function replaceAll(docs, current, skipSafety, exportedAtIn) {
    if (!skipSafety) {
      const r = await exportBackup(null);
      if (!r.ok) { T.toast('Import cancelled — save the safety copy first'); return; }
    }
    const now = T.now();
    Object.keys(docs).forEach((path) => {
      if (!C.PATH_RE.day.test(path)) return;
      Object.values(docs[path].entries).forEach((e) => { if (e.foodId && !docs['foods/' + e.foodId]) docs['foods/' + e.foodId] = C.placeholderFood(e, now); });
    });
    const app = docs[C.PATHS.app];
    const order = (path) => (C.PATH_RE.food.test(path) ? 0 : C.PATH_RE.meal.test(path) ? 1 : C.PATH_RE.weights.test(path) ? 2 : 3);
    const writes = Object.keys(docs).filter((p) => p !== C.PATHS.app).sort((a, b) => order(a) - order(b)).map((path) => ({ path, body: docs[path] }));
    const deletes = Object.keys(current).filter((p) => p !== C.PATHS.app && !docs[p]).map((path) => ({ path, del: true }));
    const items = writes.concat(deletes);
    const total = items.length;
    const stamp = exportedAtIn || now;
    writes.forEach((it) => { if (it.body && !it.body.updatedAt) it.body.updatedAt = stamp; });
    T.ui.importing = true;
    // Record the earliest year first, so an interrupted restore never leaves older days unreachable.
    try {
      let minYear = null;
      Object.keys(docs).forEach((p) => { const m = C.PATH_RE.day.exec(p); if (m && (!minYear || m[1] < minYear)) minYear = m[1]; });
      const cur = await T.store.get(C.PATHS.app);
      const curFy = cur.exists && cur.data && C.isYear(cur.data.firstYear) ? cur.data.firstYear : null;
      const fy = [minYear, curFy, app.firstYear].filter(C.isYear).sort()[0] || T.thisYear();
      if (cur.exists) await T.store.update(C.PATHS.app, { firstYear: fy });
      else await T.store.set(C.PATHS.app, Object.assign({}, app, { firstYear: fy, createdAt: app.createdAt || now }));
    } catch (e) { T.ui.importing = false; T.toast("Couldn't start the restore (" + ((e && e.code) || 'error') + ') — nothing was changed'); return; }
    const r = await writeJob(items, 'Restoring', (it) => (it.del ? T.store.delete(it.path) : T.store.set(it.path, it.body)));
    if (r.failed) { T.ui.importing = false; T.toast('Restore incomplete: ' + r.done + ' of ' + total + ' records written (' + r.failed.code + ') — import the same file again; it is safe to repeat', { ms: 12000 }); return; }
    const exportedAt = exportedAtIn || now;
    let firstYear = app.firstYear;
    Object.keys(docs).forEach((p) => { const m = C.PATH_RE.day.exec(p); if (m && (!firstYear || m[1] < firstYear)) firstYear = m[1]; });
    const finalApp = Object.assign({}, app, { lastBackupAt: exportedAt, updatedAt: now, firstYear: firstYear || T.thisYear() });
    try { await T.store.set(C.PATHS.app, finalApp); } catch (e) { T.ui.importing = false; T.toast("Restore nearly done but the settings record failed — import the file again"); return; }
    // refresh mirror for years outside the live subscriptions
    T.years.loaded = {};
    Object.keys(docs).forEach((p) => { const m = C.PATH_RE.day.exec(p); if (m && m[1] !== T.thisYear() && m[1] !== T.lastYear()) T.snap.days[m[2]] = C.deepFreeze(C.clone(docs[p])); });
    Object.keys(T.snap.days).forEach((k) => { const y = k.slice(0, 4); if (y !== T.thisYear() && y !== T.lastYear() && !docs[C.dayPath(k)]) delete T.snap.days[k]; });
    T.ui.importing = false;
    T.toast('Restored ' + Object.keys(docs).filter((p) => C.PATH_RE.food.test(p)).length + ' foods and ' + Object.keys(docs).filter((p) => C.PATH_RE.day.test(p)).length + ' days');
    T.go('today'); T.render();
  }
  function eraseAll() {
    const inp = h('input', { type: 'text', placeholder: 'ERASE', autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Type ERASE to confirm' });
    const go = h('button', { class: 'btn btn-danger', type: 'button', disabled: true, onclick: doErase }, 'Erase everything');
    inp.addEventListener('input', () => { go.disabled = inp.value !== 'ERASE'; });
    async function doErase() {
      T.closeModal(true);
      const r = await exportBackup(null);
      if (!r.ok) { T.toast('Erase cancelled — the backup was not saved'); return; }
      if (!T.downloads && !confirm('Did the backup file download? Click OK to erase everything.')) return;
      let current;
      try { current = await enumerateDocs(); } catch (e) { T.toast("Couldn't read all your data — nothing erased"); return; }
      T.ui.erasing = true;
      if (T.stopAllSubscriptions) T.stopAllSubscriptions();
      if (T.queue) T.queue.stop(true);
      try { root.localStorage.removeItem('tare.pending'); } catch (e) { /* ignore */ }
      const items = [{ path: C.PATHS.app }].concat(Object.keys(current).filter((p) => p !== C.PATHS.app).map((path) => ({ path })));
      const years = T.allYears();
      const res = await writeJob(items, 'Erasing', (it) => T.store.delete(it.path));
      if (!res.failed) {
        // Sweep: re-read every collection and delete anything this device never saw.
        try {
          const cols = ['foods', 'meals', 'weights'].concat(years.map((y) => C.daysCol(y)));
          for (let pass = 0; pass < 2; pass++) {
            let found = 0;
            for (const col of cols) { const docs = await T.store.query(col, {}); found += docs.length; for (const d of docs) await T.store.delete(col + '/' + d.id); }
            if (!found) break;
          }
        } catch (e) { res.failed = { code: (e && e.code) || 'error' }; }
      }
      if (res.failed) {
        T.openModal({ title: "Erase didn't finish", dismissible: false, body: h('p', { text: 'Some documents could not be deleted (' + res.failed.code + '). Reload and run Erase again to finish — your backup file is safe.' }), footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, 'Reload')] });
        return;
      }
      location.reload();
    }
    T.openModal({ title: 'Erase all data', body: h('div', { class: 'stack' }, h('p', { text: 'This deletes every food, meal, weigh-in and logged day. A backup file is saved first. Type ERASE to confirm.' }), inp),
      footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => T.closeModal() }, 'Cancel'), go] });
  }

  // backup reminder: once per session, when the last backup is 30+ days old (or never, with 20+ entries)
  const remind = setInterval(() => {
    if (!T.baseReady() || !T.data.app) return;
    clearInterval(remind);
    const app = T.data.app;
    const entries = Object.keys(T.data.days).reduce((n, k) => n + T.entries(k).length, 0);
    const days = app.lastBackupAt ? C.daysBetween(app.lastBackupAt.slice(0, 10), T.ui.todayKey) : null;
    if ((days == null && entries >= 20) || (days != null && days >= 30)) T.toast(days == null ? 'Tip: export a backup from Settings once you have some data' : 'Your last backup was ' + days + ' days ago — export a fresh one from Settings', { ms: 6000 });
  }, 3000);
})(window);
