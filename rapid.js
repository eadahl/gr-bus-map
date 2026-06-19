// rapid.js — live vehicle feed for The Rapid (Grand Rapids, MI)
//
// Source: Avail InfoPoint REST API at connect.ridetherapid.org
// Verified 2026-06-19 against the agency's own myStop map:
//   • Access-Control-Allow-Origin: *   → safe to call directly from a browser, no proxy
//   • https, GET, application/json      → no mixed-content, no auth, no cookie gating
//
// The map polls one route at a time. This module wraps that, normalizes the
// shape, parses the ASP.NET date, and adds a polite poller.

const BASE = 'https://connect.ridetherapid.org/InfoPoint/rest';

// InfoPoint returns ASP.NET-style dates: "/Date(1781877723000-0400)/"
// The leading number is Unix epoch milliseconds (already absolute UTC).
// The trailing offset is the source timezone and can be ignored.
function parseAspNetDate(value) {
  if (!value) return null;
  const m = /\/Date\((\d+)/.exec(value);
  return m ? new Date(Number(m[1])) : null;
}

// Map one raw InfoPoint vehicle to a clean, stable shape.
// Driver name/farebox fields are intentionally dropped — see README note.
function normalizeVehicle(v) {
  return {
    id: String(v.VehicleId),
    routeId: v.RouteId,
    name: v.Name,                 // fleet/coach number as a string, e.g. "2008"
    lat: v.Latitude,
    lon: v.Longitude,
    heading: v.Heading,           // degrees, 0 = north, clockwise
    speed: v.Speed,               // likely mph — confirm against a known bus if it matters
    destination: v.Destination,   // "Central Station"
    direction: v.DirectionLong,   // "Northbound"
    lastStop: v.LastStop,         // "Kalamazoo/Orville (NB)"
    status: v.OpStatus,           // "ONTIME", etc.
    deviationMin: v.Deviation,    // minutes off schedule, or null
    occupancy: v.OccupancyStatusReportLabel, // "Empty", etc.
    commStatus: v.CommStatus,     // "GOOD" — stale if not
    updatedAt: parseAspNetDate(v.LastUpdated),
  };
}

// Fetch vehicles for one or more route IDs.
// routeIds: a single id (2) or an array ([2, 5]).
// NOTE: comma-separated multi-route is an inference from the plural `routeIDs`
// param — the map only ever requests one. Verify before relying on it; if it
// rejects multiples, use fetchAllVehicles() which fans out one call per route.
export async function fetchVehicles(routeIds) {
  const ids = Array.isArray(routeIds) ? routeIds : [routeIds];
  const url = `${BASE}/Vehicles/GetAllVehiclesForRoutes`
    + `?routeIDs=${ids.join(',')}`
    + `&_=${Date.now()}`; // cache-buster, mirrors the agency map
  const res = await fetch(url);
  if (!res.ok) throw new Error(`InfoPoint vehicles ${res.status}`);
  const data = await res.json();
  return data.map(normalizeVehicle);
}

// Fetch the route catalog (LL, SL, 1, 2, 3 ... 1000).
// Field names not yet verified — confirm the id key (RouteId vs RouteID) from
// the GetVisibleRoutes response in your network tab before trusting fetchAllVehicles.
export async function fetchRoutes() {
  const res = await fetch(`${BASE}/Routes/GetVisibleRoutes?_=${Date.now()}`);
  if (!res.ok) throw new Error(`InfoPoint routes ${res.status}`);
  return res.json();
}

// Convenience: every bus on every visible route.
// Fans out one request per route and flattens — works regardless of whether
// the multi-route param is supported. Polite-ish; ~25 routes per sweep.
export async function fetchAllVehicles() {
  const routes = await fetchRoutes();
  const ids = routes.map(r => r.RouteId); // adjust key if GetVisibleRoutes differs
  const batches = await Promise.all(
    ids.map(id => fetchVehicles(id).catch(() => [])) // a dead route shouldn't kill the sweep
  );
  return batches.flat();
}

// Poll on an interval. Returns a stop() function.
// Uses setTimeout chaining (not setInterval) so a slow response never stacks.
// fetcher defaults to a single route; pass fetchAllVehicles for the whole system.
export function pollVehicles(routeIds, onUpdate, opts = {}) {
  const { intervalMs = 10000, onError, fetcher = fetchVehicles } = opts;
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const vehicles = await fetcher(routeIds);
      if (!stopped) onUpdate(vehicles);
    } catch (err) {
      if (onError) onError(err);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  tick(); // fire immediately, then every intervalMs
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// ── usage ──────────────────────────────────────────────────────────────
// import { pollVehicles, fetchAllVehicles } from './rapid.js';
//
// // one route (route 2 = Kalamazoo), updating every 10s:
// const stop = pollVehicles(2, vehicles => {
//   vehicles.forEach(v => console.log(v.name, v.lat, v.lon, v.heading));
// });
//
// // whole system:
// const stopAll = pollVehicles(null, render, { fetcher: fetchAllVehicles });
//
// // later: stop();  /  stopAll();
