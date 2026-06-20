// diag-junctions.mjs
//
// Throwaway diagnostic for rung 1.5 step 3 (junction cleanup). Scans the
// road-matched output for the geometric pathologies the simple nearest-edge
// matcher produces, so we can SEE where they are, count them, and measure whether
// a fix actually reduces them. Not part of the build.
//
// Flags, per route, in projected meters:
//   - reversals: interior vertex where the path turns more than REV_DEG (a spike
//     or hairpin: the line doubles back, e.g. tracing the wrong way round a
//     roundabout or jumping between divided-road carriageways).
//   - jumps: consecutive vertices farther apart than JUMP_M (a teleport between
//     non-adjacent roads at a junction).
//
// Usage: node scripts/diag-junctions.mjs [data/routes-matched-debug.geojson]

import { readFileSync } from 'node:fs';
import { toM, dist } from './lib-corridors.mjs';

const IN = process.argv[2] || 'data/routes-matched-debug.geojson';
const REV_DEG = 120;  // turn angle (deg) above which we call it a reversal/spike
const JUMP_M = 40;    // vertex-to-vertex distance (m) above which we call it a jump

// Interior turn angle at b given neighbors a,b,c, in degrees (0 = straight).
function turnDeg(a, b, c) {
  const v1x = b[0] - a[0], v1y = b[1] - a[1];
  const v2x = c[0] - b[0], v2y = c[1] - b[1];
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  if (l1 === 0 || l2 === 0) return 0;
  let cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

const fc = JSON.parse(readFileSync(IN, 'utf8'));
let totReversals = 0, totJumps = 0, totVerts = 0;
const worst = [];

for (const f of fc.features) {
  const m = f.geometry.coordinates.map(toM);
  totVerts += m.length;
  let rev = 0, jump = 0;
  const spots = [];
  for (let i = 1; i < m.length - 1; i++) {
    const t = turnDeg(m[i - 1], m[i], m[i + 1]);
    if (t > REV_DEG) { rev++; spots.push({ i, kind: 'rev', deg: Math.round(t), at: f.geometry.coordinates[i] }); }
  }
  for (let i = 1; i < m.length; i++) {
    const d = dist(m[i - 1], m[i]);
    if (d > JUMP_M) { jump++; spots.push({ i, kind: 'jump', m: Math.round(d), at: f.geometry.coordinates[i] }); }
  }
  totReversals += rev;
  totJumps += jump;
  worst.push({ routeId: f.properties.routeId, verts: m.length, rev, jump, spots });
}

worst.sort((a, b) => (b.rev + b.jump) - (a.rev + a.jump));

console.log(`input: ${IN}`);
console.log(`features: ${fc.features.length}, vertices: ${totVerts}`);
console.log(`reversals (>${REV_DEG} deg turn): ${totReversals}`);
console.log(`jumps (>${JUMP_M} m step): ${totJumps}`);
console.log('\nworst routes (routeId  rev  jump):');
for (const w of worst.slice(0, 12)) {
  console.log(`  ${String(w.routeId).padEnd(6)} ${String(w.rev).padStart(4)} ${String(w.jump).padStart(5)}   (${w.verts} verts)`);
}

// Print a few concrete coordinates of the worst route so we can fly there.
const w0 = worst[0];
if (w0 && w0.spots.length) {
  console.log(`\nsample bad spots on route ${w0.routeId}:`);
  for (const s of w0.spots.slice(0, 8)) {
    const c = s.at.map((x) => x.toFixed(5)).join(', ');
    console.log(`  ${s.kind === 'rev' ? `reversal ${s.deg} deg` : `jump ${s.m} m`} at [${c}]`);
  }
}
