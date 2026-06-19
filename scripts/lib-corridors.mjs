// lib-corridors.mjs
//
// Shared geometry for route disambiguation. Both the rung-1 detector
// (detect-corridors.mjs) and the rung-2 spreader (spread-routes.mjs) need the
// same pipeline: project to local meters, resample each line to evenly spaced
// points with a local bearing, and count how many distinct routes run coincident
// at each point. Extracted here so the two stay in lockstep and the offset work
// builds on exactly what the detector found.

// Local equirectangular projection. One reference latitude for the whole city
// keeps east/west and north/south scaling consistent. Good to well under a meter
// across Grand Rapids.
const LAT0 = 42.96;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

export const toM = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
export const toLngLat = ([x, y]) => [x / M_PER_DEG_LON, y / M_PER_DEG_LAT];

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Bearing of the segment a->b, degrees clockwise from north. Only used to tell
// "same street" from "crossing street", so the exact convention does not matter
// as long as it is consistent.
export function bearing(a, b) {
  const deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// Smallest angle between two bearings, folded to [0,90]. Folding at 180 makes a
// heading and its reverse equivalent, so the outbound and inbound directions of
// the same corridor read as parallel.
export function bearingDelta(a, b) {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

// Walk a projected polyline and emit points every `spacing` meters, each tagged
// with the bearing of the segment it sits on. Short leftover tails are dropped.
export function resample(coords, spacing) {
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
    let d = -carry;
    while (d + spacing <= segLen) {
      d += spacing;
      out.push({ x: a[0] + ux * d, y: a[1] + uy * d, brg });
    }
    carry = segLen - d;
  }
  return out;
}

// Detect coincidence across a FeatureCollection of route LineStrings. Returns the
// resampled `lines`, each point carrying a `routes` Set of the distinct route ids
// found within tolerance at that spot (including the point's own route).
//
// opts: { spacing=12, tol=18, bearingTol=25 }
//   spacing    - resample step, meters
//   tol        - two points this close (meters) may be the same corridor
//   bearingTol - and headings within this many degrees (mod 180)
export function detectCoincidence(features, opts = {}) {
  const spacing = opts.spacing ?? 12;
  const tol = opts.tol ?? 18;
  const bearingTol = opts.bearingTol ?? 25;

  // A tol-sized grid means a 3x3 neighborhood covers the search radius.
  const cell = tol;
  const cellKey = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const grid = new Map();
  const lines = []; // { routeId, color, pts: [{x,y,brg,routes}] }

  for (const f of features) {
    const coords = f.geometry.coordinates.map(toM);
    const pts = resample(coords, spacing);
    const li = lines.push({ routeId: f.properties.routeId, color: f.properties.color, pts }) - 1;
    pts.forEach((p, pi) => {
      const k = cellKey(p.x, p.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ li, pi });
    });
  }

  const NEIGHBORS = [-1, 0, 1];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let pi = 0; pi < line.pts.length; pi++) {
      const p = line.pts[pi];
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
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
            if (dist(p, q) > tol) continue;
            if (bearingDelta(p.brg, q.brg) > bearingTol) continue;
            routes.add(other.routeId);
          }
        }
      }
      p.routes = routes;
    }
  }

  return { lines, spacing };
}
