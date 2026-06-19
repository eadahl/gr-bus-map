// build-routes.mjs
//
// One-time, build-time parser. Turns The Rapid's static GTFS feed into a
// map-ready GeoJSON of route lines, each carrying its real wayfinding color.
//
// GTFS is seasonal and rarely changes, so we run this offline and commit the
// output (data/routes.geojson). The map never fetches or parses GTFS at runtime.
//
// Chain: routes.txt (color) -> trips.txt (shape belongs to which route) ->
//        shapes.txt (the actual path points).
//
// To regenerate after a feed update:
//   1. re-download the zip into gtfs-src/ (see CLAUDE.md / HANDOFF.md)
//   2. node scripts/build-routes.mjs
//
// Usage: node scripts/build-routes.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'gtfs-src';
const OUT = 'data/routes.geojson';

// Minimal CSV parser. Handles double-quoted fields that contain commas
// (e.g. route_long_name "Madison Route"). GTFS does not use embedded quotes
// in this feed, so we keep it simple: split on commas outside of quotes.
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const read = (name) => parseCsv(readFileSync(join(SRC, name), 'utf8'));

// routes.txt -> route_id => { color, names }
// route_color is a bare hex (e.g. ED1C24). Prefix '#'. Fall back to a mid grey
// for any route that ships without a color, so nothing renders invisible.
const routes = new Map();
for (const r of read('routes.txt')) {
  routes.set(r.route_id, {
    routeId: r.route_id,
    shortName: r.route_short_name,
    longName: r.route_long_name,
    color: r.route_color ? `#${r.route_color}` : '#888888',
    textColor: r.route_text_color ? `#${r.route_text_color}` : '#ffffff',
  });
}

// trips.txt -> shape_id => { routeId, directionId }
// A shape is directional and belongs to one route; first trip wins.
const shapeMeta = new Map();
for (const t of read('trips.txt')) {
  if (!t.shape_id || shapeMeta.has(t.shape_id)) continue;
  shapeMeta.set(t.shape_id, { routeId: t.route_id, directionId: t.direction_id });
}

// shapes.txt -> shape_id => ordered [lon, lat] coordinates
const shapePoints = new Map();
for (const p of read('shapes.txt')) {
  if (!shapePoints.has(p.shape_id)) shapePoints.set(p.shape_id, []);
  shapePoints.get(p.shape_id).push({
    seq: Number(p.shape_pt_sequence),
    lon: Number(p.shape_pt_lon),
    lat: Number(p.shape_pt_lat),
  });
}

// Pick one representative shape per (route, direction): the one with the most
// points, i.e. the most complete variant. Collapses near-duplicate branches and
// short-turns into a single clean line so the white casing stays crisp.
const best = new Map(); // key "routeId|directionId" => { shapeId, count }
for (const [shapeId, meta] of shapeMeta) {
  const pts = shapePoints.get(shapeId);
  if (!pts || !routes.has(meta.routeId)) continue;
  const key = `${meta.routeId}|${meta.directionId}`;
  const prev = best.get(key);
  if (!prev || pts.length > prev.count) best.set(key, { shapeId, count: pts.length });
}

const features = [];
for (const [key, { shapeId }] of best) {
  const route = routes.get(key.split('|')[0]);
  const coords = shapePoints.get(shapeId)
    .sort((a, b) => a.seq - b.seq)
    .map((p) => [p.lon, p.lat]);
  features.push({
    type: 'Feature',
    properties: {
      routeId: route.routeId,
      shortName: route.shortName,
      longName: route.longName,
      color: route.color,
    },
    geometry: { type: 'LineString', coordinates: coords },
  });
}

// Draw longer lines first so shorter ones layer on top (minor visual nicety).
features.sort((a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length);

mkdirSync('data', { recursive: true });
writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));

console.log(`routes: ${routes.size}`);
console.log(`representative line features: ${features.length}`);
console.log(`wrote ${OUT}`);
