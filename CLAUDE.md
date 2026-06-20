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
- [x] **1.5 Disambiguation (DONE, deployed 2026-06-19, the hard part).** Casing alone does NOT
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
        1. [DONE] Map-match all routes to the OSM road network. `scripts/match-routes.mjs`
           fetches OSM roads (Overpass -> `osm-src/roads.json`, gitignored; bbox
           covers the full route extent), builds a spatial grid, snaps each route's
           resampled points to the nearest road (bearing-filtered), groups into
           per-road runs, and rebuilds geometry from each road's own vertices so
           coincident routes share it exactly. Gaps (transit-center loops, lots)
           fall back to raw. 94.9% of points snap. Output `data/routes-matched-debug.geojson`
           (gitignored). View `match-preview.html` (raw vs matched toggle).
        2. [DONE] Spread the matched geometry. `spread-routes.mjs` now takes
           input/output paths; run on the matched file ->
           `data/routes-matched-spread-debug.geojson`. Clean parallel ribbons on the
           grid corridors (hub taper still applies). View `match-spread-preview.html`
           (stacked vs spread toggle). This is the current latest view.
        3. [DONE] Junction + corridor cleanup. AGREED BAR with Erik
           (2026-06-19): on a shared corridor, routes on the same street collapse to
           ONE clean centerline (stacked = a single line per shared segment) and the
           spread fans them into stable, non-crossing lanes. No sawtooth on
           Monroe/Division. (Pivot to committed hand-overrides only if that proves
           more efficient than the algorithm.)
           3a. [DONE] Reversal spikes. The memoryless nearest-edge matcher hops to a
               neighboring way for a few points, so the line juts sideways and comes
               straight back (turn ~180 deg over a few meters). Fixed with a surgical
               post-process in match-routes.mjs (`cleanup()`): dedupe near-coincident
               vertices, then iteratively drop interior vertices that BOTH turn sharper
               than 110 deg AND sit under 20 m from their neighbors' chord. Real
               corners turn at most ~90 deg; real turnarounds/one-way couplets travel
               farther, so the excursion guard keeps them. Reversals 115 -> 29 (worst
               offenders, routes 44/24, fully cleaned); remaining 29 are real downtown
               couplet jogs (21-59 m excursion), correctly kept. (Diagnostic
               `scripts/diag-junctions.mjs`; its "jumps" metric over-counts sparse-but-
               straight OSM vertices and is NOT a pathology signal.)
           3b. [DONE] Corridor sharing (the real disambiguation fix). Diagnosis: the
               downtown weave was NOT divided carriageways. Every case was the memoryless
               per-point matcher flickering onto whichever parallel adjacent OSM way was
               momentarily closest. Two changes, both in match-routes.mjs:
               (i) MERGE connected same-named OSM ways into one continuous corridor
                   centerline before matching (16165 ways -> 10698 corridors), so routes
                   on one street share its interior vertices. Generalizes the Division
                   spike. Fixed same-named fragments (Monroe) but not unnamed fragments
                   (Jefferson hops onto untagged ways) or station ways.
               (ii) CONNECTIVITY-AWARE matching (Viterbi, `matchSeq`): each point's cost
                   is its perpendicular distance to a corridor (RAW_EMIT if none), and
                   switching corridors between points costs SWITCH_PENALTY (20 m-equiv).
                   The cheapest path stays on one road through neighbors' brief pulls and
                   switches only at real turns. Handles named/unnamed/station uniformly.
               Result: Monroe routes now coincide EXACTLY (avg/max gap 0.00 m). Reversals
               29 -> 4. Jefferson weave gone (red clean; some routes keep mild wobble from
               raw-GPS fallback where the shape sits >SNAP_TOL off any road). Whole-system
               view is clean and legible. Remaining dense spot: the hub (Rapid Central
               Station, ~19 routes) - the step-4 hub-and-spoke question, not corridor weave.
           3c. [DONE] Direction merge + roundabouts (Erik's call). Each route was stored
               as TWO features (the two travel directions, same color), which weave on
               divided roads (Jefferson NB/SB are separate one-way carriageways ~10-35 m
               apart). match-routes.mjs now merges a route's two directions at the route
               level (`mergeDirections`): median line where the two run close and
               antiparallel (< MERGE_TOL 45 m), both legs where they genuinely split (one-
               way couplet a block apart). 48 direction-lines -> 25 per-route lines; divided
               carriageways collapse to one median; Jefferson is a single clean line.
               `deRoundabout` straightens passes through the ~65 small Heritage Hill
               roundabouts. Outputs data/routes-merged-debug.geojson; spread-routes.mjs runs
               on it (handles MultiLineString couplet legs) -> routes-merged-spread-debug.
           3d. [DONE] Hand-finish tooling (Erik will use). editor.html: load the merged+
               spread lines, click to select a route, drag/add/right-click-delete vertices,
               Export downloads route-overrides.geojson. data/route-overrides.geojson is
               COMMITTED (the "human disposes" half); each feature's routeId replaces the
               algorithm line for that route. Erik hand-cleans the hub, junctions, and any
               residual wobble. (Applying overrides into the deployed build is step 4.)
        4. [DONE] Hand-finish, polish pass, and bake (deployed). AGREED DIVISION OF
           LABOR (2026-06-19): Erik hand-edits the STRUCTURE in editor.html (which road,
           the order of routes across a bundle, how routes relate, hub untangling); the
           ALGORITHM then does the finish in scripts/polish-routes.mjs. Sequence:
           a. [DONE] Erik roughed in structure by hand -> route-overrides.geojson
              (committed, 25 routes). scripts/polish-routes.mjs reads it and runs:
              - STITCH: keep all his pieces, bridge gaps at junctions (<120 m) with short
                connectors. Tried re-threading along the original GTFS shape but it DROPS
                geometry that runs past the original representative trip (route 8 goes
                ~1.5 km beyond it), so we bridge within his geometry instead. [DONE]
              - SMOOTH: 3 passes 1-2-1. [DONE]
              - EVEN-SPACING: per-vertex perpendicular shift to even the gaps, order READ
                from his positions (sorted signed offset), continuous per-line perpendicular
                so near-N/S corridors like Monroe do NOT wobble, heavy shift-smoothing,
                hub taper. [DONE, works well]
              - HUB: BLACK BOX (revised from the node/spokes idea, which starbursted). Clip
                routes at a vertical rounded-rect zone (baked center [-85.67302, 42.95863],
                222x435 m) and draw the zone + station marker. Hand-positioned by Erik via the
                draggable box in polish-preview.html. [DONE]
              Output data/routes-final.geojson (COMMITTED). View polish-preview.html (toggle
              input vs polished; drag the hub box). Run: node scripts/polish-routes.mjs.
           b. [DONE] Baked + deployed: index.html draws data/routes-final.geojson (routes +
              hubzone fill/outline + station marker; route-drawing made robust to a slow
              basemap). Raw routes.geojson draw retired. Live at gr-bus-map.netlify.app.
           HUB APPROACH (decided with Erik 2026-06-19, REVISED to a black box): the hub
           knot (~19 routes converging downtown) is too messy to show truthfully. First we
           tried collapsing to a station NODE with spokes - the north side fanned into an
           ugly starburst. Erik's call instead: treat the hub as a BLACK BOX. Define a zone
           (ellipse centered on the measured convergence [-85.6732, 42.96004], ~320 m E-W x
           855 m N-S dense area), CLIP every route at the zone boundary (drop the inside),
           and draw the zone outline + a station marker. Routes stop at the boundary; the
           ~5 entry points and a nicer inside are a LATER refinement. For live buses (rung
           2): a bus inside the zone reads as "at the hub", exact position not shown. Erik
           does NOT hand-clean the hub interior. `inZone`/`hubClip`/zone-polygon are in
           scripts/polish-routes.mjs; the box is hand-tunable (center + semi-axes).
           editor.html has: select/drag/add/Delete, Shift-box multi-select + group move,
           Straighten + Smooth (on the selection), localStorage auto-save, Export.
           KNOWN ISSUES to fix in the polish pass (flagged by Erik 2026-06-19 while
           hand-editing; left for later, not urgent):
           - Residual double tracks: some spots still show both inbound + outbound on
             the SAME street (direction-merge misses: divided carriageways > MERGE_TOL
             45 m apart, or one direction fell back to raw GPS and didn't pair). Must be
             distinguished from real one-way couplets (two directions a block apart on
             DIFFERENT streets), which are correct and stay as two lines.
           - Fragmented geometry: a merged route is a MultiLineString of pieces (shared
             median, couplet legs, and gaps where the match dropped at transit-center
             loops / layovers / parking). Pieces are disconnected and their joins are
             implicit. Pass should stitch them into continuous lines.
      - PIPELINE (source -> deployed geometry):
          node scripts/match-routes.mjs   # GTFS routes.geojson -> OSM corridors (name-merge +
                                          # Viterbi) + direction merge + roundabouts. Needs
                                          # osm-src/roads.json (Overpass, gitignored).
          (hand-finish in editor.html -> data/route-overrides.geojson, COMMITTED, 25 routes)
          node scripts/polish-routes.mjs  # overrides -> stitch + smooth + even-spacing + hub
                                          # black box -> data/routes-final.geojson (COMMITTED,
                                          # what index.html draws). NOCLIP=1 reopens the hub box.
        Preview the pass with polish-preview.html (input vs polished; drag the hub box, read the
        readout, then bake its center/size into polish-routes.mjs). Re-run polish-routes.mjs
        after any override edit, commit routes-final.geojson, push to deploy.
      - PARKED refinements (not blocking, Erik's call later): residual tangle just NW of the
        hub box (river crossing) + crisp ~5 entry gates; residual double-tracks vs real one-way
        couplets; even-spacing / smoothing fine-tune; hub box styling (quiet grey placeholder).
      - Pruned 2026-06-19 (superseded rung-1.5 scratch, in git history): debug-corridors,
        spread-preview, spike-division, match-preview, match-spread-preview pages; scripts
        detect-corridors, spike-division, diag-junctions. KEPT: lib-corridors.mjs (match-routes
        imports it), spread-routes.mjs (makes the editor's pre-spread starting geometry).
        Live HTML now: index.html (deployed), editor.html, polish-preview.html.
- [x] **2. Live buses (DONE, verified locally 2026-06-19, NOT yet pushed).** `rapid.js`
      wired into index.html (the inline script is now `type="module"` so it can `import
      { pollVehicles }`). One GetAllVehiclesForRoutes call per sweep for the 25 drawn route
      IDs: the multi-route `routeIDs=a,b,c` param is confirmed working (one 200 per poll,
      every 10s, CORS open, no proxy). Each bus is a circle in a new `vehicles` source/layer,
      colored by route (`colorById`, keyed by String(routeId) read from routes-final.geojson;
      unknown route -> quiet grey `#555`), white casing, added with no beforeId so the dots sit
      ABOVE everything incl. labels (the buses are the point). A bus inside the hub black box is
      dropped via ray-cast `pointInRing` against the hubzone polygon: it reads as "at the hub"
      (the station marker), not a fake exact spot. colorById + the hub ring are both read from
      the same routes-final.geojson the map draws (one source of truth). Verified in the browser
      preview: 39 live buses plotted as colored dots, index.html's own layers throw no errors.
      NEXT: commit + push to deploy. Then rung 3 makes them glide between polls.
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
