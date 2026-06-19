// spike-division.mjs
//
// SPIKE (throwaway) for the road-normalization approach. Question it answers:
// if we snap the routes that run on Division Avenue onto the actual OSM road
// centerline, do we get clean, shared, road-following geometry that spreads into
// tidy parallel ribbons? If yes, normalizing routes to roads is the right
// foundation to rebuild on (and the noisy-GPS disambiguation becomes trivial).
//
// Not production. Division only. Output is for the spike-division.html preview.
//
// Pipeline:
//   1. Merge the OSM "Division Avenue ..." ways into one ordered centerline.
//   2. Find the bus routes whose shape hugs that centerline (on Division).
//   3. Snap each such route's Division portion onto the shared centerline and
//      offset it into its own lane (clean parallel spread of a smooth road line).
//   4. Emit the centerline, the raw GPS portions, and the snapped/spread portions
//      so the preview can show noise vs clean side by side.
//
// Usage: node scripts/spike-division.mjs   (needs osm-src/roads.json, see fetch in chat)

import { readFileSync, writeFileSync } from 'node:fs';
import { toM, toLngLat, dist, bearing, bearingDelta } from './lib-corridors.mjs';

const OUT = 'data/spike-division-debug.geojson';
const ON_ROAD_TOL = 22;     // a route point this close to the centerline (m) counts as on Division
const ON_ROAD_BEARING = 30; // and roughly aligned with it (deg, mod 180)
const MIN_RUN = 250;        // ignore brief crossings shorter than this (m)
const LANE_WIDTH = 8;

// --- 1. Merge Division ways into one ordered centerline -----------------------

const osm = JSON.parse(readFileSync('osm-src/roads.json', 'utf8'));
const divWays = osm.elements.filter(
  (e) => e.type === 'way' && e.tags && /^Division Avenue/.test(e.tags.name || '')
);

// Chain ways head-to-tail by shared endpoint coordinates. OSM shares node coords
// exactly, so endpoints match as strings. Greedy: grow one chain from both ends.
const key = (pt) => `${pt.lat},${pt.lon}`;
const segs = divWays.map((w) => w.geometry.map((p) => [p.lon, p.lat]));

