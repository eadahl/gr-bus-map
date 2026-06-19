// detect-corridors.mjs
//
// Rung 1 of route disambiguation: COINCIDENCE DETECTION (debug only).
//
// The downtown knot and Division Ave fail under casing alone: many routes share
// one centerline, so the top line hides the rest. Before we can spread those
// lines into parallel ribbons (rung 2), we have to DETECT where routes actually
// run together. The crux (see CLAUDE.md): bus GTFS shapes are noisy and do NOT
// share exact coordinates even on the same street, so coincidence must be found
// with tolerance, not by matching coordinates.
//
// What this does:
//   1. Project every route line to local meters (planar math is exact enough at
//      city scale and far simpler than spherical).
//   2. Resample each line to evenly spaced points, each carrying a local bearing.
//   3. Drop all points into a spatial grid.
//   4. For each point, count how many DISTINCT routes pass within tolerance with
//      a compatible bearing (parallel or antiparallel, since the two directions
//      of a corridor run opposite ways). That count is the corridor multiplicity.
//   5. Merge consecutive same-count points back into segments and write them out.
//
// Output: data/corridors-debug.geojson, one feature per segment, carrying:
//   count  - how many distinct routes share that spot (1 = solo, >=2 = bundled)
//   routes - the distinct route ids sharing the run
//   color  - the owning route's real color (so the debug view can fall back to it)
//
// This does NOT touch data/routes.geojson or the deployed map. View it with
// debug-corridors.html.
//
// Usage: node scripts/detect-corridors.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const IN = 'data/routes.geojson';
const OUT = 'data/corridors-debug.geojson';

// Tuning. Grand Rapids downtown blocks are ~100m, streets ~15-30m wide, and
// GTFS shape points wander a few meters off the true centerline. These values
// catch two routes on the same street (even opposite sides) without merging
// genuinely separate parallel streets.
const SPACING = 12;      // resample step, meters
const TOL = 18;          // two points this close (meters) may be the same corridor
const BEARING_TOL = 25;  // and headings within this many degrees (mod 180)

// Local equirectangular projection. One reference latitude for the whole city
// keeps east/west and north/south scaling consistent. Good to well under a meter
// across Grand Rapids.
const LAT0 = 42.96;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const toM = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
const toLngLat = ([x, y]) => [x / M_PER_DEG_LON, y / M_PER_DEG_LAT];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Bearing of the segment a->b, degrees clockwise from north. Only used to tell
// "same street" from "crossing street", so exact convention does not matter as
// long as it is consistent.
function bearing(a, b) {
  const deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// Smallest angle between two bearings, folded to [0,90]. Folding at 180 makes a
// heading and its reverse equivalent, so the outbound and inbound directions of
// the same corridor read as parallel.
function bearingDelta(a, b) {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

// Walk a projected polyline and emit points every SPACING meters, each tagged
// with the bearing of the segment it sits on. Short leftover tails are dropped;
// at 12m spacing that loses nothing that matters for corridor detection.
function resample(coords) {
  const out = [];
  if (coords.length < 2) return out;
  let carry = 0; // distance already covered toward the next sample
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = dist(a, b);
    if (segLen === 0) continue;
    const brg = bearing(a, b);
    const ux = (b[0] - a[0]) / segLen;
    const uy = (b[1] - a[1]) / segLen;
    // Place samples along this segment, accounting for the carry from the last.
    let d = -carry;
    while (d + SPACING <= segLen) {
      d += SPACING;
      out.push({ x: a[0] + ux * d, y: a[1] + uy * d, brg });
    }
    carry = segLen - d;
  }
  return out;
}

const data = JSON.parse(readFileSync(IN, 'utf8'));

// Build the resampled point set for every feature, then index every point in one
// shared spatial grid so neighbor lookups are local, not O(n^2) across the city.
const CELL = TOL; // a TOL-sized grid means a 3x3 neighborhood covers the radius
const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
const grid = new Map();
const lines = []; // per feature: { routeId, color, pts: [{x,y,brg}] }

for (const f of data.features) {
  const coords = f.geometry.coordinates.map(toM);
  const pts = resample(coords);
  const line = { routeId: f.properties.routeId, color: f.properties.color, pts };
  const li = lines.push(line) - 1;
  pts.forEach((p, pi) => {
    const k = cellKey(p.x, p.y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ li, pi });
    p.routes = null; // filled in the counting pass
  });
}

