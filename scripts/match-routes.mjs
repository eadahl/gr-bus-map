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
const SWITCH_PENALTY = 20; // m-equivalent cost to hop to a different corridor between
                           // consecutive points. Keeps a route on one road instead of
                           // flickering onto a parallel adjacent way; a real turn still
                           // switches because staying would cost far more.
const MERGE_TOL = 45;      // m: a route's two directions closer than this (and roughly
                           // antiparallel) are the same road -> draw one median line.
                           // Divided carriageways (~10-35 m apart) merge; one-way couplets
                           // a block apart stay as two legs.
const MERGE_PARALLEL = 45; // deg (mod 180): and within this of parallel, so we pair the
                           // return direction, not a crossing street at a self-intersection.

// --- Roads -------------------------------------------------------------------

const osm = JSON.parse(readFileSync('osm-src/roads.json', 'utf8'));

// Merge OSM ways into corridors BEFORE matching. OSM splits one street into many
// short way objects (Monroe Ave is 374 m + 206 m + 39 m + ...). If we match and
// rebuild per short way, each route's independently resampled run boundaries land
// in different spots, so routes on the same street end up only NEARLY coincident
// (a few meters of jitter) and render as a crossing band downtown. Chaining the
// ways of one road into a single continuous centerline first means routes share
// every interior vertex EXACTLY, so coincident routes collapse to one line. Same
// idea the Division spike validated, generalized to the whole network by name.
// Name is also the guard against chaining onto a cross street at a shared node.
const ekey = (pt) => `${pt[0]},${pt[1]}`;
function mergeChains(segments) {
  const used = new Array(segments.length).fill(false);
  const ends = new Map(); // endpoint key -> seg indices touching it
  segments.forEach((s, i) => {
    for (const pt of [s[0], s[s.length - 1]]) {
      const k = ekey(pt);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const grow = (chain, atHead) => {
    for (;;) {
      const tip = atHead ? chain[0] : chain[chain.length - 1];
      const j = (ends.get(ekey(tip)) || []).find((x) => !used[x]);
      if (j === undefined) break;
      let s = segments[j].slice();
      // orient s so it starts at the tip, then splice on the correct end
      if (atHead) {
        if (ekey(s[s.length - 1]) !== ekey(tip)) s.reverse();
        if (ekey(s[s.length - 1]) !== ekey(tip)) break;
        used[j] = true;
        chain = s.slice(0, -1).concat(chain);
      } else {
        if (ekey(s[0]) !== ekey(tip)) s.reverse();
        if (ekey(s[0]) !== ekey(tip)) break;
        used[j] = true;
        chain = chain.concat(s.slice(1));
      }
    }
    return chain;
  };
  const chains = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    chains.push(grow(grow(segments[i].slice(), false), true));
  }
  return chains;
}

const named = new Map(); // name -> [ [lon,lat], ... ] segments
const corridors = [];    // merged road centerlines, as [lon,lat] polylines
let rawWayCount = 0;
for (const e of osm.elements) {
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
  rawWayCount++;
  const seg = e.geometry.map((p) => [p.lon, p.lat]);
  const name = e.tags && e.tags.name;
  if (name) {
    if (!named.has(name)) named.set(name, []);
    named.get(name).push(seg);
  } else {
    corridors.push(seg); // unnamed connectors/ramps: leave as-is
  }
}
for (const segs of named.values()) for (const ch of mergeChains(segs)) corridors.push(ch);

const ways = corridors.map((poly) => {
  const coords = poly.map(toM);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  return { coords, cum, len: cum[cum.length - 1] };
});

// Roundabouts (junction=roundabout) as center + radius, projected. The Heritage
// Hill mini-circles make routes trace the ring; we straighten those passes later.
// Only small circles (radius < RB_MAX) qualify; big traffic circles are left alone.
const RB_MAX = 45;  // m: largest roundabout radius we collapse
const RB_TOL = 10;  // m: extra margin around the ring counted as "inside"
const roundabouts = [];
for (const e of osm.elements) {
  if (e.type !== 'way' || !e.geometry || !e.tags || e.tags.junction !== 'roundabout') continue;
  const pts = e.geometry.map((p) => toM([p.lon, p.lat]));
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const radius = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length;
  if (radius <= RB_MAX) roundabouts.push({ center: [cx, cy], radius });
}

// Straighten a route's pass through a roundabout: drop the ring-interior vertices,
// keeping the entry and exit so the line cuts across instead of tracing the circle.
function deRoundabout(pts) {
  if (pts.length < 3 || !roundabouts.length) return pts;
  const inside = pts.map((p) => roundabouts.some((r) => Math.hypot(p[0] - r.center[0], p[1] - r.center[1]) < r.radius + RB_TOL));
  const out = [];
  let i = 0;
  while (i < pts.length) {
    if (!inside[i]) { out.push(pts[i]); i++; continue; }
    let j = i;
    while (j < pts.length && inside[j]) j++;
    out.push(pts[i]);                  // entry
    if (j - 1 > i) out.push(pts[j - 1]); // exit (chord across the ring)
    i = j;
  }
  return out;
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

// All corridors a point could belong to: within tolerance and bearing-aligned.
// One entry per corridor, keeping its nearest foot (dist + fraction along).
function candidates(p, brg) {
  const cx = Math.floor(p[0] / GRID);
  const cy = Math.floor(p[1] / GRID);
  const byWi = new Map();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const set = grid.get(`${cx + dx},${cy + dy}`);
      if (!set) continue;
      for (const wi of set) {
        const pr = pointToWay(p, ways[wi]);
        if (pr.dist > SNAP_TOL) continue;
        if (bearingDelta(brg, pr.brg) > BEARING_TOL) continue;
        const e = byWi.get(wi);
        if (!e || pr.dist < e.dist) byWi.set(wi, { wi, frac: pr.frac, dist: pr.dist });
      }
    }
  }
  return [...byWi.values()];
}

// Connectivity-aware matching (Viterbi). The per-point nearest-edge choice is
// memoryless, so it flickers onto whichever parallel adjacent way is momentarily
// closest, and routes weave. Here each point's cost is its perpendicular distance
// to a corridor (RAW_EMIT if it matches none), and switching corridors between
// points costs SWITCH_PENALTY. The lowest-cost path stays on one road through the
// brief pulls of neighbors and only switches at genuine turns, where staying would
// cost far more. Returns per-point { wi, frac } or null (RAW / gap).
const RAW = -1;
const RAW_EMIT = SNAP_TOL + 1; // matching any in-tolerance corridor beats going RAW
function matchSeq(pts) {
  const cands = pts.map((p) => candidates([p.x, p.y], p.brg));
  const back = []; // per point: Map(state -> previous state)
  let prevCost = null; // Map(state -> best cost to reach it at the previous point)
  for (let i = 0; i < pts.length; i++) {
    const fracOf = new Map([[RAW, null]]);
    for (const c of cands[i]) fracOf.set(c.wi, c.frac);
    const emitOf = (wi) => (wi === RAW ? RAW_EMIT : cands[i].find((c) => c.wi === wi).dist);
    const curCost = new Map();
    const bk = new Map();
    for (const state of fracOf.keys()) {
      const emit = emitOf(state);
      if (i === 0) {
        curCost.set(state, emit);
        bk.set(state, null);
        continue;
      }
      let best = Infinity, bestPrev = null;
      for (const [pState, pc] of prevCost) {
        const cost = pc + (pState === state ? 0 : SWITCH_PENALTY) + emit;
        if (cost < best) { best = cost; bestPrev = pState; }
      }
      curCost.set(state, best);
      bk.set(state, bestPrev);
    }
    prevCost = curCost;
    back.push(bk);
  }
  // Backtrack from the cheapest final state.
  let state = null, bestC = Infinity;
  for (const [s, c] of prevCost) if (c < bestC) { bestC = c; state = s; }
  const assign = new Array(pts.length);
  for (let i = pts.length - 1; i >= 0; i--) {
    assign[i] = state === RAW ? null : { wi: state, frac: cands[i].find((c) => c.wi === state).frac };
    state = back[i].get(state);
  }
  return assign;
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

// --- Junction cleanup (rung 1.5 step 3) -------------------------------------
//
// The per-point nearest-edge matcher has no memory: at divided roads, roundabouts
// and interchanges a few points snap to a neighboring way, so the rebuilt line
// juts sideways and comes straight back. That reads as a short reversal spike
// (the path turns ~180 deg over a few meters). Real road corners turn at most ~90
// deg and real turnarounds travel far; a spike turns much harder and barely moves.
// So we collapse interior vertices that BOTH turn sharper than SPIKE_TURN AND sit
// less than SPIKE_MAX from the chord of their neighbors. Iterated, sharpest first,
// so multi-vertex backtracks unwind cleanly. Faithful to the road, not the GPS.
const SPIKE_TURN = 110;  // deg: turn sharper than this (0 = straight) is a spike candidate
const SPIKE_MAX = 20;    // m: only collapse spikes whose sideways excursion is under this
const DEDUPE_M = 2;      // m: drop consecutive vertices closer than this first

// Interior turn angle at b (0 = straight, 180 = full reversal), in degrees.
function turnDeg(a, b, c) {
  const v1x = b[0] - a[0], v1y = b[1] - a[1];
  const v2x = c[0] - b[0], v2y = c[1] - b[1];
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  if (l1 === 0 || l2 === 0) return 0;
  let cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

// Perpendicular distance from p to segment a-b (meters): how far the spike juts.
function perpDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

// Take projected-meter coords, return them with near-duplicates and reversal
// spikes removed. Pure geometry: never moves a vertex, only drops jitter.
function cleanup(pts) {
  if (pts.length < 3) return pts;
  let out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) >= DEDUPE_M) out.push(pts[i]);
  }
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    let worstI = -1, worstTurn = SPIKE_TURN;
    for (let i = 1; i < out.length - 1; i++) {
      const t = turnDeg(out[i - 1], out[i], out[i + 1]);
      if (t > worstTurn && perpDist(out[i], out[i - 1], out[i + 1]) < SPIKE_MAX) {
        worstTurn = t;
        worstI = i;
      }
    }
    if (worstI >= 0) { out.splice(worstI, 1); changed = true; }
  }
  return out;
}

