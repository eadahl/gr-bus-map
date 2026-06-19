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
- [ ] **1.5 Disambiguation (NEXT, the hard part).** Casing alone does NOT fix
      routes sharing the exact same centerline (the downtown knot): the top line
      hides the rest. This supersedes HANDOFF.md's claim that casing is "the
      single technique" for bundled legibility. Solution: NYC-style parallel
      line spreading. Reference behavior: nycsubway.figma.site.
      - **Architecture decision:** hybrid. Algorithm proposes, human disposes.
        Pure line-ordering is NP-hard and never clean; every polished transit
        map is algorithm-assisted but hand-finished. Manual overrides get
        committed as data.
      - **The crux:** bus GTFS shapes are noisy and do NOT share exact coords
        even on the same street, so we must DETECT coincidence with tolerance
        before we can spread. Nail detection and the offset math is mechanical.
      - **Rungs (smallest-risk first, each one viewable):**
        1. [DONE] Coincidence detection + debug view.
           `scripts/detect-corridors.mjs` resamples each route line to evenly
           spaced points with a local bearing, spatial-hashes them, and counts
           distinct routes within tolerance (18m, bearing within 25 deg mod 180
           so antiparallel directions match). Output: `data/corridors-debug.geojson`
           (gitignored, regenerable). View with `debug-corridors.html` (standalone,
           not linked from index.html, not the deployed map): segments colored and
           fattened by multiplicity. Validated: finds the downtown knot (19 routes
           at Rapid Central Station) and Division Ave as a hot spine; corridor
           membership nests cleanly as routes converge (2:{27,44} -> 3:+28 -> ...
           -> 19:nearly all), which is the tell that detection is real, not noise.
           Tolerances live at the top of detect-corridors.mjs (SPACING/TOL/BEARING_TOL).
        2. [NEXT] Algorithmic spreading. Order routes per corridor, bake parallel
           offsets into the geometry (build-routes.mjs). NYC-style baseline. Build
           on the per-point multiplicity from rung 1: the corridor groups and
           bearings are already computed there.
        3. Workbench (internal, never deployed). Local tool to inspect and
           hand-tune ordering/offsets, exports an overrides JSON the build
           script honors. Where it goes from "mostly right" to "good."
      - To resume: "start route disambiguation, rung 2."
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
