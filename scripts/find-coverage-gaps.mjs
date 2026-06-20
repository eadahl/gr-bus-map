// find-coverage-gaps.mjs
//
// Offline coverage-gap finder. Reads the accumulated GPS log and the drawn route
// geometry, snaps each logged position to its own route's line (the same pin
// logic the live map uses), and flags the ones that land too far off: those are
// places a bus actually drove that the drawn map doesn't cover. It clusters the
// off-route points so recurring clusters pinpoint exactly which segments are
// missing (branches, extensions, reroutes).
//
// This is the cheap feedback loop for the accurate-routes initiative: instead of
// reconstructing every route from scratch, let the data tell us where the drawn
// map is already wrong, then fix those spots.
//
// Usage:
//   node scripts/find-coverage-gaps.mjs            # report top clusters
//   node scripts/find-coverage-gaps.mjs --all      # list every cluster
//
// Inputs:  data/vehicle-log.ndjson (from collect-vehicles.mjs), data/routes-final.geojson
// Outputs: console report + data/coverage-gaps.geojson (cluster centroids, gitignored)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LOG = 'data/vehicle-log.ndjson';
const ROUTES_FINAL = 'data/routes-final.geojson';
const OUT = 'data/coverage-gaps.geojson';

// Must match the live map's SNAP_MAX_M: farther than this from the drawn line is
// "off route" (an anomaly ring on the map, a coverage gap here).
const SNAP_MAX_M = 80;
const M_PER_DEG = 111320;
const COS_LAT = Math.cos((42.96 * Math.PI) / 180);

// Cluster cell size in meters. Off-route points within the same ~150 m cell are
// counted as one gap.
const CELL_M = 150;

if (!existsSync(LOG)) {
  console.error(`no log at ${LOG}. Run: node scripts/collect-vehicles.mjs`);
  process.exit(1);
}

// ── route geometry -> per-route paths + the hub ring (same as the map) ───────
const geom = {};
let hubRing = null;
{
  const g = JSON.parse(readFileSync(ROUTES_FINAL, 'utf8'));
  for (const f of g.features) {
    if (f.properties.kind === 'hubzone') { hubRing = f.geometry.coordinates[0]; continue; }
    if (f.properties.kind) continue;
    const gg = f.geometry;
    geom[String(f.properties.routeId)] = gg.type === 'MultiLineString' ? gg.coordinates : [gg.coordinates];
  }
}

// Ray-casting point-in-polygon, same as the map: a bus inside the hub black box
// reads as "at the hub", not a coverage gap (its route line is clipped there).
function pointInRing(pt, ring) {
  if (!ring) return false;
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ── snap helpers (cos-lat-scaled planar, identical math to index.html) ───────
function nearestOnSegment(p, a, b) {
  const px = p[0] * COS_LAT, py = p[1];
  const ax = a[0] * COS_LAT, ay = a[1];
  const bx = b[0] * COS_LAT, by = b[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + dx * t), ey = py - (ay + dy * t);
  return ex * ex + ey * ey;
}
function snapDistM(p, paths) {
  let best = Infinity;
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const d2 = nearestOnSegment(p, path[i - 1], path[i]);
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best) * M_PER_DEG;
}

// ── scan the log ─────────────────────────────────────────────────────────────
const rows = readFileSync(LOG, 'utf8').trim().split('\n');
let total = 0, onRoute = 0, noGeom = 0, atHub = 0;
const cells = new Map(); // cellKey -> { lat,lon sums, count, routes:Set, dests:Set, distSum }

const dLat = CELL_M / M_PER_DEG;
const dLon = CELL_M / (M_PER_DEG * COS_LAT);

for (const line of rows) {
  if (!line) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.lat == null || o.lon == null) continue;
  total += 1;
  if (pointInRing([o.lon, o.lat], hubRing)) { atHub += 1; continue; } // at the hub, not a gap
  const paths = geom[String(o.routeId)];
  let off;
  if (!paths || !paths.length) { off = true; noGeom += 1; }
  else off = snapDistM([o.lon, o.lat], paths) > SNAP_MAX_M;
  if (!off) { onRoute += 1; continue; }

  const ck = `${Math.round(o.lat / dLat)},${Math.round(o.lon / dLon)}`;
  let c = cells.get(ck);
  if (!c) { c = { latSum: 0, lonSum: 0, count: 0, routes: new Set(), dests: new Set(), distSum: 0 }; cells.set(ck, c); }
  c.latSum += o.lat; c.lonSum += o.lon; c.count += 1;
  c.routes.add(String(o.routeId));
  if (o.dest) c.dests.add(o.dest);
  if (paths && paths.length) c.distSum += snapDistM([o.lon, o.lat], paths);
}

const clusters = [...cells.values()]
  .map((c) => ({
    lat: c.latSum / c.count, lon: c.lonSum / c.count, count: c.count,
    routes: [...c.routes], dests: [...c.dests], avgOffM: c.count ? Math.round(c.distSum / c.count) : null,
  }))
  .sort((a, b) => b.count - a.count);

// ── report ───────────────────────────────────────────────────────────────────
const offTotal = clusters.reduce((s, c) => s + c.count, 0);
const considered = total - atHub;
console.log(`scanned ${total} positions: ${atHub} at hub (skipped), ${onRoute} on route, ${offTotal} off route (${considered ? ((offTotal / considered) * 100).toFixed(1) : 0}% of non-hub), ${noGeom} on routes with no drawn line.`);
console.log(`${clusters.length} coverage-gap clusters (>${SNAP_MAX_M} m off, ~${CELL_M} m cells).\n`);

const show = process.argv.includes('--all') ? clusters : clusters.slice(0, 15);
console.log('count  routes        avgOff   ~location (lat,lon)        destinations');
for (const c of show) {
  const loc = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  const dest = c.dests.slice(0, 3).join(' / ') || '-';
  console.log(`${String(c.count).padStart(5)}  ${c.routes.join(',').padEnd(12)}  ${(c.avgOffM != null ? c.avgOffM + 'm' : 'no-geom').padStart(6)}  ${loc.padEnd(24)}  ${dest}`);
}
if (clusters.length > show.length) console.log(`... and ${clusters.length - show.length} more (--all to list)`);

// cluster centroids as points, for optional later viewing on a map
writeFileSync(OUT, JSON.stringify({
  type: 'FeatureCollection',
  features: clusters.map((c) => ({
    type: 'Feature',
    properties: { count: c.count, routes: c.routes.join(','), dests: c.dests.join(' / '), avgOffM: c.avgOffM },
    geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
  })),
}));
console.log(`\nwrote ${clusters.length} cluster centroids to ${OUT}`);
