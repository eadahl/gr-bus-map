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
- [x] **2. Live buses (DONE + deployed 2026-06-19, commit b4a1e31; pinning follow-up after).**
      `rapid.js` wired into index.html (the inline script is now `type="module"` so it can
      `import { pollVehicles }`). One GetAllVehiclesForRoutes call per sweep for the 25 drawn
      route IDs: the multi-route `routeIDs=a,b,c` param is confirmed working (one 200 per poll,
      every 10s, CORS open, no proxy). Each bus is a circle in a new `vehicles` source/layer,
      colored by route (`colorById`, keyed by String(routeId) read from routes-final.geojson;
      unknown route -> quiet grey `#555`), white casing, added with no beforeId so the dots sit
      ABOVE everything incl. labels (the buses are the point). A bus inside the hub black box is
      dropped via ray-cast `pointInRing` against the hubzone polygon: it reads as "at the hub"
      (the station marker), not a fake exact spot. colorById + the hub ring are both read from
      the same routes-final.geojson the map draws (one source of truth).
      - **PINNED TO ROUTES (the important follow-up, 2026-06-19).** First cut plotted buses at raw
        GPS and they floated OFF the ribbons: the drawn lines are NOT raw GPS (map-matched to OSM
        roads, merged, spread into parallel lanes, smoothed, even-spaced), so true GPS never lands
        on the displayed line. Fix: snap each bus to the nearest point on ITS OWN route's drawn
        geometry (`geomById` per routeId, read from routes-final; `snapToPaths` /
        `nearestOnSegment`, nearest-point in a cos(lat)-scaled planar space). Now the dot always
        rides the line. (Nearest-point, not sequence/direction-aware: that is a rung-3 refinement
        for smooth motion. Good enough and kills the floating dots.) Verified vs live feed: median
        snap shift ~7 m (the spread offset), ~85% of buses within 25 m.
      - **OFF-ROUTE = ANOMALY (Erik's call).** The drawn lines come from one representative trip
        (hand-edited, polished, hub-clipped), so they do NOT cover every branch / full extent. A
        live bus on uncovered track snaps far (a route 24 bus to Target-Rivertown was 1163 m off;
        the drawn line doesn't reach that branch). Erik's model: pinned = primary/trusted/accurate,
        but a bus genuinely off its regular route should still be SHOWN, visibly flagged as an
        anomaly, not silently dropped or fake-pinned. So: within `SNAP_MAX_M` (80 m) of the line ->
        pin (solid route-colored dot, trusted); farther (or no drawn line at all) -> plot at TRUE
        GPS with `anomaly:true`, drawn as a HOLLOW route-colored ring (near-white fill, thicker
        colored stroke) so it reads as approximate / off the standard route. Data-driven via a
        `case` on the `anomaly` prop in the vehicles-layer paint. The far snaps are a GEOMETRY-
        COVERAGE gap (drawn lines miss some branches), a separate later fix in the match/polish
        pipeline; the rendering is done.
      Verified in the browser preview: one poll = 25 pinned solid dots on their ribbons + 3
      hollow-ring anomalies at true GPS + 1 dropped at hub; no errors from index.html's own layers.
      Then rung 3 makes them glide between polls.
- **COVERAGE / ACCURATE ROUTES FROM ACCUMULATED GPS (initiative, started 2026-06-19).** Why: the
  anomaly rings above are a coverage gap. The drawn lines miss branches / full extent, so off-route
  buses can't pin. Erik wants to fix this by accumulating real bus positions over time and building
  geometry from where buses ACTUALLY drive.
  - KEY PIPELINE FACT (verified): the deployed map is NOT regenerable from GTFS. `polish-routes.mjs`
    reads `data/route-overrides.geojson` (Erik's HAND geometry) and writes `routes-final.geojson`.
    `build-routes.mjs` / `match-routes.mjs` only make the STARTING geometry Erik edited from. So
    "use all GTFS shapes" alone does NOT fix the deployed coverage gap: a branch only reaches the
    screen if it gets into the hand geometry (or a new finish) and through polish. (`build-routes.mjs`
    line 86-96 picks ONE shape per route+direction, the longest; that is where branches drop. GTFS
    `shapes.txt` does contain every pattern: ~380 shapes across 25 routes, most are duplicates of a
    few distinct patterns per direction. Distinct patterns with real trip counts = the branches.)
  - [DONE] STEP 1: collector. `scripts/collect-vehicles.mjs` polls GetAllVehiclesForRoutes for the
    25 drawn routes every ~12s and appends each NEW position (dedup by vehicle+trip+latlon) to
    `data/vehicle-log.ndjson` (GITIGNORED; we commit only derived geometry). Strict field ALLOWLIST,
    so DriverName/farebox are never logged (verified: 0 leaks). Captures `tripId` (stitch one run),
    `dir`, `dest` (names the branch), lat/lon/heading/speed/fixTime, plus (added 2026-06-20)
    `status` (OpStatus ONTIME/LATE), `occ` (OccupancyStatus 0..6 bucket; OnBoard count is null so
    no headcount), `seats`/`totalCap` (vehicle size class), `stopId`, `comm`/`gps` (data trust).
    Dedup now triggers on a MOVE or a state change (occupancy/status/stop/comm), so delay accrual
    and crowding shifts are captured even while a bus sits still. NOTE: at first probe every bus
    read occ=0/Empty - logging will reveal whether occupancy is a live signal or always 0. Run it
    over time (a full service week is ideal): `node scripts/collect-vehicles.mjs`. Append-only,
    Ctrl-C is clean, safe to stop/resume.
  - [DONE] STEP 1b: coverage-gap finder (the cheap feedback loop). `scripts/find-coverage-gaps.mjs`
    reads the log + routes-final.geojson, snaps each logged position to its route's line with the
    SAME pin math + hub-zone exclusion the map uses, flags positions >80 m off (a coverage gap),
    and clusters them into ~150 m cells so recurring clusters name the missing segments (with the
    `dest` field). Run: `node scripts/find-coverage-gaps.mjs` (--all to list every cluster). Writes
    data/coverage-gaps.geojson (cluster centroids, gitignored). First small late-night run (109
    positions) already surfaced: routes 15+6 ~424 m off SW of the hub by the river (matches the
    known "river crossing" parked refinement), route 3 -> Target-RiverTown branch, route 51/DASH
    loop variant. Sample needs a full service week to be representative.
  - [DONE] STEP 1c: gap classification. find-coverage-gaps.mjs now tracks distinct trips/vehicles/
    time per cluster and splits SYSTEMATIC (>=3 distinct trips: real branches/detours) vs ONE-OFF
    (1 trip: GPS glitch / deadhead / layover). On ~9 h of data: 70% of off-route points are
    systematic, concentrated on undrawn southern branches (10/3 Pine Rest + Target-Rivertown, 1/24
    UM Health West). Caveat baked into the tool's framing: "off route" = off the line WE DREW, not
    off the bus's scheduled route; most flags are our map being incomplete, not buses deviating.
  - [DONE] STEP 2: reconstructor, FIRST PASS. `scripts/reconstruct-routes.mjs` (1) groups the log by
    (routeId, tripId) ordered by fixTime, (2) cleans each trip (dedup <8 m, drop >1500 m teleports,
    require >=6 pts and >=800 m), (3) clusters trips within (routeId, dir) into patterns by grid-
    signature Jaccard overlap (seed = longest trip, join if >=0.5; a divergent path = a branch), (4)
    builds ONE centerline per pattern = per-point MEDIAN of arc-length-resampled member trips (many
    overlapping runs average out GPS noise). Keeps patterns with >=3 trips (no one-offs). Stops
    BEFORE map-matching on purpose (first pass = validate grouping/clustering). On ~9 h: 132 usable
    trips -> 28 patterns across 15 routes; branches appeared exactly as predicted (1 -> UM Health
    West, 8 -> Target-Rivertown, 10 -> Pine Rest). Output data/routes-reconstructed-debug.geojson
    (GITIGNORED). View `reconstruct-preview.html` (reconstructed colored lines + faint current map +
    red gap dots sized by trips): the reconstructed lines run right through the gap clusters and
    extend past where the drawn map stops. Lines wobble (raw-GPS median, pre-map-match) = expected.
    Run: `node scripts/reconstruct-routes.mjs`. Tunables at top (MIN_PATTERN_TRIPS, SIM_THRESHOLD,
    resample N). Directions kept SEPARATE for now (agreed).
  - API DISCOVERY (2026-06-20): full surface mapped in [docs/rapid-api.md](docs/rapid-api.md).
    Three findings reshape this initiative:
    (a) DETOURS ARE PERVASIVE: 15 of 25 visible routes were detoured at probe time. A detoured
        route's KML trace filename flips to `Route{N}_DET_*.kml` (reroute baked in) and it carries
        a PublicMessages alert. So a reconstructed off-route segment may be a temporary detour, not
        a real branch. We MUST log detours (trace filenames + messages) over time, NOW, so historical
        GPS can be labeled detour-vs-branch. This is the one capture-it-now item (agreed with Erik).
    (b) THIRD BASE CANDIDATE: the agency's own `Route{N}.kml` geometry. The head-to-head base
        comparison is now THREE-way: GTFS shapes (current) vs official KML traces vs reconstructed GPS.
    (c) RELIABILITY DATA EXISTS: StopDepartures gives scheduled-vs-ACTUAL (`ADT`/`Dev`) per stop per
        trip. Enables an on-time/confidence layer, ghost-bus (missed-trip) detection, bunching. This
        is the big post-base-map feature direction Erik is excited about.
  - [DONE] STEP 2a: detour logger. `scripts/collect-detours.mjs` polls GetAllRoutes + PublicMessages
    every ~15 min, logs a snapshot (deduped on change) of detoured routes (by `_DET_` trace marker)
    and active messages (routes, window, reason) to data/detour-log.ndjson, and ARCHIVES every route's
    KML to data/detour-traces/ (both gitignored). The archive doubles as the official-geometry set for
    the three-way base compare. Verified: 15 routes detoured, 55 messages, 34 traces archived. Run it
    alongside the GPS collector: `node scripts/collect-detours.mjs`.
  - NEXT STEPS (not built yet): (2b) map-match the reconstructed patterns onto OSM
    roads with the existing match-routes machinery (also removes the raw-GPS wobble). (3) THREE-WAY
    base head-to-head (GTFS vs KML vs reconstructed GPS), then decide how the winning base reaches the
    screen: enrich the editor's starting geometry for hand-finish, vs a fuller algorithmic finish.
    Re-run reconstruct on a fuller (weekday + weekend) log first; several routes (3, 24, 44, 51, ...)
    had <3 trips in the weekend sample.
  - [DONE] STEP 2c: reliability sampler. `scripts/collect-reliability.mjs` rotates through the 270
    TIMEPOINT stops (IsTimePoint), one StopDepartures call every ~2.5s (~11 min/cycle), and logs each
    departure's schedule-vs-actual to data/reliability-log.ndjson (gitignored): sched (SDT), est (EDT),
    act (ADT, null until done), `dev` (HH:MM:SS, populated LIVE here unlike the vehicle feed), done,
    status. Keeps completed OR next-hour departures (drops far-future); dedups ~2 rows/departure
    (upcoming + completed). Foundation of the reliability/on-time/ghost-bus track: on-time perf
    (sched vs act), prediction accuracy (est vs act), ghost/missed trips (seen upcoming, never
    completed). Run: `node scripts/collect-reliability.mjs`. FIX 2026-06-20: dedup key now includes
    the dev MINUTE (`HH:MM`) so we re-log as predicted deviation evolves toward departure, not just
    once at first sighting (which was logging mostly dev=0 far-out values). FINDINGS so far: dev is
    one-sided (0..~15 min, NO early/negative buses); ACTUALS still elusive (0 done rows captured -
    departures complete and drop off between ~11-min stop revisits, so the beeswarm currently shows
    PREDICTED dev, not actual; faster revisit or a completion-catch strategy is a later fix).
    REALIZED CAPTURE 2026-06-20: confirmed the API NEVER reports a true actual departure (no ADT in
    practice) - a bus lingers as "Scheduled" with dev growing, then drops off. So "measured truth" =
    the dev observed AT/after the scheduled time (the last reading before it vanishes). Two fixes:
    Trip was an OBJECT not a scalar (now store `Trip.TripId` + `seq`=StopSequence; old rows have the
    object, the dashboard handles both); and the collector now RE-POLLS a stop ~90s after an imminent
    departure to capture the dev at departure time. The dashboard beeswarm now plots REALIZED dev (per
    departed trip, latest reading with t>=sched). First read: realized median ~3 min / ~80% >=1 min
    late, vs predicted median 0 / 27% - buses run later than far-out predictions imply. CAVEAT
    (selection bias): on-time buses depart at sched and drop off fast, late buses LINGER, so the set we
    can measure at departure skews late - the ~80% is inflated and coverage is low (most departures
    unmeasured). Improves as re-poll data accumulates. [DONE] The beeswarm now SPLITS predicted vs
    measured as a mirrored swarm (predicted-upcoming above the axis, measured-departed below, shared
    deviation scale): the gap is plainly visible - predicted piles at on-time, measured pushes right
    into 5-10 min. Predicted ~244 (median 0, ~32% late) vs measured ~51 (median 3.3, ~84% late; biased
    late + sparse, per the caveat).
  - THREE COLLECTORS now run together (keep all alive while gathering): collect-vehicles (GPS +
    occupancy, ~12s), collect-detours (~15 min), collect-reliability (~2.5s/stop). Crowding stories
    ride on the Vehicles `occ` field (pending: is it ever non-zero?).
  - OBSERVABILITY DASHBOARD: `observe.html` (dev tool, local only - reads the gitignored logs +
    hits the live APIs; open localhost:8000/observe.html). ONE TABBED page (Erik's call: all interim
    artifacts in one place):
    - LIVE: collector health (log size + growth via HEAD), live stats (on-time / late, stopped split
      into AT-A-STOP vs elsewhere via speed~0 within 40 m of a stop, occupancy>empty, routes detoured),
      a mini fleet map (routes faint + live dots, at-stop ringed, late red-outlined), on-time stacked
      bar, session sparklines, and a sortable live fleet table of every captured variable (driver
      fields excluded; numeric sort fixed).
    - DEVIATION: the predicted-vs-measured mirrored beeswarm (from the reliability log).
    - STRING-LINE: the Marey, computed IN-BROWSER from the GPS log (route + hours pickers); slope=
      speed, flat=dwell/layover, converging same-color lines=bunching, gaps=service holes. Route 90
      shows clean regular headway with terminal layovers.
    - TRACKS: accumulated raw GPS trails (all trips, faint, colored by route, broken at >600 m jumps so
      no spray), the network drawing itself from real movement; refreshes while the tab is open.
    Findings: ~17/18 stopped buses are at a designated stop (at-stop inference clean); occupancy
    all-Empty so far (likely not live - watch over peak before building crowding).
    `scripts/build-stringline.mjs [routeId] [--hours N]` is kept as an OFFLINE Marey builder (writes
    data/stringline.json) for windows too large for the browser; the standalone stringline.html was
    folded into the dashboard tab and removed.
- [x] **3. Calm motion (DONE + deployed 2026-06-20).** index.html glides each bus from its last
      drawn position to its new (snapped/pinned) target over the poll interval via requestAnimationFrame
      (`anim` map keyed per vehicle, `lerp`/`curPos`, GLIDE_MS=10000). Draws on every poll too, not
      just rAF, so a backgrounded tab (where browsers throttle rAF) still updates. Carries `bearing`
      for the directionality marker (NEXT: pick a form from the dir-* studies; leading arrow / pin).
      Straight-line interpolation between snapped points; following the road curve is a refinement.
      Note: rAF is paused in the headless preview, so the glide only shows in a real visible browser.
      LATENCY (measured 2026-06-20, from Erik watching buses downtown vs the app, ~10-20s behind):
      the feed itself is ~11s stale (median now - LastUpdated, p90 16s) and only refreshes each bus
      ~every 10-15s, so polling faster than ~10s just over-samples (duplicate positions) and, with a
      short glide, makes the dot finish and PAUSE = choppy. Our 10s poll/10s glide ~matches the feed
      cadence (smooth) but the glide is retrospective (eases TOWARD the last known point), adding to
      the lag. PARKED (Erik wants this later, esp. for rung-6 wayfinding): EXTRAPOLATION - project the
      bus forward along heading/route by speed so the dot shows where it is NOW, fighting both glide
      lag and feed latency (cost: overshoot at stops/turns, correction on next poll). Calm map is fine
      as-is; extrapolation earns its keep on the mobile "is my bus here now" face.
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

- **FULL API INVENTORY: [docs/rapid-api.md](docs/rapid-api.md)** (probed 2026-06-20).
  Read it before building anything that touches agency data. Summary below.
- Provider is Avail InfoPoint at `connect.ridetherapid.org`. **CORS is open
  (`Access-Control-Allow-Origin: *`) on EVERY endpoint, including the KML traces**,
  so the browser can call all of it directly. **No serverless proxy. No Netlify
  Functions.** Dates are ASP.NET `/Date(ms-offset)/` (ms = epoch UTC).
- Working endpoints (all GET JSON unless noted):
  - `Vehicles/GetAllVehiclesForRoutes?routeIDs=1,2,3` - live positions. Multi-route
    in one call is CONFIRMED (supersedes HANDOFF's "unverified"). Beyond position:
    `Deviation`, `OpStatus`, `OccupancyStatus`/`OnBoard`/capacity (crowding),
    `TripId`/`RunId`.
  - `Routes/GetVisibleRoutes` (25) / `Routes/GetAllRoutes` (34 incl. hidden) /
    `RouteDetails/Get/{id}`. Carry `RouteStops` (official ordered stop sequence),
    embedded `Vehicles` + `Messages`, and `RouteTraceFilename`.
  - `Stops/GetAllStops` (1493) / `Stops/Get/{id}`. `IsTimePoint` flags anchors.
  - `StopDepartures/Get/{stopId}` - schedule vs actual: `SDT/EDT/STA/ETA` plus
    `ADT/ATA` (ACTUAL) and `Dev`. Powers on-time / reliability work.
  - `PublicMessages/GetCurrentMessages` (alerts/detours; `Routes[]` + date window;
    `Effect` is always UnknownEffect so classify by text).
  - `Resources/Traces/Route{N}.kml` - the agency's OWN route geometry. Filename
    flips to `Route{N}_DET_*.kml` with the reroute baked in when detoured (15 of 25
    routes were detoured at probe time). A third base-geometry candidate.
  - NOT available (404, do not re-chase): map/GetBaseData, ScheduleAdherence,
    RoutePatterns, Trips, Landmarks, GTFS-RT protobuf, GTFS zip. See the doc.
- **Privacy:** the Vehicles feed exposes `DriverName`/`DriverFirstName`/
  `DriverLastName`/`DriverFareboxId`/`VehicleFareboxId`/`BlockFareboxId`. Never
  surface any of them. `rapid.js` and the collectors drop them; keep it that way.
- Static GTFS (routes, shapes, stops) is seasonal. **Parse once, commit as static
  GeoJSON.** Do not fetch or parse it at runtime.
- `rapid.js` is the fetch/normalize/poll layer, wired into index.html as of rung 2.
  Exposes `fetchVehicles`, `fetchRoutes`, `fetchAllVehicles`, `pollVehicles`.

## Working preferences (Erik)

- **No em-dashes, ever.** Use periods, commas, colons, parentheses.
- Plain and direct. No AI-sounding prose, no flattery, no filler.
- Prefers honest challenge over reassurance. Push back when something is wrong.
- Bricolage / maker sensibility: self-contained, honest, veridical-first builds.
- Brand: Outfit 800, IBM Plex Mono, black and white, no decorative color.
  **Route colors are the deliberate, principled exception** (real wayfinding data).
- Touchstones: Calm Technology, Super Normal, wabi-sabi, ma.
- Erik is newer to Claude Code: explain commands, work in small reversible steps.
