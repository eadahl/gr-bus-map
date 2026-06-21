// build-stops.mjs
//
// One-time builder for the stops layer (rung 4). Fetches GetAllStops once and
// writes data/stops.geojson (COMMITTED), so the deployed map draws stops from a
// static asset and never hits the API at runtime (same rule as the routes).
// Carries `timepoint` (IsTimePoint) so the map can tier stops by importance.
//
// Re-run when the stop set changes (seasonal): node scripts/build-stops.mjs

import { writeFileSync } from 'node:fs';

const URL = 'https://connect.ridetherapid.org/InfoPoint/rest/Stops/GetAllStops';
const OUT = 'data/stops.geojson';

const stops = await (await fetch(URL)).json();
const features = stops
  .filter((s) => s.Latitude != null && s.Longitude != null)
  .map((s) => ({
    type: 'Feature',
    properties: { stopId: s.StopId, name: s.Name, timepoint: !!s.IsTimePoint },
    geometry: { type: 'Point', coordinates: [s.Longitude, s.Latitude] },
  }));

writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`wrote ${features.length} stops (${features.filter((f) => f.properties.timepoint).length} timepoints) to ${OUT}`);
