// build-stringline.mjs
//
// Builds a string-line (Marey) dataset for one route from the accumulated GPS log:
// x = time, y = distance along the route, each trip a line. Slope = speed, flat =
// dwelling/stuck, lines converging = bunching, a missing line = a gap in service.
//
// Heavy parsing (the ~10 MB vehicle log) happens here, offline; the viewer
// (stringline.html) just renders the small JSON this writes.
//
// Usage:
//   node scripts/build-stringline.mjs            # auto-pick the busiest route, last 5h
//   node scripts/build-stringline.mjs 90         # route 90 (Silver Line)
//   node scripts/build-stringline.mjs 1 --hours 8
//
// Inputs:  data/vehicle-log.ndjson, data/routes-final.geojson
// Output:  data/stringline.json (gitignored) -> stringline.html

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LOG = 'data/vehicle-log.ndjson';
const ROUTES = 'data/routes-final.geojson';
const OUT = 'data/stringline.json';
const M_PER_DEG = 111320, COS = Math.cos(42.96 * Math.PI / 180);

const args = process.argv.slice(2);
const hoursArg = args.indexOf('--hours');
const HOURS = hoursArg > -1 ? Number(args[hoursArg + 1]) || 5 : 5;
let wantRoute = args.find(a => a !== '--hours' && a !== String(HOURS)) || null;

if (!existsSync(LOG)) { console.error(`no log at ${LOG}`); process.exit(1); }

// ── route geometry: reference polyline (longest piece if MultiLineString) ────
const geo = JSON.parse(readFileSync(ROUTES, 'utf8'));
const routeFeat = {};
for (const f of geo.features) { if (!f.properties.kind) routeFeat[String(f.properties.routeId)] = f; }

function refLine(feat) {
  const g = feat.geometry;
  const pieces = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
  let best = pieces[0], bestLen = -1;
  for (const p of pieces) { const L = lineLen(p); if (L > bestLen) { bestLen = L; best = p; } }
  return best;
}
function segM(a, b) { return Math.hypot((a[0]-b[0])*COS*M_PER_DEG, (a[1]-b[1])*M_PER_DEG); }
function lineLen(c) { let L = 0; for (let i = 1; i < c.length; i++) L += segM(c[i-1], c[i]); return L; }

// distance-along: snap p to the polyline, return meters from the start
function makeSnap(line) {
  const cum = [0]; for (let i = 1; i < line.length; i++) cum[i] = cum[i-1] + segM(line[i-1], line[i]);
  return (p) => {
    const px = p[0]*COS, py = p[1];
    let bestD2 = Infinity, bestS = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i-1], b = line[i];
      const ax = a[0]*COS, ay = a[1], bx = b[0]*COS, by = b[1];
      const dx = bx-ax, dy = by-ay, len2 = dx*dx + dy*dy;
      let t = len2 ? ((px-ax)*dx + (py-ay)*dy)/len2 : 0; t = Math.max(0, Math.min(1, t));
      const ex = px-(ax+dx*t), ey = py-(ay+dy*t), d2 = ex*ex + ey*ey;
      if (d2 < bestD2) { bestD2 = d2; bestS = cum[i-1] + t * segM(a, b); }
    }
    return { s: bestS, d2: bestD2 };
  };
}

// ── pick route (busiest in window if not given) ─────────────────────────────
const now = Date.now(), t0 = now - HOURS * 3600 * 1000;
const lines = readFileSync(LOG, 'utf8').split('\n');
if (!wantRoute) {
  const trips = {};
  for (const ln of lines) { if (!ln) continue; let r; try { r = JSON.parse(ln); } catch { continue; }
    if (r.fixTime < t0) continue; (trips[r.routeId] = trips[r.routeId] || new Set()).add(r.tripId); }
  wantRoute = Object.entries(trips).sort((a,b) => b[1].size - a[1].size)[0]?.[0];
}
wantRoute = String(wantRoute);
if (!routeFeat[wantRoute]) { console.error(`route ${wantRoute} not in routes-final`); process.exit(1); }

const line = refLine(routeFeat[wantRoute]);
const snap = makeSnap(line);
const totalM = lineLen(line);
const SNAP_MAX2 = (150 / M_PER_DEG) ** 2; // ignore points >150 m off the reference line

// ── build per-trip (t, s) series ────────────────────────────────────────────
const byTrip = new Map();
for (const ln of lines) {
  if (!ln) continue; let r; try { r = JSON.parse(ln); } catch { continue; }
  if (String(r.routeId) !== wantRoute || r.fixTime < t0 || r.lat == null) continue;
  const sn = snap([r.lon, r.lat]);
  if (sn.d2 > SNAP_MAX2) continue;
  const k = String(r.tripId);
  if (!byTrip.has(k)) byTrip.set(k, { trip: k, dir: r.dir || '?', pts: [] });
  byTrip.get(k).pts.push([r.fixTime, Math.round(sn.s)]);
}
const trips = [];
for (const tr of byTrip.values()) {
  tr.pts.sort((a, b) => a[0] - b[0]);
  const sRange = Math.max(...tr.pts.map(p => p[1])) - Math.min(...tr.pts.map(p => p[1]));
  if (tr.pts.length >= 4 && sRange > totalM * 0.1) trips.push(tr); // real runs only
}
trips.sort((a, b) => a.pts[0][0] - b.pts[0][0]);

const out = {
  route: wantRoute,
  color: routeFeat[wantRoute].properties.color || '#888',
  lengthM: Math.round(totalM),
  hours: HOURS,
  t0, t1: now,
  trips,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`route ${wantRoute}: ${trips.length} trips over last ${HOURS}h, ref line ${(totalM/1000).toFixed(1)} km`);
console.log(`dirs: ${[...new Set(trips.map(t => t.dir))].join(', ')}`);
console.log(`wrote ${OUT} -> open stringline.html`);
