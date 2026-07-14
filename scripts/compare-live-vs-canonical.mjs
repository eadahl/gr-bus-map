// compare-live-vs-canonical.mjs
//
// WHERE / HOW / WHEN the LIVE recorded routes (reconstructed from accumulated GPS)
// differ from the PUBLISHED CANONICAL routes, with published detours folded in so a
// divergence can be labeled by CAUSE rather than lumped together.
//
// Three canonical/reference sources:
//   gtfs   data/routes.geojson                    (published schedule geometry, all routes)
//   kml    data/detour-traces/Route{N}.kml        (agency's own non-detour trace; 22 of 25)
//   live   data/routes-reconstructed-consolidated-matched-debug.geojson (where buses drove)
// Plus HISTORICAL detours that were active DURING collection:
//   detour geometry  data/detour-traces/Route{N}_DET_*.kml (the ones the detour-log saw active)
//   detour timeline  data/detour-log.ndjson       (when each route was detoured + published reason)
//
// For each live vertex we take the nearest distance to the route's GTFS line. Beyond
// DIVERGE_TOL it is a divergence, classified:
//   detour     - it hugs the route's historical _DET_ geometry (a published reroute)
//   branch     - it projects to the very start/end of the canonical line (live runs
//                PAST where the single canonical shape reaches: a branch GTFS omits)
//   deviation  - none of the above (the genuinely interesting leftover)
//
// Out: data/live-vs-canonical.geojson      (gitignored) -> live-vs-canonical.html
//      data/live-vs-canonical-stats.json   (gitignored) per-route WHERE/HOW/WHEN table
// Usage: node scripts/compare-live-vs-canonical.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'data/live-vs-canonical.geojson';
const STATS = 'data/live-vs-canonical-stats.json';
const TRACE_DIR = 'data/detour-traces';
const DIVERGE_TOL = 70;   // m: beyond this from the canonical GTFS line = a divergence
const END_FRAC = 0.04;    // nearest-point param within this of an endpoint = "beyond canonical" (branch)
const MIN_SEG_M = 120;    // drop divergence blips shorter than this (GPS/matching noise)

const M_PER_DEG = 111320;
const COS = Math.cos((42.96 * Math.PI) / 180);
const distM = (a, b) => Math.hypot((a[0] - b[0]) * COS * M_PER_DEG, (a[1] - b[1]) * M_PER_DEG);
const lineLenM = (c) => { let L = 0; for (let i = 1; i < c.length; i++) L += distM(c[i - 1], c[i]); return L; };
const km = (m) => +(m / 1000).toFixed(1);

// nearest distance from point p to a single polyline, plus the projection's fraction
// along the whole line (t in [0,1]) - used to tell "beyond the end" from "mid-route".
function nearestOnPath(p, line) {
  const segLen = []; let total = 0;
  for (let i = 1; i < line.length; i++) { const d = distM(line[i - 1], line[i]); segLen.push(d); total += d; }
  let best = Infinity, bestPos = 0, acc = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const bx = (b[0] - a[0]) * COS * M_PER_DEG, by = (b[1] - a[1]) * M_PER_DEG;
    const px = (p[0] - a[0]) * COS * M_PER_DEG, py = (p[1] - a[1]) * M_PER_DEG;
    const len2 = bx * bx + by * by;
    let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - t * bx, py - t * by);
    if (d < best) { best = d; bestPos = acc + t * segLen[i - 1]; }
    acc += segLen[i - 1];
  }
  return { dist: best, t: total > 0 ? bestPos / total : 0 };
}
// nearest over a SET of polylines: min distance, and the t from whichever line was nearest
function nearestOverLines(p, lines) {
  let best = { dist: Infinity, t: 0 };
  for (const line of lines) { if (line.length < 2) continue; const r = nearestOnPath(p, line); if (r.dist < best.dist) best = r; }
  return best;
}

function parseKmlCoords(text) {
  return [...text.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)]
    .map((m) => m[1].trim().split(/\s+/).map((s) => { const [lon, lat] = s.split(',').map(Number); return [lon, lat]; }).filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])))
    .filter((c) => c.length >= 2);
}
const dateStr = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// ── route identity/colors (the 25 drawn routes) ──────────────────────────────
const drawn = JSON.parse(readFileSync('data/routes-final.geojson', 'utf8')).features.filter((f) => !f.properties.kind);
const colorById = {}; const routeIds = [];
for (const f of drawn) { const id = String(f.properties.routeId); if (!routeIds.includes(id)) { routeIds.push(id); colorById[id] = f.properties.color; } }

