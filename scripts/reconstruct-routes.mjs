// reconstruct-routes.mjs
//
// First pass of "build route geometry from accumulated GPS" (initiative step 2).
// Turns the live-vehicle log into clean per-route, per-direction, per-PATTERN
// lines, so the branches the single-GTFS-shape map drops show up as their own
// patterns. This pass stops BEFORE map-matching: it produces raw reconstructed
// centerlines so we can eyeball that the trip-grouping and pattern-clustering are
// right. Map-matching onto OSM roads (match-routes.mjs) is the next iteration.
//
// Pipeline (matches the agreed plan):
//   1. group log by (routeId, tripId), order by time  -> one traveled line per run
//   2. clean each trip (dedup, drop teleports, length/point filters)
//   3. cluster trips within (routeId, dir) into patterns by grid-signature overlap
//      (a pattern = a distinct path; divergent paths = branches/short-turns)
//   4. build ONE centerline per pattern = per-point MEDIAN of arc-length-resampled
//      member trips (many overlapping runs average out GPS noise)
//
// Reads a snapshot of the log as it stands now; the collector can keep running.
//
// Usage: node scripts/reconstruct-routes.mjs
// Out:   data/routes-reconstructed-debug.geojson (gitignored)  -> reconstruct-preview.html

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LOG = 'data/vehicle-log.ndjson';
const ROUTES_FINAL = 'data/routes-final.geojson';
const OUT = 'data/routes-reconstructed-debug.geojson';

// ── tunables (the two decisions: min trips per pattern, directions kept separate)
const MIN_TRIP_POINTS = 6;      // a run needs at least this many fixes to trace
const MIN_TRIP_LEN_M = 800;     // and at least this much length (drop fragments)
const TELEPORT_M = 1500;        // drop a fix that jumps more than this from the last (bad GPS)
const SIG_CELL_M = 120;         // grid-signature cell size for path similarity
const SIM_THRESHOLD = 0.5;      // Jaccard overlap to join a trip to a pattern
const MIN_PATTERN_TRIPS = 3;    // a pattern must be backed by this many trips (no one-offs)
const RESAMPLE_N = 150;         // points in each reconstructed centerline
const LEN_RATIO_MAX = 1.6;      // AFTER clustering (step 3, unchanged - spatial Jaccard is the
                                 // right signal for grouping), drop member trips whose length
                                 // falls outside this ratio of the pattern's MEDIAN length before
                                 // resampling (step 4). A join-time length gate was tried and made
                                 // things worse (fragmented clean routes like 51/90 into many small
                                 // patterns, since it interacts badly with the frozen seedSig +
                                 // length-descending processing order). Trimming post-hoc, right
                                 // before the index-by-index median math that actually blends two
                                 // different physical extents into one wandering line, is surgical:
                                 // it doesn't touch clustering, only which members feed the average.

// Hub zone (same box the deployed pipeline clips at, scripts/polish-routes.mjs) - GPS
// inside the downtown convergence is where trip paths through the hub vary the most
// (bay pull-ins, layovers, which of ~19 routes' streets a bus threads), so raw points
// there corrupt clustering same as they'd corrupt display. Drop them before tracing.
const ZONE_CENTER_LL = [-85.67302, 42.95863];
const ZONE_HALF_W_M = 111, ZONE_HALF_H_M = 217.5, ZONE_CR_M = Math.min(ZONE_HALF_W_M, ZONE_HALF_H_M) * 0.5;

const M_PER_DEG = 111320;
const COS_LAT = Math.cos((42.96 * Math.PI) / 180);
const dLat = SIG_CELL_M / M_PER_DEG;
const dLon = SIG_CELL_M / (M_PER_DEG * COS_LAT);

