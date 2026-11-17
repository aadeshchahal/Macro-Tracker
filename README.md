# Tare — food-scale ledger

A personal tracker for daily calories, macros and body weight. Foods are entered exactly as their
nutrition label prints them (per 100 g, per 55 g serving, per 240 ml) and logged by weight straight
off the kitchen scale. Body weight is logged every morning and graphed with a smoothed trend line.

**Hosting:** the author's copy runs as a private Claude artifact (data synced between phone and PC
through the artifact's `db` capability), so there is no public live link. To try Tare yourself, run it
from disk (see "Running locally") or publish your own `dist/index.html` build as an artifact.

## Daily use

- **Today** — type a few letters of a food, press Enter, type the grams (or ml), press Enter.
  Repeat foods remember the amount you used last time. The amount box does arithmetic
  (`412-187` = bowl minus tare, `454/2` = half a pack). Weigh in at the top. Tiles show totals
  against your targets. Delete a row with ×; Undo is in the toast. "Copy yesterday" fills an empty day.
- **Foods** — your label database. "+ New food" opens an editor laid out like a Nutrition Facts
  panel. Star a food to keep it in the chips row. Meals are saved from Today ("Save as meal…").
- **Progress** — weight chart (dots = weigh-ins, line = trend), intake bars vs target, weekly
  table, and the weigh-in table for edits.
- **Settings** — daily targets (effective from a date), weight unit, goal weight, backup export /
  import, help, and erase.

## Running locally (optional)

The same files run from disk in "local mode" (data stays in that browser only):

```bash
python -m http.server 8765 --bind 127.0.0.1
```

then open http://localhost:8765/ — or just double-click `index.html`. Local mode is handy for
trying things without touching your real data; it does not sync.

## Publishing

The live page must be a single self-contained file, because the Claude phone apps don't load
separate CSS or script files. Build it, then publish `dist/index.html` to the existing link:

```bash
npm run build
```

## Tests

```bash
npm test
```

Runs the Node test suites for the pure logic (`core.js`), the storage layer (`store.js`), the
database wrapper against a contract mock (`tests/dbstore.test.js`), and regression tests for the
issues found in code review (`tests/review-fixes.test.js`).

## Files

| File | What it is |
|---|---|
| `index.html` | Page fragment (the artifact host adds the document skeleton) |
| `style.css` | Design tokens (light + dark), layout, components, phone rules |
| `core.js` | Pure logic: dates, nutrition math, parsing, validation, readers, search, trend, backup format |
| `store.js` | Storage seam: DbStore (Claude `db` capability) / LocalStore (localStorage), write queue, resilient subscriptions |
| `charts.js` | Hand-drawn SVG weight and intake charts |
| `app.js` | Boot, data mirror + pending-write overlay, subscriptions, Today screen, shell |
| `screens.js` | Foods, Progress, Settings screens; backup export/import; erase |
| `tests/` | Node tests, a seed page and a width probe used for headless checks |

## Data

Stored in the artifact's database, private to your Claude account:

- `meta/app` — settings, targets (map keyed by start date), first year
- `weights/YYYY` — one document per year of weigh-ins (`byDate`)
- `foods/{id}`, `meals/{id}`
- `years/YYYY/days/YYYY-MM-DD` — one document per logged day; `entries` is a map keyed by entry id;
  a `null` value means removed

Every write is a field-level patch, so logging on two devices at the same time is safe. Export a
backup from Settings about once a month; the file restores everything on any copy of Tare.

Design notes and the storage/sync rules live in the session's design documents (spec + addendum).