// --- Direction merge (rung 1.5 step 3c) -------------------------------------
//
// Each route is stored as two features, the two travel directions. On a normal
// two-way street they snap to the same corridor and already coincide; on a DIVIDED
// road (separate one-way carriageways, e.g. Jefferson) they land on the two
// carriageways ~10-35 m apart and visibly weave. We collapse a route to ONE line:
// where the two directions run close and antiparallel, draw the median between
// them; where they genuinely split onto different streets (a one-way couplet a
// block apart), keep both legs. Operates on the matched direction-lines, so no
// carriageway detection in the road network is needed.

// Nearest perpendicular foot of p on polyline B: distance, foot point, local bearing.
function nearestOnPolyline(p, B) {
  let best = { dist: Infinity, point: p, brg: 0 };
  for (let i = 0; i < B.length - 1; i++) {
    const a = B[i], b = B[i + 1];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) continue;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const fx = a[0] + t * vx, fy = a[1] + t * vy;
    const d = Math.hypot(p[0] - fx, p[1] - fy);
    if (d < best.dist) best = { dist: d, point: [fx, fy], brg: bearing(a, b) };
  }
  return best;
}

const localBrg = (P, i) => bearing(P[Math.max(0, i - 1)], P[Math.min(P.length - 1, i + 1)]);

