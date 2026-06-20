// spread-routes.mjs
//
// Rung 2 of route disambiguation, first cut: BASELINE SPREAD PREVIEW (debug only).
//
// Rung 1 found where routes run coincident. This takes that and pushes each route
// in a bundle sideways into its own parallel lane, so stacked lines separate into
// ribbons instead of the top one hiding the rest. This is the NYC-style move.
//
// Baseline, deliberately simple, so we can SEE where it breaks before refining:
//   - Lane order within a bundle: route id ascending. Deterministic, not yet
//     crossing-aware (that is rung 2b).
//   - Offset axis: perpendicular to the corridor, folded at 180 degrees so the
//     two travel directions of one street share an axis and offset consistently.
//   - Offset is baked in METERS, centered on the original centerline. Fixed ground
//     distance, so it reads when zoomed in and fades when zoomed out.
//
// Known rough edges this preview is meant to expose (do not fix here):
//   - Abrupt sideways jump where a route enters or leaves a bundle (no ramp yet).
//   - Wobble where a street runs near due north (the folded axis flips sides).
//   - The downtown knot: ~19 routes through one station cannot splay into 19
//     parallel lanes without distorting geography. Hub-and-spoke is not a trunk.
//
// Output: data/routes-spread-debug.geojson (gitignored, regenerable). View with
// spread-preview.html. Does NOT touch data/routes.geojson, build-routes.mjs, or
// the deployed map.
//
// Usage: node scripts/spread-routes.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { detectCoincidence, toLngLat, toM } from './lib-corridors.mjs';

// Input/output default to the raw routes, but accept overrides so the same
// spreader can run on road-matched geometry:
//   node scripts/spread-routes.mjs data/routes-matched-debug.geojson data/routes-matched-spread-debug.geojson
const IN = process.argv[2] || 'data/routes.geojson';
const OUT = process.argv[3] || 'data/routes-spread-debug.geojson';

// Gap between adjacent lanes, meters. Tunable. Large enough to read when zoomed
// to the knot, small enough that bundles do not splay across whole blocks.
const LANE_WIDTH = 8;

// Hubs: points where many routes converge on a single transit center. Spreading
// them into parallel lanes would splay one station across a whole block, which is
// false to how the system works. Instead we taper each route's offset to zero
// near a hub, so the routes converge to the station the way they actually do, and
// spread only along the approach corridors. Hand-placed (algorithm proposes,
// human disposes); this one is Rapid Central Station, the 19-route knot the
// detector flagged as the busiest point. rInner: full convergence inside this
// radius (m). rOuter: full spread beyond it. Smooth ramp between.
const HUBS = [
  { lngLat: [-85.67253, 42.95795], rInner: 70, rOuter: 230 },
].map((h) => ({ center: toM(h.lngLat), rInner: h.rInner, rOuter: h.rOuter }));

const DEG = Math.PI / 180;
const smoothstep = (t) => t * t * (3 - 2 * t);

// 0 at a hub center (converge to the station), 1 well outside it (full spread),
// a smooth ramp between. Multiplies the lane offset.
function hubTaper(x, y) {
  let f = 1;
  for (const h of HUBS) {
    const d = Math.hypot(x - h.center[0], y - h.center[1]);
    const t = d <= h.rInner ? 0
      : d >= h.rOuter ? 1
      : smoothstep((d - h.rInner) / (h.rOuter - h.rInner));
    f = Math.min(f, t);
  }
  return f;
}

const data = JSON.parse(readFileSync(IN, 'utf8'));

// Merged per-route geometry stores split sections (one-way couplet legs) as a
// MultiLineString. Spread each section independently, so flatten to one LineString
// pseudo-feature per part, keeping the route id and color.
const flat = [];
for (const f of data.features) {
  if (f.geometry.type === 'MultiLineString') {
    for (const part of f.geometry.coordinates) {
      flat.push({ ...f, geometry: { type: 'LineString', coordinates: part } });
    }
  } else {
    flat.push(f);
  }
}
const { lines } = detectCoincidence(flat);

let maxSpread = 0; // widest bundle seen, meters (knot diagnostic)

const features = [];
for (const line of lines) {
  const pts = line.pts;
  if (pts.length < 2) continue;

  const coords = pts.map((p) => {
    const members = [...p.routes].sort((a, b) => Number(a) - Number(b));
    const n = members.length;
    const lane = members.indexOf(line.routeId);
    // Center the bundle on the original centerline: lanes run from
    // -(n-1)/2 .. +(n-1)/2 so a solo point (n=1) gets offset 0.
    const offsetIndex = lane - (n - 1) / 2;
    const offset = offsetIndex * LANE_WIDTH * hubTaper(p.x, p.y);
    if (n > 1) maxSpread = Math.max(maxSpread, (n - 1) * LANE_WIDTH * hubTaper(p.x, p.y));

    // Perpendicular to the corridor axis. Fold the bearing at 180 so both travel
    // directions of one street share an axis and the same lane lands on the same
    // physical side. Heading (cw from north) -> right-perpendicular (east,north).
    const axis = (p.brg % 180) * DEG;
    const px = Math.cos(axis);
    const py = -Math.sin(axis);
    return toLngLat([p.x + offset * px, p.y + offset * py]);
  });

  features.push({
    type: 'Feature',
    properties: { routeId: line.routeId, color: line.color },
    geometry: { type: 'LineString', coordinates: coords },
  });
}

// Draw longer lines first so shorter ones layer on top, matching build-routes.mjs.
features.sort((a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length);

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));

console.log(`lane width: ${LANE_WIDTH} m`);
console.log(`spread features: ${features.length}`);
console.log(`widest bundle splay: ${Math.round(maxSpread)} m (downtown knot)`);
console.log(`wrote ${OUT}`);
