// collect-detours.mjs
//
// Companion to collect-vehicles.mjs. Captures the DETOUR TIMELINE so the GPS we
// are accumulating can later be labeled detour-vs-real-branch. Detours are
// pervasive (15 of 25 routes at the 2026-06-20 probe) and time-bound, so this has
// to run alongside the GPS collector: you cannot reconstruct "what was detoured
// when" after the fact.
//
// Two detour signals, both captured:
//   1. PublicMessages/GetCurrentMessages - the authoritative alerts: which routes,
//      the active window, and the human reason.
//   2. Route trace filenames - a route on detour gets a `Route{N}_DET_*.kml` trace
//      with the reroute baked into the geometry. The filename is the cleanest
//      detection signal.
// It also ARCHIVES each route's KML the first time it sees a new filename, so the
// actual (possibly rerouted) geometry is preserved even if the agency rotates it.
// That archive doubles as the official-geometry set for the three-way base compare.
//
// Slow-moving data, so it polls infrequently and only appends a snapshot when the
// detour-relevant content actually changes.
//
// Usage:
//   node scripts/collect-detours.mjs                 # poll every 15 min
//   node scripts/collect-detours.mjs --interval 600  # seconds between polls
//
// Outputs (gitignored): data/detour-log.ndjson (timeline), data/detour-traces/*.kml (archive)

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://connect.ridetherapid.org/InfoPoint/rest';
const TRACE_BASE = 'https://connect.ridetherapid.org/InfoPoint/Resources/Traces';
const LOG = 'data/detour-log.ndjson';
const TRACE_DIR = 'data/detour-traces';

const intervalArg = process.argv.indexOf('--interval');
const INTERVAL_S = intervalArg > -1 ? Number(process.argv[intervalArg + 1]) || 900 : 900;

mkdirSync(TRACE_DIR, { recursive: true });

function parseAspNetDate(v) { if (!v) return null; const m = /\/Date\((\d+)/.exec(v); return m ? Number(m[1]) : null; }
function stripHtml(s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

async function getJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Archive a trace file we have not saved before (preserves rerouted geometry).
async function archiveTrace(filename) {
  if (!filename) return;
  const dest = join(TRACE_DIR, filename);
  if (existsSync(dest)) return;
  try {
    const res = await fetch(`${TRACE_BASE}/${filename}`);
    if (!res.ok) return;
    writeFileSync(dest, await res.text());
  } catch { /* leave it; next poll retries */ }
}

let polls = 0, snapshots = 0, errors = 0, lastHash = null;
const startedAt = Date.now();

async function tick() {
  polls += 1;
  let routes, messages;
  try {
    [routes, messages] = await Promise.all([
      getJson(`${BASE}/Routes/GetAllRoutes`),
      getJson(`${BASE}/PublicMessages/GetCurrentMessages`),
    ]);
  } catch (err) { errors += 1; console.warn(`[poll ${polls}] ${err.message}`); return; }

  // detoured routes (by the _DET_ trace marker) + archive every route's current trace
  const detoured = [];
  for (const r of routes) {
    const f = r.RouteTraceFilename || null;
    await archiveTrace(f);
    if (f && /_DET_/.test(f)) detoured.push({ routeId: String(r.RouteId), shortName: r.ShortName, traceFile: f });
  }

  // active messages, privacy-safe (no driver data in messages), HTML stripped
  const msgs = messages.map((m) => ({
    id: m.MessageId,
    routes: m.Routes || [],
    header: stripHtml(m.Header),
    text: stripHtml(m.Message).slice(0, 600),
    from: parseAspNetDate(m.FromDate), to: parseAspNetDate(m.ToDate),
    fromTime: m.FromTime || null, toTime: m.ToTime || null, days: m.DaysOfWeek ?? null,
    cause: m.CauseReportLabel || null, priority: m.Priority ?? null, url: m.URL || null,
  }));

  // only append when the detour-relevant content changed (it moves slowly)
  const hash = JSON.stringify([detoured.map((d) => d.traceFile).sort(), msgs.map((m) => `${m.id}:${m.text}`).sort()]);
  if (hash !== lastHash) {
    lastHash = hash;
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), detouredRoutes: detoured, messages: msgs }) + '\n');
    snapshots += 1;
    console.log(`[snapshot ${snapshots}] ${detoured.length} routes detoured, ${msgs.length} messages`);
  }

  if (polls % 4 === 0) {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(0);
    const archived = existsSync(TRACE_DIR) ? readdirSync(TRACE_DIR).length : 0;
    console.log(`[${mins} min] polls ${polls}, snapshots ${snapshots}, traces archived ${archived}, errors ${errors}`);
  }
}

function summary() {
  const mins = ((Date.now() - startedAt) / 60000).toFixed(0);
  const sz = existsSync(LOG) ? (statSync(LOG).size / 1024).toFixed(0) : '0';
  const archived = existsSync(TRACE_DIR) ? readdirSync(TRACE_DIR).length : 0;
  console.log(`\nstopped. ${mins} min, ${polls} polls, ${snapshots} snapshots (${sz} KB), ${archived} traces archived.`);
  process.exit(0);
}
process.on('SIGINT', summary);
process.on('SIGTERM', summary);

console.log(`detour logger: polling every ${INTERVAL_S}s -> ${LOG} + ${TRACE_DIR}/`);
console.log('Ctrl-C to stop (append-only; safe to resume).');
await tick();
setInterval(tick, INTERVAL_S * 1000);