function distM(a, b) {
  const dx = (a[0] - b[0]) * COS_LAT * M_PER_DEG;
  const dy = (a[1] - b[1]) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

// Same rounded-rect test as polish-routes.mjs's inZone, in meters from the hub center.
function inHubZone(p) {
  const dx = Math.abs((p[0] - ZONE_CENTER_LL[0]) * COS_LAT * M_PER_DEG);
  const dy = Math.abs((p[1] - ZONE_CENTER_LL[1]) * M_PER_DEG);
  if (dx > ZONE_HALF_W_M || dy > ZONE_HALF_H_M) return false;
  if (dx <= ZONE_HALF_W_M - ZONE_CR_M || dy <= ZONE_HALF_H_M - ZONE_CR_M) return true;
  return (dx - (ZONE_HALF_W_M - ZONE_CR_M)) ** 2 + (dy - (ZONE_HALF_H_M - ZONE_CR_M)) ** 2 <= ZONE_CR_M ** 2;
}
function pathLen(c) { let L = 0; for (let i = 1; i < c.length; i++) L += distM(c[i - 1], c[i]); return L; }
function median(arr) { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// Even arc-length resample of a polyline to n points.
function resample(coords, n) {
  if (coords.length === 1) return Array.from({ length: n }, () => coords[0]);
  const segLen = [], total = (() => { let L = 0; for (let i = 1; i < coords.length; i++) { const d = distM(coords[i - 1], coords[i]); segLen.push(d); L += d; } return L; })();
  if (total === 0) return Array.from({ length: n }, () => coords[0]);
  const out = [];
  let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total;
    while (seg < segLen.length - 1 && acc + segLen[seg] < target) { acc += segLen[seg]; seg += 1; }
    const t = segLen[seg] ? (target - acc) / segLen[seg] : 0;
    const a = coords[seg], b = coords[seg + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function sigOf(coords) {
  const s = new Set();
  for (const [lon, lat] of coords) s.add(`${Math.round(lat / dLat)},${Math.round(lon / dLon)}`);
  return s;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// ── colors from the drawn map (one source of truth) ──────────────────────────
const colorById = {};
if (existsSync(ROUTES_FINAL)) {
  const g = JSON.parse(readFileSync(ROUTES_FINAL, 'utf8'));
  for (const f of g.features) if (!f.properties.kind) colorById[String(f.properties.routeId)] = f.properties.color;
}

// ── 1. group into trips ───────────────────────────────────────────────────────
if (!existsSync(LOG)) { console.error(`no log at ${LOG}. Run scripts/collect-vehicles.mjs first.`); process.exit(1); }
const rawTrips = new Map(); // routeId|tripId -> observations
for (const line of readFileSync(LOG, 'utf8').trim().split('\n')) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.lat == null || o.lon == null || o.tripId == null) continue;
  const k = `${o.routeId}|${o.tripId}`;
  if (!rawTrips.has(k)) rawTrips.set(k, []);
  rawTrips.get(k).push(o);
}

// ── 2. clean each trip ────────────────────────────────────────────────────────
const trips = []; // { routeId, dir, dest, coords, sig, len }
for (const obs of rawTrips.values()) {
  obs.sort((a, b) => (a.fixTime || 0) - (b.fixTime || 0));
  const coords = [];
  for (const o of obs) {
    const p = [o.lon, o.lat];
    if (inHubZone(p)) continue;       // hub convergence: too path-variable to trust (bay pull-ins, layovers)
    const prev = coords[coords.length - 1];
    if (prev) {
      const d = distM(prev, p);
      if (d < 8) continue;            // near-duplicate
      if (d > TELEPORT_M) continue;   // bad GPS jump
    }
    coords.push(p);
  }
  if (coords.length < MIN_TRIP_POINTS) continue;
  const len = pathLen(coords);
  if (len < MIN_TRIP_LEN_M) continue;
  const o0 = obs[0];
  trips.push({ routeId: String(o0.routeId), dir: o0.dir || 'unknown', dest: o0.dest || null, coords, sig: sigOf(coords), len });
}

// ── 3. cluster trips into patterns within (routeId, dir) ──────────────────────
const groups = new Map(); // routeId|dir -> trips[]
for (const t of trips) {
  const k = `${t.routeId}|${t.dir}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(t);
}

const patterns = []; // { routeId, dir, trips[], dests:Set, seedSig }
for (const [, gtrips] of groups) {
  gtrips.sort((a, b) => b.len - a.len); // longest (most complete) seeds first
  const pats = [];
  for (const t of gtrips) {
    let best = null, bestSim = 0;
    for (const p of pats) {
      const sim = jaccard(t.sig, p.seedSig);
      if (sim > bestSim) { bestSim = sim; best = p; }
    }
    if (best && bestSim >= SIM_THRESHOLD) { best.trips.push(t); best.dests.add(t.dest); }
    else pats.push({ routeId: t.routeId, dir: t.dir, trips: [t], dests: new Set([t.dest]), seedSig: t.sig });
  }
  for (const p of pats) if (p.trips.length >= MIN_PATTERN_TRIPS) patterns.push(p);
}

// ── 4. build one median centerline per pattern ────────────────────────────────
const features = [];
for (const p of patterns) {
  // Trim length-outlier members (a deadhead tail or a longer variant that still
  // shared enough cells to cluster in) before resampling: mixing very different
  // physical extents into the index-by-index median produces one wandering,
  // too-long line. Trim relative to the MEDIAN member length, and only if the
  // pattern still clears MIN_PATTERN_TRIPS afterward - otherwise keep everyone,
  // a thin pattern is better than an empty one.
  const lens = p.trips.map((t) => t.len).sort((a, b) => a - b);
  const midLen = lens[Math.floor(lens.length / 2)];
  const kept = p.trips.filter((t) => t.len <= midLen * LEN_RATIO_MAX && t.len >= midLen / LEN_RATIO_MAX);
  const members = kept.length >= MIN_PATTERN_TRIPS ? kept : p.trips;
  const resampled = members.map((t) => resample(t.coords, RESAMPLE_N));
  const line = [];
  for (let i = 0; i < RESAMPLE_N; i++) {
    line.push([median(resampled.map((r) => r[i][0])), median(resampled.map((r) => r[i][1]))]);
  }
  if (process.env.DEBUG_LEN) {
    const memLens = members.map((t) => t.len).sort((a, b) => a - b);
    const memMid = memLens[Math.floor(memLens.length / 2)] / 1000;
    const clen = pathLen(line) / 1000;
    console.error(`  ${p.routeId.padEnd(5)} ${p.dir.padEnd(4)} n=${String(members.length).padStart(3)}  memberMedian=${memMid.toFixed(1)}km  centerline=${clen.toFixed(1)}km  inflation=${(clen / memMid).toFixed(2)}x  ${[...p.dests].filter(Boolean).join('/')}`);
  }
  features.push({
    type: 'Feature',
    properties: {
      routeId: p.routeId,
      color: colorById[p.routeId] || '#888888',
      dir: p.dir,
      trips: p.trips.length,                          // weight: how scheduled this pattern is
      trimmed: p.trips.length - members.length,       // outlier-length members excluded from the geometry
      dests: [...p.dests].filter(Boolean).join(' / '),
      lenKm: +(pathLen(line) / 1000).toFixed(2),
    },
    geometry: { type: 'LineString', coordinates: line },
  });
}
features.sort((a, b) => b.properties.trips - a.properties.trips);

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));

// ── report ────────────────────────────────────────────────────────────────────
const byRoute = new Map();
for (const f of features) { const r = f.properties.routeId; byRoute.set(r, (byRoute.get(r) || 0) + 1); }
console.log(`trips: ${rawTrips.size} raw -> ${trips.length} usable (>=${MIN_TRIP_POINTS} pts, >=${MIN_TRIP_LEN_M} m)`);
console.log(`patterns kept (>=${MIN_PATTERN_TRIPS} trips): ${features.length} across ${byRoute.size} routes\n`);
console.log('route  patterns  (trips x dir -> dest)');
const routesSorted = [...byRoute.keys()].sort((a, b) => (+a || 9999) - (+b || 9999));
for (const r of routesSorted) {
  const fs2 = features.filter((f) => f.properties.routeId === r);
  const detail = fs2.map((f) => `${f.properties.trips}x ${shortDir(f.properties.dir)} ${f.properties.lenKm}km${f.properties.dests ? ' -> ' + f.properties.dests : ''}`).join('  |  ');
  console.log(`${r.padEnd(5)}  ${String(fs2.length).padStart(2)}        ${detail}`);
}
console.log(`\nwrote ${features.length} reconstructed patterns to ${OUT}`);
console.log('view: reconstruct-preview.html (start a local server, then open it)');

function shortDir(d) { return (d || '?').slice(0, 2).toUpperCase(); }
