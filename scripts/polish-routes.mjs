// polish-routes.mjs
//
// The finish pass that runs AFTER Erik's hand structural edits (route-overrides.geojson).
// He sets which road / the order of routes / how they relate; this pass does the
// even, calm finish. Phases (smallest-risk first, each viewable):
//   0. STITCH the gaps. His geometry is one long main line plus disconnected couplet
//      legs / spurs. We KEEP every piece exactly as he drew it and add a short
//      connector bridge wherever a piece's endpoint sits near another piece (a real
//      junction), so the route reads as connected. Endpoints with nothing nearby are
//      route termini and stay open. Bounded by HIS geometry, so nothing is dropped.
//      (We tried re-threading along the original GTFS shape, but his routes can extend
//      beyond the original representative trip -- e.g. route 8 runs ~1.5 km past it --
//      and threading silently dropped those, so it is not safe.)
//   1. SMOOTH every line (gentle, shape and order preserved).
//   2. [next] Even the spacing between parallel lines, reading his lane order.
//   3. [next] Collapse the hub convergence to a clean station node + marker.
// See CLAUDE.md rung 1.5 step 4.
//
// Input:  data/route-overrides.geojson (hand-finished).
// Output: data/routes-polished-debug.geojson (gitignored, regenerable).
// Usage:  node scripts/polish-routes.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const OVERRIDES = 'data/route-overrides.geojson';
const OUT = 'data/routes-final.geojson'; // committed: the geometry the deployed map draws

const LAT0 = 42.96;
const MLAT = 110540;
const MLON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const toM = ([lo, la]) => [lo * MLON, la * MLAT];
const toLngLat = ([x, y]) => [x / MLON, y / MLAT];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const JOIN_TOL = 6;     // m: endpoints already this close count as joined (no bridge)
const MAX_BRIDGE = 120; // m: bridge an endpoint to the nearest other piece within this;
                        // farther than this it is treated as a route terminus (no bridge)
const SAMPLE = 6;       // m: density we sample pieces into for nearest-point lookup
const SMOOTH_ITER = 3;  // passes of 1-2-1 averaging

// Even-spacing params.
const LANE_WIDTH = 8;   // m: target gap between adjacent parallel routes
const SP_TOL = 28;      // m: two routes this close (and aligned) count as one bundle
const SP_BEARING = 28;  // deg (mod 180): and headings within this are "the same corridor"
const SP_SMOOTH = 10;   // passes to smooth the perpendicular shift (kills lane wobble)
// Hub: lane offsets taper to 0 inside the station so routes converge instead of
// splaying 19 lanes across a block. Hand-placed Rapid Central Station.
const HUB = toM([-85.67302, 42.95863]);
const HUB_INNER = 70, HUB_OUTER = 240;
// Hub "black box": a vertical rounded rectangle over the downtown tangle. Routes clip at
// its boundary; the outline + marker are drawn. Position/size hand-tuned by Erik in
// polish-preview.html (drag center to move, corner to resize), then baked here.
const ZONE_CENTER = toM([-85.67302, 42.95863]);
const ZONE_HALF_W = 111; // m: half-width (E-W); full 222 m
const ZONE_HALF_H = 217.5; // m: half-height (N-S); full 435 m
const ZONE_CR = Math.min(ZONE_HALF_W, ZONE_HALF_H) * 0.5; // corner radius
const HUB_LNGLAT = [-85.67302, 42.95863];
function inZone(p) {
  const dx = Math.abs(p[0] - ZONE_CENTER[0]), dy = Math.abs(p[1] - ZONE_CENTER[1]);
  if (dx > ZONE_HALF_W || dy > ZONE_HALF_H) return false;
  if (dx <= ZONE_HALF_W - ZONE_CR || dy <= ZONE_HALF_H - ZONE_CR) return true;
  return (dx - (ZONE_HALF_W - ZONE_CR)) ** 2 + (dy - (ZONE_HALF_H - ZONE_CR)) ** 2 <= ZONE_CR ** 2;
}

const DEG = Math.PI / 180;
const bearing = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
function bearingDelta(a, b) { let d = Math.abs(a - b) % 180; if (d > 90) d = 180 - d; return d; }
function hubTaper(p) {
  const d = Math.hypot(p[0] - HUB[0], p[1] - HUB[1]);
  if (d <= HUB_INNER) return 0;
  if (d >= HUB_OUTER) return 1;
  const t = (d - HUB_INNER) / (HUB_OUTER - HUB_INNER);
  return t * t * (3 - 2 * t);
}

// --- helpers ----------------------------------------------------------------
function resample(line, step) {
  const out = [];
  if (line.length < 2) return line.slice();
  let carry = 0;
  out.push(line[0]);
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const seg = dist(a, b);
    if (seg === 0) continue;
    const ux = (b[0] - a[0]) / seg, uy = (b[1] - a[1]) / seg;
    let d = -carry;
    while (d + step <= seg) { d += step; out.push([a[0] + ux * d, a[1] + uy * d]); }
    carry = seg - d;
  }
  out.push(line[line.length - 1]);
  return out;
}