// ── GTFS canonical (per route: all its dir lines) ────────────────────────────
const gtfsByRoute = {};
for (const f of JSON.parse(readFileSync('data/routes.geojson', 'utf8')).features) {
  const id = String(f.properties.routeId);
  if (!routeIds.includes(id)) continue;
  (gtfsByRoute[id] = gtfsByRoute[id] || []).push(f.geometry.coordinates);
}
// ── KML canonical (plain, non-detour) ────────────────────────────────────────
const kmlByRoute = {};
for (const id of routeIds) {
  const f = `${TRACE_DIR}/Route${id}.kml`;
  if (existsSync(f)) kmlByRoute[id] = parseKmlCoords(readFileSync(f, 'utf8'));
}
// ── live GPS (matched, consolidated) ─────────────────────────────────────────
const liveByRoute = {};
for (const f of JSON.parse(readFileSync('data/routes-reconstructed-consolidated-matched-debug.geojson', 'utf8')).features) {
  const id = String(f.properties.routeId);
  if (!routeIds.includes(id)) continue;
  (liveByRoute[id] = liveByRoute[id] || []).push(f);
}

// ── historical detours from the log: window, reasons, and which _DET_ traces ──
const detourByRoute = {}; // id -> { snaps, first, last, traces:Set, reasons:Set }
let logFirst = Infinity, logLast = -Infinity, snapCount = 0;
if (existsSync('data/detour-log.ndjson')) {
  for (const line of readFileSync('data/detour-log.ndjson', 'utf8').trim().split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    snapCount += 1; logFirst = Math.min(logFirst, o.t); logLast = Math.max(logLast, o.t);
    for (const d of o.detouredRoutes || []) {
      const id = String(d.routeId);
      const e = detourByRoute[id] = detourByRoute[id] || { snaps: 0, first: Infinity, last: -Infinity, traces: new Set(), reasons: new Set() };
      e.snaps += 1; e.first = Math.min(e.first, o.t); e.last = Math.max(e.last, o.t);
      if (d.traceFile) e.traces.add(d.traceFile);
    }
    for (const m of o.messages || []) {
      for (const r of m.routes || []) {
        const id = String(r);
        const e = detourByRoute[id] = detourByRoute[id] || { snaps: 0, first: Infinity, last: -Infinity, traces: new Set(), reasons: new Set() };
        if (m.header) e.reasons.add(m.header.trim());
      }
    }
  }
}
// load the historical detour geometry (the _DET_ traces the log actually saw active)
const detourGeomByRoute = {};
for (const id of routeIds) {
  const e = detourByRoute[id];
  if (!e || !e.traces.size) continue;
  const lines = [];
  for (const tf of e.traces) { const f = `${TRACE_DIR}/${tf}`; if (existsSync(f)) lines.push(...parseKmlCoords(readFileSync(f, 'utf8'))); }
  if (lines.length) detourGeomByRoute[id] = lines;
}

// ── build features + per-route stats ─────────────────────────────────────────
const features = [];
const push = (source, id, geom, extra = {}) => features.push({ type: 'Feature', properties: { source, routeId: id, color: colorById[id], ...extra }, geometry: geom });
const stats = {};

