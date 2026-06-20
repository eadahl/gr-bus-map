// collect-reliability.mjs
//
// Third collector for the initiative. Samples StopDepartures at the agency's
// TIMEPOINT stops (the 270 stops where schedule adherence is actually measured)
// to capture schedule-vs-actual over time. This is the foundation of the
// reliability / on-time / ghost-bus track. Same "log it over time to learn what
// stories it tells" logic as occupancy.
//
// What StopDepartures gives per departure (live-checked 2026-06-20):
//   SDT scheduled, EDT estimated, ADT actual (null until completed), Dev (HH:MM:SS,
//   the predicted deviation now and the actual once done), IsCompleted, StopStatus.
//   Unlike the vehicle feed (Deviation null), Dev IS populated here.
//
// Strategy: 270 timepoints is too many to poll at once, so rotate, one stop every
// STEP_MS, cycling through all of them (~11 min/cycle at the default). Politely
// steady, one request at a time. To stay focused and lean we keep only departures
// that are already completed OR scheduled within the next hour (drops the far-future
// scheduled rows a terminal stop lists). Dedup so each departure logs about twice:
// once upcoming, once completed.
//
// Usage:
//   node scripts/collect-reliability.mjs               # ~2.5s between stops
//   node scripts/collect-reliability.mjs --step 4000   # ms between stops
//
// Output (gitignored): data/reliability-log.ndjson

import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';

const BASE = 'https://connect.ridetherapid.org/InfoPoint/rest';
const LOG = 'data/reliability-log.ndjson';

const stepArg = process.argv.indexOf('--step');
const STEP_MS = stepArg > -1 ? Number(process.argv[stepArg + 1]) || 2500 : 2500;
const NEAR_MS = 60 * 60 * 1000; // keep departures scheduled within the next hour

function parseAspNetDate(v) { if (!v) return null; const m = /\/Date\((\d+)/.exec(v); return m ? Number(m[1]) : null; }

async function getJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// the 270 timepoint stops (adherence is measured here)
let timepoints = [];
try {
  const stops = await getJson(`${BASE}/Stops/GetAllStops`);
  timepoints = stops.filter((s) => s.IsTimePoint).map((s) => s.StopId);
} catch (err) {
  console.error(`could not load stops: ${err.message}`);
  process.exit(1);
}
if (!timepoints.length) { console.error('no timepoint stops found'); process.exit(1); }

const seen = new Set(); // dedup keys; reset on restart (best-effort)
let idx = 0, polls = 0, written = 0, errors = 0, cycles = 0;
const startedAt = Date.now();
let stopped = false;

async function pollStop(stopId) {
  let j;
  try { j = await getJson(`${BASE}/StopDepartures/Get/${stopId}`); }
  catch (err) { errors += 1; return; }
  const now = Date.now();
  const lines = [];
  for (const rec of j) {
    for (const rd of rec.RouteDirections || []) {
      for (const d of rd.Departures || []) {
        const sched = parseAspNetDate(d.SDT);
        const done = !!d.IsCompleted;
        if (!done && !(sched && sched <= now + NEAR_MS)) continue; // skip far-future
        const act = parseAspNetDate(d.ADT);
        // Include the dev MINUTE in the dedup key so we re-log as the predicted
        // deviation evolves toward departure (not just once at first sighting),
        // and on completion (done/act change). 1-min granularity keeps it bounded.
        const devMinB = d.Dev ? String(d.Dev).slice(0, 5) : '';
        const key = `${stopId}|${d.Trip}|${sched}|${done ? 1 : 0}|${act || ''}|${devMinB}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(JSON.stringify({
          t: now,
          stop: stopId,
          route: rd.RouteId,
          dir: rd.DirectionCode || rd.Direction || null,
          trip: d.Trip,
          sched,                              // scheduled departure (epoch ms)
          est: parseAspNetDate(d.EDT),        // estimated departure
          act,                                // actual departure (null until completed)
          dev: d.Dev,                         // "HH:MM:SS" deviation (predicted now / actual when done)
          done,                               // completed = has actually departed
          status: d.StopStatusReportLabel,    // Scheduled / Departed / etc.
        }));
      }
    }
  }
  if (lines.length) { appendFileSync(LOG, lines.join('\n') + '\n'); written += lines.length; }
  if (seen.size > 300000) seen.clear(); // bound memory; mild re-logging after is fine
}

function loop() {
  if (stopped) return;
  polls += 1;
  const stopId = timepoints[idx];
  idx += 1;
  if (idx >= timepoints.length) {
    idx = 0; cycles += 1;
    const mins = ((Date.now() - startedAt) / 60000).toFixed(0);
    const mb = existsSync(LOG) ? (statSync(LOG).size / 1e6).toFixed(2) : '0';
    console.log(`[cycle ${cycles}, ${mins} min] ${timepoints.length} timepoints swept, rows ${written}, log ${mb} MB, errors ${errors}`);
  }
  pollStop(stopId).finally(() => { if (!stopped) setTimeout(loop, STEP_MS); });
}

function summary() {
  stopped = true;
  const mins = ((Date.now() - startedAt) / 60000).toFixed(0);
  const mb = existsSync(LOG) ? (statSync(LOG).size / 1e6).toFixed(2) : '0';
  console.log(`\nstopped. ${mins} min, ${polls} stop-polls, ${cycles} full cycles, ${written} rows (${mb} MB).`);
  process.exit(0);
}
process.on('SIGINT', summary);
process.on('SIGTERM', summary);

console.log(`reliability sampler: ${timepoints.length} timepoints, one every ${STEP_MS}ms (~${Math.round(timepoints.length * STEP_MS / 60000)} min/cycle) -> ${LOG}`);
console.log('Ctrl-C to stop (append-only; safe to resume).');
loop();
