// compare-bases.mjs
//
// THE THREE-WAY BASE HEAD-TO-HEAD. Builds one combined GeoJSON (each feature
// tagged `source: 'gtfs' | 'kml' | 'gps'`) plus a per-route stats table, so we
// can look at GTFS shapes vs the agency's own official KML traces vs our
// GPS-reconstructed patterns, side by side, and decide what the new base
// geometry should be.
//
// Sources:
//   gtfs -> data/routes.geojson          (build-routes.mjs; one shape/route+dir)
//   kml  -> data/detour-traces/*.kml     (collect-detours.mjs archive; the
//           agency's own drawn line, CURRENT file per route: prefers the
//           newest _DET_-timestamped trace, falls back to the plain file)
//   gps  -> data/routes-reconstructed-debug.geojson (reconstruct-routes.mjs;
//           re-run this on the full log first for a fair comparison)
//
// Usage: node scripts/compare-bases.mjs
// Out:   data/base-compare.geojson (gitignored)  -> compare-preview.html

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'data/base-compare.geojson';
const M_PER_DEG = 111320;
const COS = Math.cos((42.96 * Math.PI) / 180);
const distM = (a, b) => Math.hypot((a[0] - b[0]) * COS * M_PER_DEG, (a[1] - b[1]) * M_PER_DEG);
const lineLenM = (c) => { let L = 0; for (let i = 1; i < c.length; i++) L += distM(c[i - 1], c[i]); return L; };

// The 25 drawn routes + their colors, read from the deployed geometry (one
// source of truth for route identity/color across all three candidates).
const drawn = JSON.parse(readFileSync('data/routes-final.geojson', 'utf8'))
  .features.filter((f) => !f.properties.kind);
const colorById = {};
for (const f of drawn) colorById[String(f.properties.routeId)] = f.properties.color;
const routeIds = drawn.map((f) => String(f.properties.routeId));

const features = [];
const stats = {}; // routeId -> { gtfs: {...}, kml: {...}, gps: {...} }
for (const id of routeIds) stats[id] = {};

// ── GTFS: one shape per route+direction ───────────────────────────────────
{
  const g = JSON.parse(readFileSync('data/routes.geojson', 'utf8'));
  const byRoute = {};
  for (const f of g.features) {
    const id = String(f.properties.routeId);
    if (!routeIds.includes(id)) continue;
    features.push({ type: 'Feature', properties: { source: 'gtfs', routeId: id, color: colorById[id] }, geometry: f.geometry });
    (byRoute[id] = byRoute[id] || []).push(f.geometry.coordinates);
  }
  for (const id of routeIds) {
    const pieces = byRoute[id] || [];
    stats[id].gtfs = { pieces: pieces.length, km: +(pieces.reduce((s, c) => s + lineLenM(c), 0) / 1000).toFixed(1) };
  }
}

// ── KML: the agency's own trace, the CURRENT file per route ──────────────
function parseKmlCoords(text) {
  const blocks = [...text.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)].map((m) => m[1]);
  return blocks
    .map((b) => b.trim().split(/\s+/).map((p) => { const [lon, lat] = p.split(',').map(Number); return [lon, lat]; }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
    .filter((c) => c.length >= 2);
}
{
  const dir = 'data/detour-traces';
  const files = existsSync(dir) ? readdirSync(dir) : [];
  for (const id of routeIds) {
    // exact route-number match: Route{id}.kml or Route{id}_DET_{ts}.kml, never Route{id}X...
    const re = new RegExp(`^Route${id}(?:_DET_(\\d{6})_(\\d{6}))?\\.kml$`);
    let best = null, bestTs = '';
    for (const f of files) {
      const m = re.exec(f);
      if (!m) continue;
      const ts = (m[1] || '') + (m[2] || '');
      if (!best || ts > bestTs) { best = f; bestTs = ts; }
    }
    if (!best) { stats[id].kml = { pieces: 0, km: 0, file: null, detoured: false }; continue; }
    const text = readFileSync(`${dir}/${best}`, 'utf8');
    const pieces = parseKmlCoords(text);
    for (const c of pieces) features.push({ type: 'Feature', properties: { source: 'kml', routeId: id, color: colorById[id] }, geometry: { type: 'LineString', coordinates: c } });
    stats[id].kml = { pieces: pieces.length, km: +(pieces.reduce((s, c) => s + lineLenM(c), 0) / 1000).toFixed(1), file: best, detoured: /_DET_/.test(best) };
  }
}

// ── GPS: our reconstructed patterns (>=3 trips each) ──────────────────────
{
  const path = 'data/routes-reconstructed-debug.geojson';
  if (!existsSync(path)) {
    console.error(`missing ${path} - run: node scripts/reconstruct-routes.mjs`);
    process.exit(1);
  }
  const g = JSON.parse(readFileSync(path, 'utf8'));
  const byRoute = {};
  for (const f of g.features) {
    const id = String(f.properties.routeId);
    if (!routeIds.includes(id)) continue;
    features.push({ type: 'Feature', properties: { source: 'gps', routeId: id, color: colorById[id], dir: f.properties.dir, trips: f.properties.trips, dests: f.properties.dests }, geometry: f.geometry });
    (byRoute[id] = byRoute[id] || []).push(f);
  }
  for (const id of routeIds) {
    const pats = byRoute[id] || [];
    stats[id].gps = { patterns: pats.length, km: +(pats.reduce((s, f) => s + lineLenM(f.geometry.coordinates), 0) / 1000).toFixed(1), dests: [...new Set(pats.flatMap((f) => (f.properties.dests || '').split(' / ')))].filter(Boolean) };
  }
}

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));

// ── report ───────────────────────────────────────────────────────────────
console.log(`wrote ${features.length} features (gtfs+kml+gps) to ${OUT}\n`);
console.log('route  gtfs(pieces/km)  kml(pieces/km, detour?)   gps(patterns/km)   gps branches (dests)');
for (const id of routeIds.sort((a, b) => (+a || 1e9) - (+b || 1e9))) {
  const s = stats[id];
  const g = s.gtfs ? `${s.gtfs.pieces}/${s.gtfs.km}km` : '-';
  const k = s.kml ? `${s.kml.pieces}/${s.kml.km}km${s.kml.detoured ? ' DET' : ''}` : '-';
  const p = s.gps ? `${s.gps.patterns}/${s.gps.km}km` : '-';
  const dests = s.gps ? s.gps.dests.slice(0, 3).join(', ') : '';
  console.log(`${id.padEnd(5)}  ${g.padEnd(17)}${k.padEnd(26)}${p.padEnd(19)}${dests}`);
}

writeFileSync('data/base-compare-stats.json', JSON.stringify(stats));
console.log('\nwrote data/base-compare-stats.json');
console.log('view: compare-preview.html (start a local server, then open it)');
