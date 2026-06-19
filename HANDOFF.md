# Grand Rapids Live Bus Map: Project Handoff

A brief for a fresh Claude Code session. Everything below is decided or confirmed unless marked otherwise.

---

## What we're building

A more usable real-time bus map for The Rapid (the transit system in Grand Rapids, MI). Two faces sharing one data layer:

- **Desktop:** the whole-system contemplative view. A near-white map with every route, every stop, and every bus moving live, with the ability to filter and focus. **This is what we build first.**
- **Mobile (phase two):** personal wayfinding. Where am I, what bus do I want, where am I going. Depends on a stop-level arrivals endpoint we have not yet scouted (see Data layer). Deferred until desktop is done.

Reference object: `https://nycsubway.figma.site/` (a near-white live subway map where the colored lines do all the work). The basemap there is low-contrast and near-white, close to a monochrome map base. That is the register we want.

---

## Aesthetic direction (decided)

The basemap's entire job is to disappear. Principles: Super Normal, Calm Technology, wabi-sabi, ma.

- **Near-white basemap**, Carto Positron register. Structure (roads, water) recedes to the faintest grey.
- **Route colors are a hard constraint.** Keep The Rapid's real wayfinding colors exactly. They are veridical data, not decoration. This is the deliberate exception to the otherwise black/white brand system.
- **Calm smooth motion.** Interpolate each vehicle's position between polls so buses glide rather than jump. This is most of what separates a calm map from a nervous fleet dashboard.
- **White casing on route lines.** A hairline white border around each colored line. This is the single technique that keeps bundled routes legible where many share a corridor. Critical spots in Grand Rapids: Division Avenue (Silver Line plus locals) and the downtown knot where most routes funnel into Central Station. Without casing these smear into one band.
- **Rounded line joins plus light smoothing.** Real bus GPS shapes carry angular noise. Round joins give the composed, drawn quality for little effort.
- **Label restraint.** Suppress most basemap labels. Names appear on focus, not at rest.
- **Zoom-based level of detail.** Routes and buses stay visible at every scale. Stops fade in only as you zoom toward street level, where they become relevant and have room to breathe. "Every stop is there," just disclosed when the scale can hold it. This is the answer to density.
- **Palette caveat:** a few Rapid routes are yellow or pale and can wash out against light grey. White casing rescues most of it. We may nudge the casing slightly darker on the lightest routes. Tune this against real rendered lines, not in the abstract.

---

## Data layer (the important part)

Provider is Avail InfoPoint, hosted at `connect.ridetherapid.org`.

### Live vehicles (CONFIRMED, verified 2026-06-19)

- Endpoint: `https://connect.ridetherapid.org/InfoPoint/rest/Vehicles/GetAllVehiclesForRoutes?routeIDs=2`
- GET, `application/json`, HTTPS, no auth.
- **CORS: `Access-Control-Allow-Origin: *` (verified).** Call it directly from the browser. **No serverless proxy needed.** This deliberately avoids the function-timeout and rate-limit problems from prior projects.
- Returns a flat array of vehicle objects. Useful fields per vehicle: `Latitude`, `Longitude`, `Heading` (degrees, 0 = north, clockwise), `Speed` (likely mph, confirm if it matters), `Destination`, `DirectionLong`, `LastStop`, `OpStatus` ("ONTIME"), `Deviation` (minutes off schedule or null), `OccupancyStatusReportLabel` ("Empty"), `VehicleId`, `RouteId`, `CommStatus` ("GOOD" means live, anything else means stale position), `LastUpdated`.
- **Quirk:** `LastUpdated` is ASP.NET format, e.g. `"/Date(1781877723000-0400)/"`. The leading number is plain Unix epoch milliseconds. Handled in `rapid.js`.
- **Privacy:** the raw feed exposes `DriverName` (operator last name). Do not surface it anywhere. `rapid.js` drops driver fields from the normalized shape on purpose.
- **Unverified:** comma-separated multi-route (`routeIDs=2,5,14`) is inferred from the plural param, not tested. `fetchAllVehicles()` in `rapid.js` fans out one call per route as a safe fallback.

### Route catalog

- `https://connect.ridetherapid.org/InfoPoint/rest/Routes/GetVisibleRoutes`
- Confirm the id field name from its response before relying on `fetchAllVehicles()`.

### Static GTFS (the stage)

