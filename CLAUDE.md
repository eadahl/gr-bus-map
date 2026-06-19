# CLAUDE.md

Orientation for any Claude Code session in this repo. Read this first.
For the full brief and rationale, see [HANDOFF.md](HANDOFF.md).

## What this is

A calm, near-white real-time bus map for The Rapid (Grand Rapids, MI), built
with MapLibre GL JS. The basemap recedes; the real route colors and live buses
do the work. Desktop "whole-system" view first; mobile wayfinding is phase two.

Reference register: https://nycsubway.figma.site/ (near-white, colored lines carry it).

## Live now

- Deployed: https://gr-bus-map.netlify.app/
- Repo: https://github.com/eadahl/gr-bus-map
- Netlify auto-deploys on every push to `main`. No build step (pure static).

## Build ladder (status)

- [x] **0. Scaffold.** Positron basemap on Grand Rapids, deployed to Netlify.
      Added a quiet labels on/off toggle.
- [ ] **1. Routes.** Parse `shapes.txt` + `routes.txt` (GTFS) to GeoJSON. Draw
      colored lines with white casing and rounded joins. (NEXT)
- [ ] **2. Live buses.** Wire in `rapid.js`. Dots that update.
- [ ] **3. Calm motion.** Interpolate bus position between polls so they glide.
- [ ] **4. Stops.** Parse `stops.txt` to GeoJSON. Zoom-based fade-in.
- [ ] **5. Filter and focus.** Select a route, recede the rest. Quiet detail panel.
- [ ] **6. Phase two (mobile).** Scout arrivals endpoint, build wayfinding face.

## Stack and conventions

- **MapLibre GL JS**, pinned to 4.7.1 (CDN, no API key).
- **Basemap:** Carto Positron labeled (`positron-gl-style`) for now. Endgame is a
  self-contained Protomaps `.pmtiles` asset. Label curation (major names at rest,
  rest on focus) is a later refinement, not yet done.
- **No build step.** `index.html` is served as-is. Netlify build command and
  publish dir are both empty.
- **Local dev:** `python3 -m http.server 8000`, then open http://localhost:8000.
- **Deploy:** `git add . && git commit -m "..." && git push`. That is the whole loop.

## Data layer (key facts, do not get these wrong)

- Live vehicles: `https://connect.ridetherapid.org/InfoPoint/rest/Vehicles/GetAllVehiclesForRoutes?routeIDs=<id>`.
  CORS is open (`Access-Control-Allow-Origin: *`), verified 2026-06-19. Call it
  directly from the browser. **No serverless proxy. No Netlify Functions.**
- **Privacy:** the raw feed exposes `DriverName`. Never surface it. `rapid.js`
  already drops driver fields from the normalized shape. Keep it that way.
- Static GTFS (routes, shapes, stops) is seasonal. **Parse once, commit as static
  GeoJSON.** Do not fetch or parse it at runtime.
- `rapid.js` is the fetch/normalize/poll layer, committed and ready. Not yet wired
  into the map (that is rung 2). Exposes `fetchVehicles`, `fetchRoutes`,
  `fetchAllVehicles`, `pollVehicles`.

## Working preferences (Erik)

- **No em-dashes, ever.** Use periods, commas, colons, parentheses.
- Plain and direct. No AI-sounding prose, no flattery, no filler.
- Prefers honest challenge over reassurance. Push back when something is wrong.
- Bricolage / maker sensibility: self-contained, honest, veridical-first builds.
- Brand: Outfit 800, IBM Plex Mono, black and white, no decorative color.
  **Route colors are the deliberate, principled exception** (real wayfinding data).
- Touchstones: Calm Technology, Super Normal, wabi-sabi, ma.
- Erik is newer to Claude Code: explain commands, work in small reversible steps.