function mergeChains(segments) {
  const used = new Array(segments.length).fill(false);
  const ends = new Map(); // endpoint key -> [{i, end}]
  segments.forEach((s, i) => {
    for (const end of [0, s.length - 1]) {
      const k = `${s[end][0]},${s[end][1]}`;
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ i, end });
    }
  });
  const chains = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = segments[i].slice();
    // extend from the tail, then the head
    for (const dir of ['tail', 'head']) {
      let grew = true;
      while (grew) {
        grew = false;
        const tip = dir === 'tail' ? chain[chain.length - 1] : chain[0];
        const cands = ends.get(`${tip[0]},${tip[1]}`) || [];
        for (const { i: j, end } of cands) {
          if (used[j]) continue;
          let s = segments[j].slice();
          if (end === (chain.length ? (dir === 'tail' ? 0 : s.length - 1) : 0)) {
            // orient so the matching endpoint joins the tip
          }
          // make s start at the shared tip
          if (`${s[0][0]},${s[0][1]}` !== `${tip[0]},${tip[1]}`) s.reverse();
          if (`${s[0][0]},${s[0][1]}` !== `${tip[0]},${tip[1]}`) continue;
          used[j] = true;
          if (dir === 'tail') chain = chain.concat(s.slice(1));
          else chain = s.slice(0, -1).reverse().concat(chain);
          grew = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

let chains = mergeChains(segs).sort((a, b) => b.length - a.length);
// Keep the dominant chain as the Division centerline (projected to meters).
const centerline = chains[0].map(toM);

// Cumulative along-distance and a projector onto the centerline.
const cum = [0];
for (let i = 1; i < centerline.length; i++) cum.push(cum[i - 1] + dist(centerline[i - 1], centerline[i]));
const totalLen = cum[cum.length - 1];

// Project point p onto the centerline: nearest perpendicular foot. Returns the
// along-distance s and the perpendicular distance.
function projectToCenterline(p) {
  let best = { d2: Infinity, s: 0 };
  for (let i = 0; i < centerline.length - 1; i++) {
    const a = centerline[i];
    const b = centerline[i + 1];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) continue;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const fx = a[0] + t * vx;
    const fy = a[1] + t * vy;
    const d2 = (p[0] - fx) ** 2 + (p[1] - fy) ** 2;
    if (d2 < best.d2) best = { d2, s: cum[i] + Math.sqrt(t * t * len2) };
  }
  return { s: best.s, dist: Math.sqrt(best.d2) };
}

// Centerline point + unit direction at along-distance s.
function atDistance(s) {
  s = Math.max(0, Math.min(totalLen, s));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const a = centerline[i];
  const b = centerline[i + 1];
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (s - cum[i]) / seg;
  const dx = (b[0] - a[0]) / seg;
  const dy = (b[1] - a[1]) / seg;
  return { pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: [dx, dy] };
}

// --- 2. Find the routes that run on Division ----------------------------------

const routes = JSON.parse(readFileSync('data/routes.geojson', 'utf8'));
const centerlineBearing = (s) => {
  const d = atDistance(s).dir;
  return (Math.atan2(d[0], d[1]) * 180) / Math.PI;
};

// For each route, mark points that sit on Division (close + aligned), then keep
// maximal runs longer than MIN_RUN. Returns { routeId, color, sStart, sEnd }.
const onDivision = [];
for (const f of routes.features) {
  const pts = f.geometry.coordinates.map(toM);
  const flags = pts.map((p, i) => {
    const pr = projectToCenterline(p);
    if (pr.dist > ON_ROAD_TOL) return null;
    const nb = i < pts.length - 1 ? bearing(p, pts[i + 1]) : bearing(pts[i - 1], p);
    if (bearingDelta(nb, centerlineBearing(pr.s)) > ON_ROAD_BEARING) return null;
    return pr.s;
  });
  // maximal runs of non-null
  let runStart = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i] != null;
    if (on && runStart < 0) runStart = i;
    if (!on && runStart >= 0) {
      const ss = flags.slice(runStart, i).filter((v) => v != null);
      const sMin = Math.min(...ss);
      const sMax = Math.max(...ss);
      if (sMax - sMin >= MIN_RUN) {
        onDivision.push({ routeId: f.properties.routeId, color: f.properties.color, sStart: sMin, sEnd: sMax, raw: pts.slice(runStart, i) });
      }
      runStart = -1;
    }
  }
}

// Lane order: by route id, deduped (a route may have two directions on Division).
const laneRoutes = [...new Set(onDivision.map((r) => r.routeId))].sort((a, b) => Number(a) - Number(b));

// --- 3. Snap + spread, and 4. emit --------------------------------------------

function subPath(s0, s1) {
  const out = [atDistance(s0).pt];
  for (let i = 0; i < centerline.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(centerline[i]);
  out.push(atDistance(s1).pt);
  return out;
}

const features = [];

// the merged centerline itself (debug reference)
features.push({
  type: 'Feature',
  properties: { kind: 'centerline' },
  geometry: { type: 'LineString', coordinates: centerline.map(toLngLat) },
});

for (const r of onDivision) {
  // raw GPS portion (noise reference)
  features.push({
    type: 'Feature',
    properties: { kind: 'raw', routeId: r.routeId, color: r.color },
    geometry: { type: 'LineString', coordinates: r.raw.map(toLngLat) },
  });

  // snapped + spread: clip the shared centerline, offset into this route's lane
  const lane = laneRoutes.indexOf(r.routeId);
  const offsetIndex = lane - (laneRoutes.length - 1) / 2;
  const offset = offsetIndex * LANE_WIDTH;
  const path = subPath(r.sStart, r.sEnd).map((pt) => {
    const { s } = projectToCenterline(pt);
    const dir = atDistance(s).dir;
    // right-perpendicular of the unit direction
    const px = dir[1];
    const py = -dir[0];
    return toLngLat([pt[0] + offset * px, pt[1] + offset * py]);
  });
  features.push({
    type: 'Feature',
    properties: { kind: 'spread', routeId: r.routeId, color: r.color },
    geometry: { type: 'LineString', coordinates: path },
  });
}

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));

console.log(`Division ways: ${divWays.length}, merged chains: ${chains.length}, centerline length: ${Math.round(totalLen)} m`);
console.log(`routes on Division (runs >= ${MIN_RUN}m): ${onDivision.length}, distinct: ${laneRoutes.join(', ')}`);
console.log(`wrote ${OUT}`);