- `http://connect.ridetherapid.org/InfoPoint/gtfs-zip.ashx`
- Contains `shapes.txt` (route polylines), `stops.txt` (stop positions), and `routes.txt` (which carries `route_color`, the real wayfinding colors).
- **Parse once into GeoJSON and commit those files as static assets in the repo.** This data is seasonal and rarely changes (the current feed is active through roughly late August 2026). Do not fetch or parse it at runtime. CORS on the zip is unverified anyway, so handle it offline.

### Not yet scouted (needed for mobile, phase two)

- Stop-level arrival predictions ("when is my bus coming"). To capture: open their myStop map, click a stop, watch the Network tab for the request (likely something like `GetStopDepartures`). Defer until desktop is finished.

---

## Architecture

- **Committed static substrate** (routes and stops GeoJSON, parsed from GTFS) is the stage.
- **Live actors** (vehicles fetched client-side from the CORS-open endpoint) are the buses.
- No Netlify Functions in the critical path. Pure static deploy.

This mirrors a veridical-substrate / live-overlay pattern used in prior projects. Static stage downloaded and committed once, live actors fetched every poll.

---

## Stack

- **MapLibre GL JS** (open, no key required for the library).
- **Basemap:** start with **Carto Positron "no labels"** (usable without an API key) to move fast and react to something real.
- **Endgame:** Protomaps (a single self-contained `.pmtiles` basemap served as a static asset, no tile server, light/grayscale theme tunable). This is the fully self-contained Netlify deploy and the bricolage-correct finish, but it is a later refinement, not a starting point.
- **Poll cadence:** 10 seconds is plenty for a neighborhood view. Be a polite guest on their server. The poller in `rapid.js` defaults to this and uses setTimeout chaining so a slow response never stacks requests.

---

## Build ladder

Each rung is a real stopping point. Stop and look before moving on.

0. **Scaffold.** Repo, file layout, Positron basemap rendering centered on Grand Rapids, first Netlify deploy. Proves the pipeline.
1. **Routes.** Parse `shapes.txt` and `routes.txt` to GeoJSON. Draw the colored lines with white casing and rounded joins.
2. **Live buses.** Wire in `rapid.js`. Dots on the map, updating.
3. **Calm motion.** Interpolate position between polls so buses glide.
4. **Stops.** Parse `stops.txt` to GeoJSON. Zoom-based fade-in.
5. **Filter and focus.** Selecting a route holds its color and recedes the rest to grey. Tapping a bus surfaces a quiet detail panel (destination, next stop, on-time or deviation, occupancy).
6. **Phase two.** Scout the arrivals endpoint, then build the mobile personal wayfinding face (geolocation, nearest stops, my route, live arrivals).

---

## First session scope

**Goal: Phase 0 only.** Get the near-white Positron basemap rendering on Grand Rapids and deployed to Netlify, then stop and look. If it is going smoothly, stretch into Phase 1 (draw two or three real route lines, properly cased) so the first thing reacted to is the real register on real streets.

**Deploy model:** GitHub repo, with Netlify connected to the repo so every push auto-deploys. Push to deploy, nothing to babysit. Suggested repo name: `gr-bus-map`.

**Note to the assistant:** Erik is new to Claude Code and wants hand-holding. Walk through everything from the start, one small reversible step at a time: repo init, file layout, basemap on screen, first deploy. Stop and verify after the map renders before adding anything. Workflow: personal Max account, `gh` CLI available, prior Netlify experience.

---

## Working preferences (Erik)

- **No em-dashes. Ever.** Use periods, commas, colons, parentheses.
- No AI-sounding prose, no flattery, no filler. Plain and direct.
- Prefers honest challenge over reassurance. Push back when something is wrong.
- Bricolage and maker sensibility. Values self-contained, honest, veridical-first builds.
- Brand system: Outfit 800, IBM Plex Mono, black and white, no decorative color. Route colors are the deliberate, principled exception here.
- Touchstones: Calm Technology, Super Normal, wabi-sabi, ma.

---

## Files to bring into the repo

- `rapid.js` (already written): fetch-and-normalize layer for the live vehicle feed. Exposes `fetchVehicles(routeIds)`, `fetchRoutes()`, `fetchAllVehicles()`, and `pollVehicles(routeIds, onUpdate, opts)`. Commit as-is.
