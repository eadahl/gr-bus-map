# The Rapid InfoPoint API: data inventory

A thorough map of what the agency's live system (Avail InfoPoint) exposes, so we
can decide what to build. Probed 2026-06-20 against the production host.

## Ground rules

- **Base (JSON REST):** `https://connect.ridetherapid.org/InfoPoint/rest`
- **Resources (KML, icons):** `https://connect.ridetherapid.org/InfoPoint/Resources`
- **CORS is open (`Access-Control-Allow-Origin: *`) on every endpoint below**,
  including the KML traces. The browser can call all of it directly. No proxy, no
  Netlify Functions (consistent with the project rule).
- **Dates** come as ASP.NET strings: `/Date(1781968380000-0400)/`. The number is
  epoch ms (absolute UTC); the offset is source tz and can be ignored. Many
  time fields also have a `*LocalTime` string companion.
- **Privacy:** the Vehicles feed exposes driver and farebox fields. Never surface
  `DriverName`, `DriverFirstName`, `DriverLastName`, `DriverFareboxId`,
  `VehicleFareboxId`, `BlockFareboxId`. (Our collectors use a strict allowlist.)

## Endpoint catalog (everything that works)

### Vehicles (live positions)
- `GET /Vehicles/GetAllVehiclesForRoutes?routeIDs=1,2,3` — multi-route in one call
  (confirmed). Also `/Vehicles/GetAllVehiclesForRoute?routeID=7` for one.
