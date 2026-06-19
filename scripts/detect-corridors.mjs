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
// The detection pipeline lives in lib-corridors.mjs (shared with the spreader).
// This script runs it, then merges consecutive same-count points back into
// segments and writes them out for the debug view.
//
// Output: data/corridors-debug.geojson, one feature per segment, carrying:
//   count  - how many distinct routes share that spot (1 = solo, >=2 = bundled)
//   routes - the distinct route ids sharing the run
//   color  - the owning route's real color
//
// This does NOT touch data/routes.geojson or the deployed map. View it with
// debug-corridors.html.
//
// Usage: node scripts/detect-corridors.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { detectCoincidence, toLngLat } from './lib-corridors.mjs';

const IN = 'data/routes.geojson';
const OUT = 'data/corridors-debug.geojson';

const data = JSON.parse(readFileSync(IN, 'utf8'));
const { lines, spacing } = detectCoincidence(data.features);

// Emit one feature per maximal run of consecutive points with the same count.
// The run's `routes` is the union over the run (counts can flicker point to
// point; the union is the honest "who is in this corridor" answer).
const features = [];
for (const line of lines) {
  const pts = line.pts;
  if (pts.length < 2) continue;
  let runStart = 0;
  const flush = (end) => {
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
    meters[c] = (meters[c] || 0) + spacing;
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
