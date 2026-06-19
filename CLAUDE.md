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
- [x] **1. Routes.** `scripts/build-routes.mjs` parses GTFS to
      `data/routes.geojson` (one representative line per route+direction, real
      colors). Map draws white casing + colored line, rounded joins, inserted
      above roads/buildings and below labels.
- [ ] **1.5 Disambiguation (IN PROGRESS, the hard part).** Casing alone does NOT
      fix routes sharing the same centerline (the downtown knot): the top line
      hides the rest. This supersedes HANDOFF.md's claim that casing is "the
      single technique" for bundled legibility. Solution: NYC-style parallel
      line spreading. Reference behavior: nycsubway.figma.site.
      - **Architecture decision:** hybrid. Algorithm proposes, human disposes.
        Every polished transit map is algorithm-assisted but hand-finished.
        Manual overrides get committed as data.
      - **DIRECTION CHANGE (2026-06-19), the important part.** The first approach
        treated the noisy GTFS GPS as truth and tried to spread it: detect
        coincidence with tolerance, then offset jittery points. That is a local
        maximum. The better foundation, decided with Erik, is to NORMALIZE routes
        onto the actual road network first: map-match each GTFS shape to the OSM
        roads it drives, so the line clearly and smoothly follows the road and
        coincident routes share EXACT geometry. Then coincidence is exact (shared
        road edges, no tolerance), spreading is a clean parallel offset, and
        smoothness is inherent. The hard disambiguation problem dissolves instead
        of being optimized around. Success criteria: the line clearly communicates
        which road the route is on, and routes are smooth, appealing, easy to
        follow, and easy to tell apart. Faithful to the road, not to the raw GPS
        (NYC subway map is schematic, not a survey).
      - **Validated by a spike (Division Ave):** pulled OSM roads from Overpass,
        merged the Division centerline, snapped routes 1 and 90 onto it, and they
        rendered as clean parallel road-following lanes. See `scripts/spike-division.mjs`
        and `spike-division.html` (throwaway reference, may be deleted).
      - **Superseded earlier work (kept on disk as reference, not the path forward):**
        - `scripts/detect-corridors.mjs` + `debug-corridors.html`: coincidence
          detection on noisy GPS (found the 19-route knot, Division spine).
        - `scripts/lib-corridors.mjs`: shared detect pipeline (project, resample,
          spatial-hash, count). Some helpers (projection, geometry) still useful.
        - `scripts/spread-routes.mjs` + `spread-preview.html`: offset-the-GPS
          spreading with a hub taper. The spreading CONCEPT carries over; the
          noisy-GPS basis does not.
      - **Plan (road-matching build, smallest-risk first, each viewable):**
        1. [NEXT] Map-match all routes to the OSM road graph. Build a graph from
           `osm-src/roads.json` (Overpass, gitignored), snap each route to the road
           edges it traverses, reconstruct clean geometry from those edges. Start
           with the simplest method that works (nearest-edge + bearing, guided by
           the already-decent shape), evaluate vs the raw shapes, add heavier
           matching only where it fails. Output committed as static GeoJSON
           (runtime stays pure). Hand-overrides for mismatches (transit center,
           one-way pairs) committed as data.
        2. Redo coincidence + spreading on the matched geometry (now exact and
           clean), then bake into build-routes.mjs and the deployed map.
        3. Workbench (internal, never deployed) if hand-tuning is still needed.
      - To resume: "continue the road-matching build."
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
