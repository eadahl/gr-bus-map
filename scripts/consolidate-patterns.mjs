// consolidate-patterns.mjs
//
// Pattern SELECTION for the reconstructed base. reconstruct-routes.mjs (after the
// tripId-segmentation fix) emits ~364 patterns: each is individually a realistic
// one-way run, but ~200 of them are SHORT PARTIAL runs (a bus that went out of
// service mid-route, or a collection gap that split a real run), plus a few
// near-duplicate full patterns and a handful of same-slot doubles. For a usable
// base we want ONE clean line per route + direction + real branch.
//
// Method: DESTINATION-driven selection, per (routeId, dir).
//   - Sort candidates by trips DESC (most-observed = most trustworthy). The clean
//     full one-way run is by far the most observed, so it seeds as the DOMINANT.
//   - The real branches these routes have are all distinct DESTINATIONS (route 9
//     -> Target-GreenRidge vs Walmart-Alpine, route 5 -> Woodland-only, route 1 ->
//     Meijer-54th). So keep an extra pattern only if it reaches a destination no
//     kept line in this direction covers yet, AND it is substantial (>= half the
//     dominant's length, else it is a truncated fragment that happens to carry the
//     scheduled dest) AND it actually adds new road geometry (guards a same-road
//     run with a noisy dest label). Everything same-dest is a dup/partial -> drop.
//   - Also drop anything much LONGER than the dominant (same-slot double / out-and-
//     back, ~2x). Pure coverage-greedy was tried first and leaked short fragments
//     and near-duplicate same-dest full runs (newFrac is noisy on short lines and
//     on pre-match GPS wobble); the dest gate is the more predictable signal.
//
// Input : data/routes-reconstructed-debug.geojson  (reconstruct-routes.mjs)
// Output: data/routes-reconstructed-consolidated-debug.geojson (gitignored)
//         each kept feature gets role: 'dominant' | 'branch'
// Usage : node scripts/consolidate-patterns.mjs
// View  : reconstruct-preview.html (toggle full vs consolidated)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const IN = 'data/routes-reconstructed-debug.geojson';
const OUT = 'data/routes-reconstructed-consolidated-debug.geojson';

// ── tunables ──────────────────────────────────────────────────────────────────
const CELL_M = 120;        // grid cell for the new-geometry guard (matches reconstruct's SIG_CELL_M)
const MIN_LEN_FRAC = 0.50; // a branch must be at least this x the dominant length (else it's a fragment)
const LEN_CAP = 1.40;      // drop candidates longer than this x the dominant length (doubles / out-and-back)
const NEW_COV_MIN = 0.12;  // a new-dest branch must still add at least this fraction of new cells (guards
                            // a same-road run that merely carries a different scheduled-dest label)

const M_PER_DEG = 111320;
const COS = Math.cos((42.96 * Math.PI) / 180);
const dLat = CELL_M / M_PER_DEG;
const dLon = CELL_M / (M_PER_DEG * COS);
const distM = (a, b) => Math.hypot((a[0] - b[0]) * COS * M_PER_DEG, (a[1] - b[1]) * M_PER_DEG);
const lineLenKm = (c) => { let L = 0; for (let i = 1; i < c.length; i++) L += distM(c[i - 1], c[i]); return L / 1000; };
function cellsOf(coords) {
  const s = new Set();
  for (const [lon, lat] of coords) s.add(`${Math.round(lat / dLat)},${Math.round(lon / dLon)}`);
  return s;
}
// normalize a joined dest string into a set of place tokens. reconstruct joins
// multiple dests with ' / ' (space-slash-space); within-name slashes ("City/Health
// Campus") are NOT separators, so split on ' / ' only. Spacing/punct variants
// ("Walmart - Alpine Twp" vs "Walmart-Alpine Twp") normalize to the same token.
function destSet(dests) {
  const s = new Set();
  for (const part of (dests || '').split(' / ')) {
    const t = part.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (t) s.add(t);
  }
  return s;
}