function smooth(coords, iter) {
  let pts = coords.map((c) => [c[0], c[1]]);
  if (pts.length < 3) return pts;
  for (let it = 0; it < iter; it++) {
    const next = pts.map((c) => [c[0], c[1]]);
    for (let i = 1; i < pts.length - 1; i++) {
      next[i] = [(pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4];
    }
    pts = next;
  }
  return pts;
}

// Nearest point on any piece OTHER than `pi` (pieces pre-sampled into points).
function nearestOther(e, sampled, pi) {
  let best = Infinity, bp = null;
  for (let qi = 0; qi < sampled.length; qi++) {
    if (qi === pi) continue;
    for (const q of sampled[qi]) { const d = dist(e, q); if (d < best) { best = d; bp = q; } }
  }
  return { dist: best, point: bp };
}

// Even spacing. Where routes run parallel (a bundle), shift each one sideways so the
// gaps are equal, KEEPING the order Erik set: we READ the order from his positions
// (project each member onto the local perpendicular, sort by signed offset) and only
// normalize the gaps. Never re-assigns order. Tapers to converge near the hub. The
// perpendicular shift is heavily smoothed along each line so lanes don't wobble where
// bundle membership flickers.
function evenSpace(routes) {
  const GS = SP_TOL;
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / GS)},${Math.floor(y / GS)}`;
  for (const r of routes) for (const part of r.parts) {
    if (part.length < 2) continue;
    const s = resample(part, SAMPLE);
    for (let i = 0; i < s.length; i++) {
      const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
      const k = key(s[i][0], s[i][1]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ id: r.id, x: s[i][0], y: s[i][1], brg: bearing(a, b) });
    }
  }
  for (const r of routes) for (const part of r.parts) {
    if (part.length < 3) continue;
    const orig = part.map((c) => [c[0], c[1]]);
    const shift = new Array(part.length).fill(0);
    for (let i = 0; i < orig.length; i++) {
      const v = orig[i];
      const a = orig[Math.max(0, i - 1)], b = orig[Math.min(orig.length - 1, i + 1)];
      const brg = bearing(a, b);
      const px = Math.cos(brg * DEG), py = -Math.sin(brg * DEG); // right perpendicular
      const off = new Map([[r.id, 0]]); // signed offset of each bundle member from v
      const cx = Math.floor(v[0] / GS), cy = Math.floor(v[1] / GS);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const bk = grid.get(`${cx + dx},${cy + dy}`); if (!bk) continue;
        for (const q of bk) {
          if (q.id === r.id) continue;
          if (Math.hypot(q.x - v[0], q.y - v[1]) > SP_TOL) continue;
          if (bearingDelta(brg, q.brg) > SP_BEARING) continue;
          const o = (q.x - v[0]) * px + (q.y - v[1]) * py;
          if (!off.has(q.id) || Math.abs(o) < Math.abs(off.get(q.id))) off.set(q.id, o);
        }
      }
      const n = off.size;
      if (n < 2) continue;
      const ordered = [...off.entries()].sort((A, B) => A[1] - B[1]); // Erik's order, read from positions
      const rank = ordered.findIndex((e) => e[0] === r.id);
      const center = ordered.reduce((s, e) => s + e[1], 0) / n;
      const target = (rank - (n - 1) / 2) * LANE_WIDTH;
      shift[i] = center + target * hubTaper(v); // converge at hub, even lanes outside
    }
    for (let it = 0; it < SP_SMOOTH; it++) {
      const ns = shift.slice();
      for (let i = 1; i < shift.length - 1; i++) ns[i] = (shift[i - 1] + 2 * shift[i] + shift[i + 1]) / 4;
      for (let i = 0; i < shift.length; i++) shift[i] = ns[i];
    }
    for (let i = 0; i < part.length; i++) {
      const a = orig[Math.max(0, i - 1)], b = orig[Math.min(orig.length - 1, i + 1)];
      const brg = bearing(a, b);
      part[i] = [orig[i][0] + shift[i] * Math.cos(brg * DEG), orig[i][1] + shift[i] * -Math.sin(brg * DEG)];
    }
  }
}

// Point on segment a-b where it crosses the zone boundary (a, b on opposite sides).
function boundaryPoint(a, b) {
  let lo = 0, hi = 1;
  const inA = inZone(a);
  for (let k = 0; k < 24; k++) {
    const m = (lo + hi) / 2;
    const p = [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m];
    if (inZone(p) === inA) lo = m; else hi = m;
  }
  const m = (lo + hi) / 2;
  return [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m];
}

// Clip every route to OUTSIDE the hub zone: drop the portions inside, truncate at the
// boundary. A route that passes through becomes two stubs that stop at the boundary.
function hubClip(routes) {
  let clipped = 0;
  for (const r of routes) {
    const newParts = [];
    for (const part of r.parts) {
      if (!part.some(inZone)) { newParts.push(part); continue; }
      clipped++;
      let cur = [];
      for (let i = 0; i < part.length; i++) {
        if (!inZone(part[i])) {
          if (i > 0 && inZone(part[i - 1])) cur.push(boundaryPoint(part[i - 1], part[i])); // re-entering daylight
          cur.push(part[i]);
        } else {
          if (i > 0 && !inZone(part[i - 1])) cur.push(boundaryPoint(part[i - 1], part[i])); // hitting the box
          if (cur.length >= 2) newParts.push(cur);
          cur = [];
        }
      }
      if (cur.length >= 2) newParts.push(cur);
    }
    r.parts = newParts;
  }
  return clipped;
}

// --- load -------------------------------------------------------------------
const groupParts = (fc) => {
  const m = new Map();
  for (const f of fc.features) {
    const id = f.properties.routeId;
    const ps = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    if (!m.has(id)) m.set(id, { color: f.properties.color, parts: [] });
    for (const p of ps) m.get(id).parts.push(p.map(toM));
  }
  return m;
};
const overrides = groupParts(JSON.parse(readFileSync(OVERRIDES, 'utf8')));

// Stage 1: smooth every piece, keep them all.
const routes = [];
for (const [id, { color, parts }] of overrides) {
  routes.push({ id, color, parts: parts.map((p) => smooth(p, SMOOTH_ITER)) });
}

// Stage 2: even the spacing of parallel routes (mutates the pieces in place).
evenSpace(routes);

// Stage 2b: clip routes at the hub zone boundary (the spaghetti becomes a black box).
// On by default; run with NOCLIP=1 to show full routes while re-positioning the box.
const hubClipped = process.env.NOCLIP === '1' ? 0 : hubClip(routes);

// Stage 3: bridge gaps at junctions on the final geometry, then emit.
const out = [];
let connectorsAdded = 0, openEnds = 0;
for (const { id, color, parts } of routes) {
  const sampled = parts.map((p) => resample(p, SAMPLE));
  const connectors = [];
  for (let pi = 0; pi < parts.length; pi++) {
    if (parts[pi].length < 2) continue;
    for (const end of [parts[pi][0], parts[pi][parts[pi].length - 1]]) {
      const np = nearestOther(end, sampled, pi);
      if (np.point && np.dist > JOIN_TOL && np.dist < MAX_BRIDGE) { connectors.push([end, np.point]); connectorsAdded++; }
      else openEnds++;
    }
  }
  const geomParts = parts.concat(connectors).filter((l) => l.length >= 2).map((l) => l.map(toLngLat));
  out.push({
    type: 'Feature',
    properties: { routeId: id, color },
    geometry: geomParts.length === 1 ? { type: 'LineString', coordinates: geomParts[0] } : { type: 'MultiLineString', coordinates: geomParts },
  });
}

// Hub zone outline (the black box) + station marker, for the map to draw.
const zoneRing = [];
const zc = [[ZONE_HALF_W - ZONE_CR, ZONE_HALF_H - ZONE_CR, 0], [-(ZONE_HALF_W - ZONE_CR), ZONE_HALF_H - ZONE_CR, Math.PI / 2], [-(ZONE_HALF_W - ZONE_CR), -(ZONE_HALF_H - ZONE_CR), Math.PI], [ZONE_HALF_W - ZONE_CR, -(ZONE_HALF_H - ZONE_CR), 3 * Math.PI / 2]];
for (const [ox, oy, a0] of zc) for (let i = 0; i <= 8; i++) {
  const a = a0 + (i / 8) * (Math.PI / 2);
  zoneRing.push(toLngLat([ZONE_CENTER[0] + ox + ZONE_CR * Math.cos(a), ZONE_CENTER[1] + oy + ZONE_CR * Math.sin(a)]));
}
zoneRing.push(zoneRing[0]);
out.push({ type: 'Feature', properties: { kind: 'hubzone' }, geometry: { type: 'Polygon', coordinates: [zoneRing] } });
out.push({ type: 'Feature', properties: { kind: 'station', name: 'Rapid Central Station' }, geometry: { type: 'Point', coordinates: HUB_LNGLAT } });

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features: out }));
console.log(`smooth: ${SMOOTH_ITER} passes`);
console.log(`even-spacing: ${LANE_WIDTH} m lanes, order read from your positions, hub taper ${HUB_INNER}-${HUB_OUTER} m`);
console.log(`hub: ${hubClipped} route pieces clipped at the zone boundary (black box) + marker`);
console.log(`stitch: ${connectorsAdded} junction bridges, ${openEnds} open ends; kept all ${overrides.size} routes`);
console.log(`wrote ${OUT}`);
