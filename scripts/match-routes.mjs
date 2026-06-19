// match-routes.mjs
//
// Road-matching build, step 1. Normalize every route onto the OSM road network
// so the line follows the actual road, smoothly, and coincident routes share
// EXACT geometry (the road's own vertices). This replaces the noisy-GPS basis the
// earlier disambiguation work was built on. See CLAUDE.md rung 1.5.
//
// Method (simplest that works, evaluated before adding anything heavier):
//   1. Build road "ways" from osm-src/roads.json (Overpass), projected to meters.
//   2. Resample each route, snap every point to the nearest road (bearing-filtered).
//   3. Group consecutive points by the road they snapped to. Rebuild each route's
//      geometry from each road's own vertices over the stretch it covered, so two
//      routes on the same road get identical geometry there.
//   4. Where no road matches (transit center loops, lots), keep the raw shape so
//      the route stays continuous.
//
// Output: data/routes-matched-debug.geojson (gitignored, regenerable). View with
// match-preview.html. Does NOT touch the deployed map yet (that is step 2).
//
// Usage: node scripts/match-routes.mjs   (needs osm-src/roads.json)

import { readFileSync, writeFileSync } from 'node:fs';
import { toM, toLngLat, dist, bearing, bearingDelta, resample } from './lib-corridors.mjs';

const SNAP_TOL = 25;     // m: farthest a route point can be from a road and still match it
const BEARING_TOL = 35;  // deg (mod 180): road must run roughly the route's direction
const SPACING = 12;      // m: route resample step
const MIN_RUN_PTS = 3;   // matched runs shorter than this are treated as gaps (blips)
const GRID = 30;         // m: spatial grid cell for candidate roads

// --- Roads -------------------------------------------------------------------

const osm = JSON.parse(readFileSync('osm-src/roads.json', 'utf8'));
const ways = [];
for (const e of osm.elements) {
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
  const coords = e.geometry.map((p) => toM([p.lon, p.lat]));
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  ways.push({ coords, cum, len: cum[cum.length - 1] });
}

// Spatial grid: sample each road every <=GRID meters so any point near a road
// finds it in its own cell's 3x3 neighborhood.
const cellKey = (x, y) => `${Math.floor(x / GRID)},${Math.floor(y / GRID)}`;
const grid = new Map();
ways.forEach((w, wi) => {
  for (let i = 0; i < w.coords.length - 1; i++) {
    const a = w.coords[i];
    const b = w.coords[i + 1];
    const steps = Math.max(1, Math.ceil(dist(a, b) / GRID));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const k = cellKey(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      let set = grid.get(k);
      if (!set) grid.set(k, (set = new Set()));
      set.add(wi);
    }
  }
});

// Nearest point on a way: perpendicular foot. Returns distance, fraction along
// the way (0..1), and the local road bearing.
function pointToWay(p, w) {
  let best = { dist: Infinity, frac: 0, brg: 0 };
  for (let i = 0; i < w.coords.length - 1; i++) {
    const a = w.coords[i];
    const b = w.coords[i + 1];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) continue;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const fx = a[0] + t * vx;
    const fy = a[1] + t * vy;
    const d = Math.hypot(p[0] - fx, p[1] - fy);
    if (d < best.dist) best = { dist: d, frac: w.len ? (w.cum[i] + t * Math.sqrt(len2)) / w.len : 0, brg: bearing(a, b) };
  }
  return best;
}

// Snap a point (with travel bearing) to the best nearby road.
function snap(p, brg) {
  const cx = Math.floor(p[0] / GRID);
  const cy = Math.floor(p[1] / GRID);
  let best = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const set = grid.get(`${cx + dx},${cy + dy}`);
      if (!set) continue;
      for (const wi of set) {
        const pr = pointToWay(p, ways[wi]);
        if (pr.dist > SNAP_TOL) continue;
        if (bearingDelta(brg, pr.brg) > BEARING_TOL) continue;
        if (!best || pr.dist < best.dist) best = { wi, frac: pr.frac, dist: pr.dist };
      }
    }
  }
  return best;
}

function pointAtS(w, s) {
  s = Math.max(0, Math.min(w.len, s));
  let i = 0;
  while (i < w.cum.length - 2 && w.cum[i + 1] < s) i++;
  const a = w.coords[i];
  const b = w.coords[i + 1];
  const seg = (w.cum[i + 1] - w.cum[i]) || 1;
  const t = (s - w.cum[i]) / seg;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// The road's own vertices from fraction fA to fB, oriented fA -> fB. Two routes
// covering the same span emit identical points: this is the exact sharing.
function waySub(w, fA, fB) {
  const sA = fA * w.len;
  const sB = fB * w.len;
  const lo = Math.min(sA, sB);
  const hi = Math.max(sA, sB);
  const pts = [pointAtS(w, lo)];
  for (let i = 0; i < w.coords.length; i++) if (w.cum[i] > lo && w.cum[i] < hi) pts.push(w.coords[i]);
  pts.push(pointAtS(w, hi));
  if (sA > sB) pts.reverse();
  return pts;
}

// --- Match each route --------------------------------------------------------

const routes = JSON.parse(readFileSync('data/routes.geojson', 'utf8'));
const out = [];
let totalPts = 0;
let matchedPts = 0;

for (const f of routes.features) {
  const pts = resample(f.geometry.coordinates.map(toM), SPACING);
  const assign = pts.map((p) => snap([p.x, p.y], p.brg));
  totalPts += pts.length;
  matchedPts += assign.filter(Boolean).length;

  // Drop matched runs shorter than MIN_RUN_PTS (parallel-road blips); the raw
  // shape will bridge them.
  let i = 0;
  while (i < assign.length) {
    if (!assign[i]) { i++; continue; }
    let j = i;
    while (j < assign.length && assign[j] && assign[j].wi === assign[i].wi) j++;
    if (j - i < MIN_RUN_PTS) for (let k = i; k < j; k++) assign[k] = null;
    i = j;
  }

  // Rebuild geometry: road vertices over matched runs, raw points over gaps.
  const coords = [];
  i = 0;
  while (i < pts.length) {
    if (!assign[i]) {
      let j = i;
      while (j < pts.length && !assign[j]) j++;
      for (let k = i; k < j; k++) coords.push(toLngLat([pts[k].x, pts[k].y]));
      i = j;
    } else {
      const wi = assign[i].wi;
      let j = i;
      while (j < pts.length && assign[j] && assign[j].wi === wi) j++;
      for (const q of waySub(ways[wi], assign[i].frac, assign[j - 1].frac)) coords.push(toLngLat(q));
      i = j;
    }
  }

  out.push({
    type: 'Feature',
    properties: { routeId: f.properties.routeId, color: f.properties.color },
    geometry: { type: 'LineString', coordinates: coords },
  });
}

writeFileSync('data/routes-matched-debug.geojson', JSON.stringify({ type: 'FeatureCollection', features: out }));

console.log(`roads: ${ways.length} ways`);
console.log(`route points: ${totalPts}, snapped to a road: ${matchedPts} (${((100 * matchedPts) / totalPts).toFixed(1)}%)`);
console.log('wrote data/routes-matched-debug.geojson');