for (const id of routeIds) {
  for (const c of gtfsByRoute[id] || []) push('gtfs', id, { type: 'LineString', coordinates: c });
  for (const c of kmlByRoute[id] || []) push('kml', id, { type: 'LineString', coordinates: c });
  for (const c of detourGeomByRoute[id] || []) push('detour-hist', id, { type: 'LineString', coordinates: c });
  for (const f of liveByRoute[id] || []) push('live', id, f.geometry, { dir: f.properties.dir, dests: f.properties.dests, trips: f.properties.trips });

  const gtfs = gtfsByRoute[id] || [];
  const kml = kmlByRoute[id];
  const detourGeom = detourGeomByRoute[id];
  const live = (liveByRoute[id] || []).map((f) => f.geometry.coordinates);

  let liveM = 0, divM = 0, offKmlM = 0;
  const classM = { detour: 0, branch: 0, deviation: 0 };

  for (const coords of live) {
    // classify each vertex, then emit runs of same class as divergence segments
    const cls = coords.map((p) => {
      const g = gtfs.length ? nearestOverLines(p, gtfs) : { dist: Infinity, t: 0.5 };
      if (g.dist <= DIVERGE_TOL) return 'on';
      if (detourGeom && nearestOverLines(p, detourGeom).dist <= DIVERGE_TOL) return 'detour';
      if (g.t <= END_FRAC || g.t >= 1 - END_FRAC) return 'branch';
      return 'deviation';
    });
    for (let i = 1; i < coords.length; i++) {
      const segLen = distM(coords[i - 1], coords[i]);
      liveM += segLen;
      // a segment's class = class of its ending vertex (simple, fine at vertex spacing)
      const k = cls[i];
      if (k !== 'on') { divM += segLen; classM[k] += segLen; }
      if (kml && nearestOverLines(coords[i], kml).dist > DIVERGE_TOL) offKmlM += segLen;
    }
    // emit contiguous divergence runs as line features (for the map highlight)
    let run = [], runClass = null;
    const flush = () => {
      if (run.length >= 2 && lineLenM(run) >= MIN_SEG_M) push('divergence', id, { type: 'LineString', coordinates: run.slice() }, { class: runClass });
      run = []; runClass = null;
    };
    for (let i = 0; i < coords.length; i++) {
      const k = cls[i];
      if (k === 'on') { flush(); continue; }
      if (runClass && k !== runClass) flush();
      runClass = k; run.push(coords[i]);
    }
    flush();
  }

  const d = detourByRoute[id];
  stats[id] = {
    color: colorById[id],
    liveKm: km(liveM),
    divergentKm: km(divM),
    pctOffGtfs: liveM ? Math.round((divM / liveM) * 100) : 0,
    pctOffKml: kml ? (liveM ? Math.round((offKmlM / liveM) * 100) : 0) : null,
    hasKml: !!kml,
    classKm: { detour: km(classM.detour), branch: km(classM.branch), deviation: km(classM.deviation) },
    detouredHist: !!(d && d.snaps),
    detourWindow: d && d.snaps ? { from: dateStr(d.first), to: dateStr(d.last), share: Math.round((d.snaps / snapCount) * 100) } : null,
    detourReasons: d ? [...d.reasons].slice(0, 4) : [],
    detourTraces: d ? [...d.traces] : [],
  };
}

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
writeFileSync(STATS, JSON.stringify({ logWindow: snapCount ? { from: dateStr(logFirst), to: dateStr(logLast), snapshots: snapCount } : null, routes: stats }));

// ── console table: WHERE / HOW / WHEN ─────────────────────────────────────────
console.log(`canonical sources: gtfs (25) + kml (${Object.keys(kmlByRoute).length}); live: consolidated+matched`);
if (snapCount) console.log(`historical detour log: ${snapCount} snapshots ${dateStr(logFirst)} -> ${dateStr(logLast)}\n`);
console.log('route  live  off-GTFS  off-KML   detour(km)/branch(km)/dev(km)   detoured?  window (share)          reason');
for (const id of routeIds.sort((a, b) => (+a || 1e9) - (+b || 1e9))) {
  const s = stats[id];
  const dw = s.detourWindow ? `${s.detourWindow.from}->${s.detourWindow.to.slice(5)} (${s.detourWindow.share}%)` : '-';
  const reason = s.detourReasons[0] ? s.detourReasons[0].slice(0, 40) : '';
  const off = `${s.pctOffGtfs}%`.padStart(4);
  const offK = (s.pctOffKml == null ? 'n/a' : `${s.pctOffKml}%`).padStart(5);
  const cls = `${s.classKm.detour}/${s.classKm.branch}/${s.classKm.deviation}`.padEnd(14);
  console.log(`${id.padEnd(5)}  ${String(s.liveKm).padStart(4)}  ${off.padStart(7)}   ${offK}   ${cls}  ${(s.detouredHist ? 'YES' : 'no').padEnd(4)}      ${dw.padEnd(22)} ${reason}`);
}
console.log(`\nwrote ${features.length} features to ${OUT} and per-route stats to ${STATS}`);
console.log('view: live-vs-canonical.html (start a local server, then open it)');