if (!existsSync(IN)) { console.error(`missing ${IN} - run: node scripts/reconstruct-routes.mjs`); process.exit(1); }
const g = JSON.parse(readFileSync(IN, 'utf8'));

// group by route|dir, richest info attached
const groups = new Map();
for (const f of g.features) {
  const k = `${f.properties.routeId}|${f.properties.dir}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push({
    f,
    trips: f.properties.trips || 0,
    km: lineLenKm(f.geometry.coordinates),
    cells: cellsOf(f.geometry.coordinates),
    dests: destSet(f.properties.dests),
  });
}

const kept = [];
const report = []; // per group: { key, keeps:[], drops:[] }
for (const [key, cands] of groups) {
  cands.sort((a, b) => b.trips - a.trips || b.km - a.km);
  const covered = new Set();
  const keptDests = new Set();
  const keeps = [], drops = [];
  let domKm = 0;
  for (const c of cands) {
    let newCells = 0;
    for (const cell of c.cells) if (!covered.has(cell)) newCells += 1;
    const newFrac = c.cells.size ? newCells / c.cells.size : 0;
    const newDestTokens = [...c.dests].filter((d) => !keptDests.has(d));

    let keep, role, reason;
    if (keeps.length === 0) {
      keep = true; role = 'dominant'; reason = 'dominant'; domKm = c.km;
    } else if (newDestTokens.length === 0) {
      keep = false; reason = 'same-dest (dup/partial)';
    } else if (c.km < domKm * MIN_LEN_FRAC) {
      keep = false; reason = `fragment ${c.km.toFixed(1)}km <${(domKm * MIN_LEN_FRAC).toFixed(1)}`;
    } else if (c.km > domKm * LEN_CAP) {
      keep = false; reason = `toolong ${c.km.toFixed(1)}km >${(domKm * LEN_CAP).toFixed(1)}`;
    } else if (newFrac < NEW_COV_MIN) {
      keep = false; reason = `newdest but only ${(newFrac * 100).toFixed(0)}% new geom (same road)`;
    } else {
      keep = true; role = 'branch'; reason = `branch -> ${newDestTokens.join(',')} (${(newFrac * 100).toFixed(0)}% new)`;
    }

    if (keep) {
      for (const cell of c.cells) covered.add(cell);
      for (const d of c.dests) keptDests.add(d);
      c.f.properties.role = role;
      kept.push(c.f);
      keeps.push({ role, trips: c.trips, km: c.km, dests: c.f.properties.dests, reason });
    } else {
      drops.push({ trips: c.trips, km: c.km, dests: c.f.properties.dests, reason });
    }
  }
  report.push({ key, keeps, drops });
}

kept.sort((a, b) => (b.properties.trips || 0) - (a.properties.trips || 0));
writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features: kept }));

// ── report ───────────────────────────────────────────────────────────────────
const totalIn = g.features.length, totalKept = kept.length;
console.log(`consolidated ${totalIn} patterns -> ${totalKept} kept (${totalIn - totalKept} dropped)\n`);
report.sort((a, b) => {
  const ra = +a.key.split('|')[0] || 1e9, rb = +b.key.split('|')[0] || 1e9;
  return ra - rb || a.key.localeCompare(b.key);
});
for (const { key, keeps, drops } of report) {
  const keepStr = keeps.map((k) => `${k.role === 'dominant' ? '*' : '+'}${k.trips}@${k.km.toFixed(1)}km${k.dests ? ` [${k.dests}]` : ''}${k.role === 'branch' ? ` (${k.reason})` : ''}`).join('  ');
  console.log(`${key.padEnd(16)} keep ${keeps.length}/${keeps.length + drops.length}: ${keepStr}`);
  if (process.env.VERBOSE && drops.length) {
    for (const d of drops) console.log(`${' '.repeat(18)}drop ${d.trips}@${d.km.toFixed(1)}km [${d.dests || ''}] (${d.reason})`);
  }
}
console.log(`\nwrote ${totalKept} consolidated patterns to ${OUT}`);
console.log('view: reconstruct-preview.html (toggle full vs consolidated). VERBOSE=1 lists drops.');