// Counting pass. For each point, gather candidates from its cell and the eight
// around it, keep those within TOL and bearing-compatible, and collect the set
// of distinct route ids present (including the point's own route).
const NEIGHBORS = [-1, 0, 1];
for (let li = 0; li < lines.length; li++) {
  const line = lines[li];
  for (let pi = 0; pi < line.pts.length; pi++) {
    const p = line.pts[pi];
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    const routes = new Set([line.routeId]);
    for (const dx of NEIGHBORS) {
      for (const dy of NEIGHBORS) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const { li: oli, pi: opi } of bucket) {
          if (oli === li) continue;
          const other = lines[oli];
          if (other.routeId === line.routeId) continue; // a route never bundles with itself
          const q = other.pts[opi];
          if (dist(p, q) > TOL) continue;
          if (bearingDelta(p.brg, q.brg) > BEARING_TOL) continue;
          routes.add(other.routeId);
        }
      }
    }
    p.routes = routes;
  }
}

// Emit one feature per maximal run of consecutive points with the same count.
// The run's `routes` is the union over the run (counts can flicker point to
// point; the union is the honest "who is in this corridor" answer).
const features = [];
for (const line of lines) {
  const pts = line.pts;
  if (pts.length < 2) continue;
  let runStart = 0;
  const flush = (end) => {
    // segment from runStart..end inclusive
    if (end <= runStart) return;
    const slice = pts.slice(runStart, end + 1);
    const union = new Set();
    let maxCount = 0;
    for (const p of slice) {
      maxCount = Math.max(maxCount, p.routes.size);
      for (const r of p.routes) union.add(r);
    }
    features.push({
      type: 'Feature',
      properties: {
        routeId: line.routeId,
        color: line.color,
        count: maxCount,
        routes: [...union].sort(),
      },
      geometry: {
        type: 'LineString',
        coordinates: slice.map((p) => toLngLat([p.x, p.y])),
      },
    });
  };
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].routes.size !== pts[i - 1].routes.size) {
      flush(i - 1);
      runStart = i - 1; // overlap by one point so segments visually connect
    }
  }
  flush(pts.length - 1);
}

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));

// Report: a histogram of how much route-length sits at each multiplicity, and
// the single busiest corridor point, so the detection can be sanity-checked
// against the map (Division Ave and the downtown knot should top the list).
const meters = {}; // count -> total meters
let busiest = { count: 0, lngLat: null, routes: [] };
for (const line of lines) {
  for (let i = 1; i < line.pts.length; i++) {
    const c = line.pts[i].routes.size;
    meters[c] = (meters[c] || 0) + SPACING;
    if (c > busiest.count) {
      busiest = {
        count: c,
        lngLat: toLngLat([line.pts[i].x, line.pts[i].y]).map((n) => n.toFixed(5)),
        routes: [...line.pts[i].routes].sort(),
      };
    }
  }
}

console.log(`features in:  ${data.features.length} route lines`);
console.log(`segments out: ${features.length}`);
console.log('multiplicity histogram (route-meters at each shared count):');
for (const c of Object.keys(meters).map(Number).sort((a, b) => a - b)) {
  const bar = '#'.repeat(Math.round(meters[c] / 1000));
  console.log(`  ${String(c).padStart(2)} routes: ${String(Math.round(meters[c])).padStart(6)} m  ${bar}`);
}
console.log(`busiest point: ${busiest.count} routes at [${busiest.lngLat}], routes ${busiest.routes.join(', ')}`);
console.log(`wrote ${OUT}`);
