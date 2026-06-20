// collect-vehicles.mjs
//
// Offline data collector for the "build accurate routes from accumulated GPS"
// idea. Polls The Rapid's live vehicle feed and appends each NEW position to a
// log. Run it over time (ideally a full service week) to capture every trip
// pattern, branch, short-turn, and real-world deviation the buses actually drive.
// A later script reconstructs route geometry from this log.
//
// This is build tooling, not the runtime map: it runs on your machine, writes a
// gitignored log, and we commit only the DERIVED geometry later (same "parse
// once, commit static" rule as build-routes.mjs).
//
// PRIVACY: the raw feed exposes DriverName / driver + farebox fields. This
// collector uses a strict ALLOWLIST: it copies only the fields named below, so
// driver/farebox data is never even read into the log. Keep it that way.
//
// Usage:
//   node scripts/collect-vehicles.mjs            # poll forever, Ctrl-C to stop
//   node scripts/collect-vehicles.mjs --interval 15   # seconds between polls
//
// Leave it running in a spare terminal (or: nohup node scripts/collect-vehicles.mjs &).
// Ctrl-C prints a summary and exits cleanly; the log is append-only so you can
// stop and restart any time without losing data.

import { readFileSync, appendFileSync, existsSync, statSync } from 'node:fs';

const BASE = 'https://connect.ridetherapid.org/InfoPoint/rest';
const LOG = 'data/vehicle-log.ndjson';
const ROUTES_FINAL = 'data/routes-final.geojson';

// Seconds between polls. The agency map refreshes ~every 10s; 12s is polite and
// still catches movement at city speeds.
const intervalArg = process.argv.indexOf('--interval');
const INTERVAL_S = intervalArg > -1 ? Number(process.argv[intervalArg + 1]) || 12 : 12;

// The route IDs we draw, read from the same committed file the map uses, so the
// collector and the map always agree on the route set (one source of truth).
function routeIds() {
  const g = JSON.parse(readFileSync(ROUTES_FINAL, 'utf8'));
  return g.features.filter((f) => !f.properties.kind).map((f) => String(f.properties.routeId));
}

// "/Date(1781877723000-0400)/" -> epoch ms (the absolute GPS fix time).
function parseAspNetDate(value) {
  if (!value) return null;
  const m = /\/Date\((\d+)/.exec(value);
  return m ? Number(m[1]) : null;
}

const IDS = routeIds();

// Last logged "lat,lon" per vehicle, so a parked or idling bus reporting the same
// spot every poll does not bloat the log. We only append when a bus has moved (or
// started a new trip). Reconstruction wants the path, not the dwell.
const lastPos = new Map();

let polls = 0;
let written = 0;
let errors = 0;
const startedAt = Date.now();

async function tick() {
  polls += 1;
  let data;
  try {
    const url = `${BASE}/Vehicles/GetAllVehiclesForRoutes?routeIDs=${IDS.join(',')}&_=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    errors += 1;
    console.warn(`[poll ${polls}] fetch failed: ${err.message}`);
    return;
  }

  const lines = [];
  for (const v of data) {
    if (v.Latitude == null || v.Longitude == null) continue;
    const key = `${v.VehicleId}`;
    const posKey = `${v.TripId}|${v.Latitude},${v.Longitude}`;
    if (lastPos.get(key) === posKey) continue; // hasn't moved since last log
    lastPos.set(key, posKey);

    // Strict allowlist. Driver/farebox fields are deliberately never copied.
    lines.push(JSON.stringify({
      fixTime: parseAspNetDate(v.LastUpdated), // epoch ms of the GPS fix
      vehicleId: String(v.VehicleId),
      routeId: String(v.RouteId),
      tripId: v.TripId != null ? String(v.TripId) : null, // the key that lets us stitch one run
      runId: v.RunId != null ? String(v.RunId) : null,
      dir: v.DirectionLong || null,        // "Northbound" etc.
      dest: v.Destination || null,         // "Target-Rivertown" etc. (reveals the branch)
      lat: v.Latitude,
      lon: v.Longitude,
      heading: v.Heading,
      speed: v.Speed,
      status: v.OpStatus,
    }));
  }

  if (lines.length) {
    appendFileSync(LOG, lines.join('\n') + '\n');
    written += lines.length;
  }

  // Progress heartbeat every 10 polls (~2 min at 12s).
  if (polls % 10 === 0) {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    const mb = existsSync(LOG) ? (statSync(LOG).size / 1e6).toFixed(2) : '0';
    console.log(`[${mins} min] polls ${polls}, rows written ${written}, fleet seen ${lastPos.size}, log ${mb} MB, errors ${errors}`);
  }
}

function summary() {
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  const mb = existsSync(LOG) ? (statSync(LOG).size / 1e6).toFixed(2) : '0';
  console.log(`\nstopped. ${mins} min, ${polls} polls, ${written} rows this run, ${lastPos.size} vehicles seen, log ${mb} MB at ${LOG}`);
  process.exit(0);
}
process.on('SIGINT', summary);
process.on('SIGTERM', summary);

console.log(`collecting ${IDS.length} routes every ${INTERVAL_S}s -> ${LOG}`);
console.log('Ctrl-C to stop (append-only; safe to resume later).');
await tick();
setInterval(tick, INTERVAL_S * 1000);