// Is vertex i of P paired with the other direction Q (close + roughly parallel)?
const pairedTo = (P, i, Q) => {
  const np = nearestOnPolyline(P[i], Q);
  return np.dist < MERGE_TOL && bearingDelta(localBrg(P, i), np.brg) < MERGE_PARALLEL ? np : null;
};

// Merge two direction polylines (meters) into route parts: A becomes one line that
// runs down the median where paired and along A where solo; B contributes only the
// stretches that had no A to pair with (the couplet's other leg).
function mergeDirections(A, B) {
  if (A.length < 2) return B.length >= 2 ? [B] : [];
  if (B.length < 2) return [A];
  const aLine = A.map((p, i) => {
    const np = pairedTo(A, i, B);
    return np ? [(p[0] + np.point[0]) / 2, (p[1] + np.point[1]) / 2] : p;
  });
  const parts = [aLine];
  let j = 0;
  while (j < B.length) {
    if (pairedTo(B, j, A)) { j++; continue; }
    let k = j;
    while (k < B.length && !pairedTo(B, k, A)) k++;
    if (k - j >= 2) parts.push(B.slice(j, k));
    j = k;
  }
  return parts;
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
const byRoute = new Map(); // routeId -> { color, dirs: [meterCoords, ...] }
let totalPts = 0;
let matchedPts = 0;
let vertsBefore = 0;
let vertsAfter = 0;

for (const f of routes.features) {
  const pts = resample(f.geometry.coordinates.map(toM), SPACING);
  const assign = matchSeq(pts);
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

  // Rebuild geometry in meters: road vertices over matched runs, raw points over
  // gaps. Then collapse junction spikes before converting back to lng/lat.
  const meters = [];
  i = 0;
  while (i < pts.length) {
    if (!assign[i]) {
      let j = i;
      while (j < pts.length && !assign[j]) j++;
      for (let k = i; k < j; k++) meters.push([pts[k].x, pts[k].y]);
      i = j;
    } else {
      const wi = assign[i].wi;
      let j = i;
      while (j < pts.length && assign[j] && assign[j].wi === wi) j++;
      for (const q of waySub(ways[wi], assign[i].frac, assign[j - 1].frac)) meters.push(q);
      i = j;
    }
  }
  const cleaned = cleanup(meters);
  vertsBefore += meters.length;
  vertsAfter += cleaned.length;

  out.push({
    type: 'Feature',
    properties: { routeId: f.properties.routeId, color: f.properties.color },
    geometry: { type: 'LineString', coordinates: cleaned.map(toLngLat) },
  });

  // Keep the meter-space geometry per route so the two directions can be merged.
  const key = f.properties.routeId;
  if (!byRoute.has(key)) byRoute.set(key, { color: f.properties.color, dirs: [] });
  byRoute.get(key).dirs.push(cleaned);
}

writeFileSync('data/routes-matched-debug.geojson', JSON.stringify({ type: 'FeatureCollection', features: out }));

// Collapse each route's two directions into one line (median where they coincide,
// both legs where they split). One feature per route, MultiLineString of parts.
const merged = [];
for (const [routeId, { color, dirs }] of byRoute) {
  const parts = (dirs.length === 2 ? mergeDirections(dirs[0], dirs[1]) : dirs)
    .map((p) => cleanup(deRoundabout(p)))
    .filter((p) => p.length >= 2)
    .map((p) => p.map(toLngLat));
  if (!parts.length) continue;
  merged.push({
    type: 'Feature',
    properties: { routeId, color },
    geometry: parts.length === 1
      ? { type: 'LineString', coordinates: parts[0] }
      : { type: 'MultiLineString', coordinates: parts },
  });
}

writeFileSync('data/routes-merged-debug.geojson', JSON.stringify({ type: 'FeatureCollection', features: merged }));

console.log(`roads: ${rawWayCount} OSM ways merged into ${ways.length} corridors`);
console.log(`route points: ${totalPts}, snapped to a road: ${matchedPts} (${((100 * matchedPts) / totalPts).toFixed(1)}%)`);
console.log(`junction cleanup: ${vertsBefore} -> ${vertsAfter} vertices (${vertsBefore - vertsAfter} spikes/dupes removed)`);
console.log(`direction merge: ${out.length} direction-lines -> ${merged.length} per-route lines`);
console.log('wrote data/routes-matched-debug.geojson and data/routes-merged-debug.geojson');
