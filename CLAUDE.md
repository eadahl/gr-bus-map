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
        Live HTML now: index.html (deployed map), observe.html (local dashboard, 4 tabs), editor.html +
        polish-preview.html (geometry pipeline tools), reconstruct-preview.html (GPS reconstruction
        preview). stringline.html was folded into the dashboard string-line tab and removed.
        Scripts: build-routes, match-routes, spread-routes, polish-routes, lib-corridors (geometry
        pipeline); collect-vehicles, collect-detours, collect-reliability (the 3 live collectors);
        find-coverage-gaps, reconstruct-routes, build-stringline (GPS analysis); build-stops (rung 4).
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
  - COLLECTION (intermittent Fri 6/19 -> Tue 6/30, whenever the Mac was awake; re-run a few times).
    Logs are gitignored, local to THIS Mac: vehicle-log ~446 MB / ~1.7M rows, reliability-log ~36 MB,
    detour-log ~1.9 MB. Plenty for the base-map work (a full Saturday + most of Sunday + weekday
    daytimes incl. PM peak).
    - DUPLICATE-ROW CAVEAT: across restarts there were stretches where TWO collector instances
      overlapped and double-logged, so a meaningful fraction of the rows are EXACT duplicates. The raw
      row/point counts and file size are therefore inflated. Harmless to reconstruction (reconstruct-
      routes dedups by trip+time+<8 m proximity), but dedup the log (e.g. `sort -u`) before trusting
      raw counts or feeding the dashboard's loadLog.
    - RESTART GOTCHA: starting a collector without killing the previous one STACKS instances ->
      double logging. Always `pkill -f collect-X.mjs` first. And `pgrep -f collect-X.mjs` counts the
      caffeinate wrapper AND the node proc (2 per collector even when only one is really running);
      count real instances with `ps -Ao args | grep scripts/collect-X | grep -v caffeinate`.
    - These + the `python3 -m http.server 8000` dashboard server are all local processes that die on
      lid-close and don't auto-restart. Stop everything with the three `pkill -f collect-X.mjs`.
  - RECONSTRUCT RE-RUN on the full data (2026-06-22): 1772 usable trips -> 77 patterns across ALL 25
    routes (was 28/15 on the Friday sample). Every route reconstructs, branches included (1->UM Health
    West, 8/3/24->Target-Rivertown, 10->Pine Rest, 45->10 Laker variants). Only 33/34/27 sit at the
    3-trip floor. Confirmed: the data is rich enough for the base-map work. Output
    data/routes-reconstructed-debug.geojson (gitignored).
  - [~] STEP 3: THREE-WAY BASE HEAD-TO-HEAD, first pass (started 2026-07-10; not a verdict yet).
    `scripts/compare-bases.mjs` builds one combined GeoJSON (`data/base-compare.geojson`, gitignored;
    features tagged `source: gtfs|kml|gps`) plus per-route length/piece-count stats
    (`data/base-compare-stats.json`). KML source picks the CURRENT trace file per route (newest
    `_DET_` timestamp, else the plain file) from `data/detour-traces/` - re-fetch any missing current
    traces first (the archive only has what collect-detours.mjs happened to see; a route's trace can
    rotate after collection stops). View: `compare-preview.html` (route selector, per-source toggles,
    per-route stats incl. a length-ratio warning). Run order: re-run `reconstruct-routes.mjs` on the
    full log first, then `compare-bases.mjs`.
    - HEADLINE FINDING: GTFS and KML agree closely on total length (KML is authoritative but comes as
      MANY tiny disconnected segments per route, e.g. 40-70 pieces - fragmented, would need stitching
      before it's usable as a clean base). Both structurally miss the real branches (confirms the
      original motivation). GPS reconstruction correctly surfaces the branches (Rivertown, Pine Rest,
      UM Health West, etc.) but, before cleanup, 14 of 25 routes came back 1.7x-7.2x LONGER than GTFS -
      a real bug, not just noise.
    - ROOT CAUSE (confirmed by code reading + visual inspection): `reconstruct-routes.mjs` clusters
      trips into a pattern by grid-signature (Jaccard) overlap ALONE, with `seedSig` frozen at the
      first (longest) trip and no length check. A trip sharing most of a pattern's cells (e.g. the same
      corridor plus a deadhead tail, or a longer variant) joins in even if much longer. Step 4 then
      resamples every member trip to a FIXED N points and averages POINT-BY-INDEX - blending trips of
      different physical extents at the same index produces one incoherent, wandering, too-long line.
    - FIXES APPLIED to reconstruct-routes.mjs (both kept, both net-positive, neither a full fix):
      (a) HUB EXCLUSION: drop GPS points inside the same hub zone `polish-routes.mjs` already clips at
      before building trip coords (downtown convergence is exactly where path-per-trip variability -
      bay pull-ins, layovers - is highest). Modest, safe improvement (e.g. route 90: 58->50 km played
      against ~31 km GTFS), route 51/DASH unchanged at a clean 1.0x match.
      (b) LENGTH-TRIM AT STEP 4 (not at clustering - see below): after clustering (unchanged), drop
      member trips whose length falls outside `LEN_RATIO_MAX` (1.6x) of the pattern's MEDIAN length,
      right before the resample/median, so outliers never reach the averaging math. New `trimmed`
      property records how many were dropped per pattern (39 of 91 patterns had trims on the full log).
    - TRIED AND REVERTED: a join-time length gate (only join a pattern if within the ratio of its
      running average) made things WORSE - it fragmented previously-clean routes (route 90: 3->13
      patterns, route 51: 1->6) because it interacts badly with the frozen `seedSig` + length-descending
      processing order. Lesson: gate membership at the averaging step, not at the spatial-clustering
      step (Jaccard is still the right clustering signal on its own).
    - STILL UNRESOLVED (14/25 routes still flagged after both fixes; NOT further tuned this pass):
      some routes (route 24 is the clearest case, unchanged by both fixes: 168.8 -> 173.8 km vs 52.2 km
      GTFS) have GENUINE LOCAL divergence, not just length variance - real alternate loop variants
      (Wyoming/Grandville area) that share enough of a long shared trunk to pass SIM_THRESHOLD (0.5)
      Jaccard in aggregate while diverging in a side section, so the median visibly zigzags between the
      two paths at that shared position. A whole-trip length filter can't catch this (both variants are
      similar total length). Needs either a stricter/local-divergence-aware clustering method or
      map-matching to pull each divergent branch onto its own road (the planned 2b) - deferred, not
      solved here.
    - [DONE] STEP 2b: map-matched the reconstructed patterns, RESULT: matching alone does NOT fix the
      flagged routes - the hoped-for "may help the divergence issue by snapping to distinct real roads"
      was tested and did not hold. `match-routes.mjs` is now reusable on GPS input: `INPUT`/`OUT_MATCHED`/
      `OUT_MERGED` env vars override the hardcoded paths, and `GPS_MODE=1` carries dir/trips/dests
      through and SKIPS the direction-merge step (GTFS-only - assumes exactly one shape per direction,
      which a reconstructed branch is not; merging would blend genuinely different branches). Run:
        INPUT=data/routes-reconstructed-debug.geojson \
        OUT_MATCHED=data/routes-reconstructed-matched-debug.geojson \
        OUT_MERGED=data/routes-reconstructed-matched-debug.geojson \
        GPS_MODE=1 node scripts/match-routes.mjs
      70.3% of GPS points snapped to a road (vs 94.9% for clean GTFS input - expected, reconstructed
      patterns include the noisier/divergent stretches). `compare-bases.mjs` picks up the matched file
      automatically if present (4th `gps-matched` source, dark green in compare-preview.html) and warns
      per-route whether matching resolved or didn't resolve the length flag.
      RESULT CONFIRMED BOTH QUANTITATIVELY AND VISUALLY: route 24 barely moved (173.8 -> 158.8 km, still
      3.0x GTFS's 52.2 km); route 45 got WORSE (306.3 -> 355.2 km). Visual check on route 90's hub-area
      tangle: the matched (green) line now precisely follows real streets - the wobble is genuinely gone,
      that part of matching's job is done - but it STILL zigzags across multiple parallel streets in the
      same chaotic pattern as the raw version. CONCLUSION: matching cleans wobble on points already
      correctly assigned; it runs AFTER clustering, so it cannot undo a bad cluster. The corruption is
      strictly upstream, at reconstruct-routes.mjs's Jaccard clustering step (documented above) - fixing
      it needs a clustering-level fix (stricter SIM_THRESHOLD, or a local-divergence-aware method e.g.
      DTW), not a matching-level one. This closes off matching as a candidate fix; do not re-attempt it
      for this purpose.
    - *** ROOT CAUSE FOUND 2026-07-10 (OVERTURNS the clustering + averaging hypotheses above - those
      were treating SYMPTOMS; do NOT keep tuning SIM_THRESHOLD / length-trim, that was a wrong track):
      `tripId` IS REUSED ACROSS SERVICE DAYS. reconstruct-routes groups raw points by (routeId, tripId),
      but the Avail feed's TripId is a schedule-slot/block id that repeats every day, so ONE "trip"
      concatenates every day's run of that slot. Proven by diagnostic (route 90): "trip" lengths run
      median 44 km / max 122 km with time spans of ~11,565 min (~8 DAYS); a real one-way run is ~15.5 km.
      Route 24: median 64 km, max 175 km, same ~8-day spans. So the member "trips" fed to clustering are
      each N single-runs stitched end to end - THAT is why patterns come out 1.7-7x too long and wander
      (N slightly-different daily runs of the same slot, overlaid then medianed). Confirmed it is NOT the
      later steps: DEBUG_LEN (env flag, now in reconstruct-routes.mjs) shows the centerline is ~1.0x its
      MEMBER-trip length for nearly every pattern (max 1.45x on one tiny pattern) - the averaging is
      faithful; the members are just huge. And map-matching couldn't help because its inputs were already
      N-runs-in-one. Diagnostic script: /tmp/trip-diag.mjs (throwaway; lists per-trip km/span/dir/dest for
      a given route - `node /tmp/trip-diag.mjs 90`).
    - [DONE 2026-07-10] THE FIX: SEGMENT each (routeId, tripId) into individual runs before step 2's
      trip-building. reconstruct-routes.mjs now has a step 1b that splits a bucket's time-ordered points
      wherever consecutive fixes are >RUN_GAP_MIN (60 min) apart. Threshold chosen from the data, not
      guessed: the inter-fix gap histogram is sharply bimodal - 98% of gaps <1 min (in-run polling), a
      thin tail to ~45 min (layovers/stalls), then a NEAR-EMPTY VALLEY (only 8 gaps total between 45 min
      and 8 h, ZERO between 2 h and 8 h), then the day boundaries pile up at 8-24 h+. 60 min sits in the
      valley, so one split run = one real trip. (Diagnostic that found the valley: throwaway, in scratchpad.)
    - RESULT (verified, the fix WORKED): buckets 2524 -> 12234 runs (gap>60) -> 8732 usable -> 364 patterns
      across all 25 routes (was 1772 trips -> 77 patterns pre-fix). The DOMINANT (highest-trip) pattern per
      route+direction is now a realistic one-way length: on a per-direction-vs-GTFS-one-way metric, 0/25
      routes exceed 1.6x (was 14/25 flagged). Route 90 IN/OU 14.9/14.3 km (was 44-58 km buckets), route 24
      27.8/29.2 km EA/WE with the two branches cleanly SPLIT by destination (was 168-174 km blended), route
      45 20.8/21.2 km (was 306-355 km). Map-match snap rate on the corrected runs jumped to 89.8% (was 70.3%
      pre-fix) - cleaner single-run input follows real roads far better. So: the tripId-reuse root cause is
      RESOLVED; the length-trim / SIM_THRESHOLD tinkering above is now moot (kept, harmless).
    - CAVEAT - do NOT read compare-bases' gps(km) column as a regression: it SUMS every pattern's length,
      and there are now 364 patterns (was 77), so the sum inflates (route 45 shows 39 patterns / 713 km).
      That is pattern COUNT, not bad geometry. Of the 364, ~201 are SHORT PARTIAL runs (<0.7x their
      direction's dominant length: a bus that went out of service mid-route, or a collection gap that split
      a real run). The per-pattern lengths are correct; there are just many, most of them fragments.
    - [DONE 2026-07-10] PATTERN CONSOLIDATION: `scripts/consolidate-patterns.mjs` distills the 364 patterns
      to 50 (one clean line per route+direction, plus genuine branches). Method is DESTINATION-driven, not a
      plain length filter (a length filter kept duplicate full patterns - route 90 IN had two near-identical
      full runs). Per (routeId, dir), sort candidates by trips DESC, keep the most-observed as the DOMINANT,
      then keep an extra only if it (a) reaches a destination no kept line covers yet, (b) is >= 0.5x the
      dominant length (else it's a truncated fragment carrying the scheduled dest), (c) is <= 1.4x dominant
      (else a same-slot double / out-and-back), and (d) actually adds >= 12% new road geometry (guards a
      same-road run with a noisy dest label). Same-dest extras are dupes/partials -> dropped. Result: 364 ->
      50 kept, 2 genuine branches survive (route 1 SO -> Meijer-54th at 16% new geom, route 5 SO -> Woodland-
      only at 21% new). Tunables at top: MIN_LEN_FRAC 0.5, LEN_CAP 1.4, NEW_COV_MIN 0.12. VERBOSE=1 lists
      every drop with its reason. Output data/routes-reconstructed-consolidated-debug.geojson (gitignored).
      ONE BORDERLINE CALL left as-is: route 9 NB -> Target-GreenRidge (a real distinct dest) diverges only
      ~11% from Walmart-Alpine (shares the whole Alpine corridor, splits ~1 km at the end), so it's DROPPED
      at NEW_COV_MIN 0.12. To include it (and any other ~10-11% micro-branch), lower NEW_COV_MIN to 0.10.
    - CONSOLIDATED SET MATCHED + COMPARED: ran match-routes.mjs GPS_MODE on the consolidated set (92.8% snap,
      even cleaner than the full 89.8%) -> data/routes-reconstructed-consolidated-matched-debug.geojson.
      compare-bases.mjs now PREFERS the consolidated files if present (gps + gps-matched), so the compare is
      finally apples-to-apples: GPS totals sit at ~0.9-1.4x GTFS per route (route 45 42 km vs GTFS 44.2 km,
      was 713 km pre-consolidation; route 90 29.2 km vs 31.2 km; route 24 57.6 km vs 52.2 km) and the extra
      length over GTFS is exactly the branches GTFS misses (route 1 Meijer-54th, route 5 Woodland, route 24
      Woodland+Rivertown, route 8 Rivertown, route 10 Pine Rest). Visual check (compare-preview.html, route
      24): the matched GPS is ONE clean road-following line where the pre-fix version was a 174 km zigzag.
    - PIPELINE for the GPS base (re-run in order after any collection extension):
        node scripts/reconstruct-routes.mjs        # log -> 364 patterns (segmented runs)
        node scripts/consolidate-patterns.mjs      # 364 -> 50 clean lines (data/...-consolidated-debug.geojson)
        INPUT=data/routes-reconstructed-consolidated-debug.geojson \
        OUT_MATCHED=data/routes-reconstructed-consolidated-matched-debug.geojson \
        OUT_MERGED=data/routes-reconstructed-consolidated-matched-debug.geojson \
        GPS_MODE=1 node scripts/match-routes.mjs   # snap the 50 onto OSM roads (92.8%)
        node scripts/compare-bases.mjs             # 4-way compare (auto-prefers consolidated)
      View: reconstruct-preview.html (toggle full 364 vs consolidated 50) and compare-preview.html (per-route
      GTFS vs KML vs GPS vs GPS-matched).
    - VERDICT (updated 2026-07-10): GPS reconstruction is now the STRONGEST base candidate. It gives realistic,
      clean, road-following geometry (via the match step) AND is the only source that carries the real branches
      (GTFS/KML both miss them; KML is also fragmented into 40-70 tiny segments). The GPS chain is now
      trustworthy end to end (segmentation -> consolidation -> match all verified). Remaining before it could
      REPLACE the deployed hand-geometry: the consolidated lines are per-DIRECTION (two lines per corridor,
      not direction-merged like the deployed map), the hub is not clipped, and it hasn't been through the
      polish pass - i.e. it's a clean BASE, not a finished map. Next natural step is Erik's call: either feed
      the consolidated+matched GPS into the editor/polish pipeline as the new starting geometry (replacing the
      GTFS-derived starting point Erik hand-edited from), or keep the current deployed map and use the GPS base
      only to fill the specific coverage gaps (the anomaly-ring branches). (Optional, still worth doing) commit
      a derived snapshot (consolidated + matched geojson) so the distilled result is not hostage to this one
      machine's gitignored logs.
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
    INTERROGATION (2026-06-20): one shared route-selection model across the whole dashboard - hover
    any dot/row/line to light up that route everywhere and fade the rest; CLICK to PIN it (sticky,
    click empty space to release). Wired on the beeswarm (+ a tooltip: route name, the dot's dev/kind/
    sched/stop, and a route rollup), the fleet map (the active route's LINE lights up too, not just its
    buses), the fleet table, the tracks, and the RELIABILITY RANKING panel. The string-line is
    single-route so it gets per-TRIP interrogation instead (hover a
    trip to isolate it + a tooltip of direction/start/duration). The stressed-corridor convergence
    stays a doc finding, not a live panel (synthesized, would over-claim).
    LATER ADDITIONS (2026-06-20): the RELIABILITY RANKING is now computed from the ACCUMULATED log
    (day-scale late share, drawn routes only, min 20 readings) not the session - the session version
    was noise right after a reload. Added a LATE % BY HOUR panel (PM-peak: ~3% AM climbing to ~33%
    late afternoon, from the log). And the reliability collector now does a TWO-SHOT re-poll (+20s and
    +100s after an imminent departure, not one shot at +90s) to de-bias the measured beeswarm: the
    +20s catch grabs on-time buses while they're still briefly listed (they otherwise vanish before we
    look), the +100s catch grabs the lingering late ones. Improves measured coverage going forward;
    true elimination of the bias would need disappearance-tracking (a bigger change, deferred).
    `scripts/build-stringline.mjs [routeId] [--hours N]` is kept as an OFFLINE Marey builder (writes
    data/stringline.json) for windows too large for the browser; the standalone stringline.html was
    folded into the dashboard tab and removed.
- [x] **3. Calm motion (DONE + deployed 2026-06-20).** index.html glides each bus from its last
      drawn position to its new (snapped/pinned) target over the poll interval via requestAnimationFrame
      (`anim` map keyed per vehicle, `lerp`/`curPos`, GLIDE_MS=10000). Draws on every poll too, not
      just rAF, so a backgrounded tab (where browsers throttle rAF) still updates. Carries `bearing`
      for the directionality marker (NEXT: pick a form from the dir-* studies; leading arrow / pin).
      THREE MARKER STATES on the deployed map: moving = solid route-colored dot (white casing);
      off-route/anomaly = hollow ring (near-white fill, colored stroke); AT A STOP = a soft route-
      colored halo UNDER the dot that gently pulses (sine breath in the frame loop), shown when a bus
      is speed~0 within 40 m of a GetAllStops location (stops fetched once). Reads like doors opening.
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
- [~] **4. Stops (FIRST CUT done + deployed 2026-06-20; rolling-proximity pass still to do).**
      `scripts/build-stops.mjs` fetches GetAllStops once -> `data/stops.geojson` (COMMITTED, 1493
      stops, 270 timepoints, carries `timepoint`). index.html draws a calm zoom-gated `stops` circle
      layer (white fill, hairline stroke, below buses/labels): nothing at the whole-system view,
      timepoints fade in ~z13, all stops ~z15+ (tiered via one zoom interpolate with `case` outputs on
      `timepoint`). Also now the single source for the at-stop test (replaced the runtime GetAllStops
      fetch). Styling/zoom thresholds are TUNABLE (Erik: "might need tuning"). NEXT (agreed phase two):
      a rolling proximity zone around each live bus showing the next/previous few stops in full while
      the rest of the line's stops stay diminished (after the zoom rules).
- [ ] **5. Filter and focus.** Select a route, recede the rest. Quiet detail panel.
- [ ] **6. Phase two (mobile).** Scout arrivals endpoint, build wayfinding face.

## What the data shows so far (numbers from 2026-06-20, ~17 h of one weekday)

From ~84k vehicle positions, the reliability + detour logs, and the dashboard. The specific
numbers below are from that ~17 h weekday slice; the FULL collected dataset is now larger (a full
Saturday + most of Sunday + a weekday daytime, collection stopped 2026-06-22), so a refreshed
analysis over the whole log would sharpen these, but the directional findings hold. Grounded but
provisional (still effectively one weekday for the weekday-specific claims).

KNOWN ISSUE (dashboard at scale): the vehicle log is now ~446 MB. observe.html's String-line and
Tracks tabs fetch the WHOLE log into the browser (loadLog), so they are slow / may freeze at this
size. Live + Deviation tabs are unaffected. TODO: window loadLog to a recent slice (e.g. last few
hours) before those tabs are usable again on the full log.

- **Punctuality is bimodal by route TYPE.** Late share of service time (from `OpStatus` across all
  position reports): chronically late = route 8 Prairie (30%), 4 Eastern (27%), 5 Wealthy (24%),
  15 East Leonard (23%), 10 Clyde Park (21%), 24 Burton (20%), 6 Eastown (18%). Reliably on time =
  Silver Line 90 (6%), DASH 51 (5%), Fulton 14 (2%), Millennium 1000 (0%). Long crosstown/south
  coverage routes accumulate delay; short dedicated routes (BRT, shuttle, downtown loop) stay tight.
- **The system degrades through the day.** Late% by hour: ~3% at 6am -> 8% at 8am -> 17% noon ->
  27% at 3pm -> ~33% by 4pm. Mornings run tight; the PM peak is where reliability falls apart.
- **One stressed-corridor cluster.** The chronically-late routes, the detoured routes (8,5,10,24,6,
  15,3,1,11 of the drawn set), and the coverage-gap clusters (southern Pine Rest / Target-Rivertown /
  UM Health branches) are LARGELY THE SAME routes. The reliability layer and the GPS base-map rebuild
  are really one effort aimed at the same handful of long southern/crosstown lines.
- **Occupancy is dead.** Across ~53k readings with the field, every value is 0/Empty. No live
  crowding signal exists; drop crowding from the design rather than wait.
- **Lateness is one-sided.** Buses are rarely early (a tiny `EARLY` slice in OpStatus, ~33 of 6.6k
  reliability rows negative); when late, up to ~22 min. The schedule is systematically optimistic
  (predicted-vs-measured beeswarm gap).
- **Detours are semi-permanent.** The detoured set barely changed across 17 h (4 distinct snapshots),
  so these are long-standing reroutes, not transient. A months-long detour IS the route's real
  current path, so reconstructing from GPS will correctly capture the detoured geometry.
- **Stopped ~35% of the time** (speed=0 across position reports), and ~17/18 stopped buses sit at a
  designated stop (the at-stop inference is clean).

## Stack and conventions

- **MapLibre GL JS**, pinned to 4.7.1 (CDN, no API key).
- **Basemap:** Carto Positron labeled (`positron-gl-style`) for now. Endgame is a
  self-contained Protomaps `.pmtiles` asset. Label curation (major names at rest,
  rest on focus) is a later refinement, not yet done.
- **No build step.** `index.html` is served as-is. Netlify build command and
  publish dir are both empty.
- **Local dev:** `python3 -m http.server 8000`, then open http://localhost:8000. The dashboard
  (observe.html) needs this server running to read the local logs; it serves index.html too. The
  server is a local process that DIES on lid-close/sleep and does not auto-restart - if
  localhost:8000 shows ERR_CONNECTION_REFUSED, the server is just down, restart it with that command
  (the data is fine on disk). The deployed Netlify map is unaffected (it only needs the public API).
- **Deploy:** `git add . && git commit -m "..." && git push`. That is the whole loop.
- **Collectors / data collection:** the 3 `scripts/collect-*.mjs` are local background processes
  (start with `caffeinate -i nohup node scripts/collect-X.mjs > /tmp/... &`). They also die on
  lid-close. Collection is COMPLETE as of 2026-06-22 and intentionally OFF; only restart to extend
  the dataset. Check: `pgrep -fl "collect-vehicles\|collect-detours\|collect-reliability"`.

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