- Per vehicle: `VehicleId, RouteId, TripId, RunId, Name` (coach #), `Latitude,
  Longitude, Heading, Speed, Destination, DirectionLong, LastStop, StopId,
  OpStatus, Deviation, CommStatus, GPSStatus, LastUpdated`.
- **Notable beyond position (live-checked 2026-06-20):**
  - `OpStatus` = ONTIME / LATE / TRIP START. This is the ONLY on-time signal in the
    vehicle feed: **`Deviation` is null here** (numeric minutes-late live in
    StopDepartures `Dev`). `DisplayStatus`, `CurrentStatus` are also null.
  - `OccupancyStatus` = a 0..6 bucket (Empty / Many seats / Few seats / Standing /
    Crushed / Full / Not accepting). **`OnBoard` (actual count) is null** - no
    headcount. At the probe, every bus read 0/Empty: unknown yet whether occupancy
    is genuinely live or always 0 (the collector now logs it to find out).
  - `SeatingCapacity` / `TotalCapacity` populated per vehicle (e.g. 38/77, 57/114)
    = the bus SIZE CLASS, not live load.
  - `StopId` (stop at/approaching, 0 = between), `TripId` + `RunId` (stitch a run /
    block), `GPSStatus` + `CommStatus` (data trust).

### Routes (catalog + topology + embedded live)
- `GET /Routes/GetVisibleRoutes` — the 25 public routes.
- `GET /Routes/GetAllRoutes` — 34 incl. hidden (university "Union"/"Central"
  shuttles 71-76, Ferris State 100, system 46/9999).
- `GET /RouteDetails/Get/{routeId}` — full detail for one route.
- Per route: `RouteId, ShortName, LongName, Color, TextColor, SortOrder, IsVisible,
  Group, Directions[], RouteStops[], Stops[], Vehicles[], Messages[],
  RouteTraceFilename, RouteTraceHash64, DetourActiveMessageCount`.
- **`RouteStops[]` = official ordered topology:** `{Direction, RouteId, SortOrder,
  StopId}`. Join to Stops for lat/lon = the agency's own stop sequence per
  direction (a clean alternative/complement to deriving order from GPS).
- `Directions[]` = `{Dir, DirectionDesc, DirectionIconFileName}`.
- `Vehicles[]` and `Messages[]` are embedded, so one route call carries its live
  buses and its active alerts.

### Stops
- `GET /Stops/GetAllStops` — all 1,493 stops: `{StopId, Name, Description,
  Latitude, Longitude, IsTimePoint, StopRecordId}`.
- `GET /Stops/Get/{stopId}` — one stop, same fields.
- **`IsTimePoint`** flags the schedule-anchor stops (where adherence is measured).

### StopDepartures (the schedule-vs-actual gold mine)
- `GET /StopDepartures/Get/{stopId}` — for one stop, grouped by route+direction,
  the upcoming and just-passed departures.
- Per departure: `SDT/EDT` (scheduled/estimated departure), `STA/ETA`
  (scheduled/estimated arrival), **`ADT/ATA` (ACTUAL departure/arrival, once the
  bus has passed)**, `Dev` (deviation), `Trip`, `StopStatus`, `IsCompleted`,
  `IsLastStopOnTrip`, `Bay`, plus `*LocalTime` companions.
- This is what powers on-time / reliability scoring: scheduled vs actual, per
  trip, per stop, per route.

### PublicMessages (alerts / detours)
- `GET /PublicMessages/GetCurrentMessages` — 55 active messages (== GetAllMessages
  here). This is the sidebar's "Public Service Messages" feed.
- Per message: `MessageId, Header, Message` (HTML), **`Routes[]`** (route IDs it
  applies to), `FromDate/ToDate/FromTime/ToTime/DaysOfWeek` (active window),
  `Cause, Effect, Priority, URL, Detour_Id`.
- **Caveat:** `Effect` is `UnknownEffect` on every message, so detours aren't
  structurally tagged. Classify from `Header`/`Message` text + `Routes` + window.

### Resources: official route geometry (KML)
- `GET /InfoPoint/Resources/Traces/{RouteTraceFilename}` — the agency's own drawn
  route line, e.g. `Route7.kml`. Filename comes from the route's
  `RouteTraceFilename`. KML of per-segment `<LineString>`s (route 7: 42 segments,
  ~282 points). Sparser/cleaner than GTFS shapes; this is what their map draws.
- **Detour signal in the filename:** a route currently on detour gets a
  regenerated trace named `Route{N}_DET_{YYMMDD}_{HHMMSS}.kml` with the reroute
  baked into the geometry. Plain `Route{N}.kml` = no active detour. (Confirmed:
  routes flagged `_DET_` line up with routes carrying detour PublicMessages.)
- **As of the 2026-06-20 probe, 15 of the 25 visible routes were detoured.** Over
  half. This is the single most important caveat for building a base map from
  current data.

## What is NOT available (probed, all 404 — don't re-chase)

`Stops/GetStopDescription`, `Stops/GetStopsForRoute`, `map/GetBaseData`,
`Landmarks`, `ServiceBulletins`, `Configuration`, `KeyValues`,
`ScheduleAdherence`, `RoutePatterns`, `Trips/GetTripStops`, `RouteSchedules`,
`Schedule/*`, GTFS-Realtime protobuf feeds (`/GTFS-Realtime/*`), and a GTFS zip
download. No swagger/help index. Schedule data must be assembled from
StopDepartures (live) or the committed static GTFS in `gtfs-src/`.

## Data inventory: the useful signals, in one place

| Signal | Source | Use |
| --- | --- | --- |
| Live position, heading, speed | Vehicles | the map (have it) |
| `TripId` / `RunId` | Vehicles, StopDepartures | stitch runs into paths (reconstructor) |
| `OpStatus` (ONTIME/LATE) | Vehicles | coarse per-bus on-time (Deviation is null here) |
| `SDT/EDT/STA/ETA` + `ADT/ATA` | StopDepartures | precise schedule-vs-actual per stop |
| `OccupancyStatus` (0..6 bucket) + capacity | Vehicles | crowding bucket + size class (OnBoard count is null) |
| Official ordered stops | RouteStops + Stops | topology, stop sequence |
| Official route geometry | KML traces | a candidate base geometry |
| Detour active? + rerouted geometry | KML `_DET_` filename, PublicMessages | exclude/label detours |
| Timepoints | Stops `IsTimePoint` | where adherence is anchored |

## Implications for current work

- **Detours are pervasive (15/25 right now)** and the agency encodes them two ways:
  the `_DET_` trace filename (with rerouted geometry) and PublicMessages. Both
  should be **logged over time** so historical GPS can be labeled detour vs real
  branch. The trace filename is the cleaner detection signal; the messages add the
  human reason and exact window.
- The **KML traces are a third base-geometry candidate** alongside GTFS shapes and
  reconstructed GPS. The head-to-head should probably be three-way.
- On-time/reliability is fully supported via StopDepartures (`ADT`/`Dev`), but at
  1,493 stops it needs a sampling strategy (timepoints first, or a rotation).
