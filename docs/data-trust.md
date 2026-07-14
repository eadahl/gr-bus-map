# Data trust assessment for public rider-facing surfaces

What the agency's published data can and cannot support when we start making claims
to riders, what the gaps are, and how each gap can be closed (or must be designed
around). Grounded in measurements, not vibes: every number here was computed from
our own collected data or a live API probe. Dates: collection window 2026-06-19 to
2026-06-30 (~1.86M vehicle positions, 220k reliability rows, 78 detour snapshots,
130 archived detour traces); live probes and validation runs 2026-07-14.

Companion docs: [rapid-api.md](rapid-api.md) (the API surface itself).
Companion tools: `scripts/compare-live-vs-canonical.mjs` + `live-vs-canonical.html`
(the divergence map this assessment grew out of).

## The verdict in one paragraph

Geometry and schedule are trustworthy. Anything claiming a real-time truth about a
specific bus or stop (actual departure times, on-time status, crowding, "your stop
is served") is NOT backed by the published data. But the gap is largely closable:
the position feed is reliable and continuous, and from it we can derive the ground
truth the agency never publishes (validated below: 50,034 derived actual stop
passages from 10 days of logs, vs 0 actuals from the API). The public surface
should make claims of OBSERVATION and HISTORY ("here's the bus, here's what's
normal for this route, this looks unusual"), not claims of authority ("your bus
departed on time").

## The three tiers of claims (organizing principle, and the build order)

The API is STATELESS PRESENT TENSE: it says where buses are and what's planned, and
it forgets everything the moment it happens. Our collector is simply memory, and
every genuinely new claim is a function of memory. That yields three tiers, which
double as the build order for the public surface:

**Tier 1 - API at face value** (shippable now, honestly framed): bus position with
a recency stamp ("as of 15 s ago"), heading/speed, scheduled times, close-in ETAs
(final pre-departure predictions are 87% within 3 min), "route X is on detour"
(from the `_DET_` trace filename), route + detour geometry. NOT claimable at any
confidence: actual departures, on-time status, crowding, "your stop is served"
during a detour, "detoured since X". Note: the trust levels themselves (the 87%,
the 4 m fidelity) are only known BECAUSE we collected and measured; without ground
truth you can make tier-1 claims but cannot know which are safe.

**Tier 2 - API cross-checked against itself, live** (client-side work, no
infrastructure, no history): phantom-departure screening (StopDepartures names a
trip; the vehicle feed says whether any tracked bus is on it -> "scheduled, but no
bus seen for this trip yet"), geometric detour-stop inference (stop on scheduled
path but far off the active detour path -> "may not be served" + nearest on-detour
stop), off-route flagging (the anomaly rings). These convert WRONG claims into
HEDGED, CORRECT ones. Ceiling: can't tell a GPS gap from a bus not running, can't
say how long a condition has held, goes stale when detour geometry rotates.

**Tier 3 - continuous collection** (switches on as the always-on collector
accumulates history): actuals, on-time performance as fact, normal-vs-abnormal,
calibrated ETA ranges, served/not-served with evidence, ghost trips with
confidence, detour timelines ("since March 31"), planning-grade advice. Detailed
in the gap-closers and rider-examples sections below.

One-line version: API alone = the present and the intended. Live cross-checks =
stop actively promising what geometry contradicts. Memory = what actually happens,
and advice a rider can plan around.

## Trust map by data stream

| Signal | Trust | Evidence | Safe claim | Do not claim |
|---|---|---|---|---|
| Route geometry (no detour) | High | raw GPS median 4 m from GTFS line, p90 9 m, 0.3% >100 m (531k fixes, 9 never-detoured routes) | "the 4 runs along here" | - |
| Detour geometry (`_DET_` KML) | High | live GPS follows it; the big divergences (routes 3/10/24/15/5/8) are detour-explained | show the rerouted path as the real path | - |
| Vehicle position | Good, ~11 s stale, ~10-15 s per-bus refresh | measured 2026-06-20 | "bus approximately here (as of 15 s ago)" | "exactly here right now" |
| Scheduled times (GTFS + SDT) | High | it is the schedule; full stop_times.txt on disk | "next scheduled 3:05" | - |
| Predicted ETA/Dev, near departure | Decent | final prediction within 3 min of measured truth 87% of the time (50k departures) | "estimated 3:07" close-in | - |
| Predicted ETA/Dev, far out (20+ min) | Low, optimistic | far-out predictions pile at on-time; realized runs later | a RANGE, widening with horizon | "on time" as fact |
| Actual departure time (ADT/done) | DOES NOT EXIST | 0.0% of 18,845 departures ever got an actual or done=true | - | "departed at X", "was on time" |
| Occupancy | Dead | all ~53k readings = 0/Empty | - | any crowding claim |
| Detour active: message windows/count | Unreliable | windows are publication windows (Mar->Nov for an active closure) or degenerate from==to; live probe: 13 detoured routes ALL had DetourActiveMessageCount=0 | - | driving UI state off messages |
| Detour active: `_DET_` trace filename | Reliable | flips with the reroute, timestamped; 16/16 flagged routes also had messages (converse fails) | "route X is on detour" | - |
| Which stops a detour skips | NOT PUBLISHED | StopDepartures lists schedule departures at every stop regardless (case study below) | - | "your stop is served" during a detour |
| Detour reasons / timing detail | Free text only | "Saturday 06/27 from 7am" lives in message text; Effect always UnknownEffect | show the text as text | parsing it as structured truth |

## Case study: the phantom stop (what we must correct, concretely)

**Stop 6301, Burton/Denwood (EB), routes 3 and 24.** The schedule lists ~21 route-24
departures per weekday here. The live API (probed 2026-07-14) lists upcoming
departures at this stop: "10:01 AM, dev 00:02:40" plus more, for both routes. The
deviation is attached to a real tracked bus, which makes the claim look live and
verified.

But routes 3 and 24 have been on the Burton/Cesar Chavez closure detour since
spring, and the detoured path runs ~400 m from this stop. Across our 10 days of
GPS, buses came within 60 m of it exactly TWICE (both during the Fondo weekend,
when the detour configuration temporarily differed) against 200+ scheduled
departures. The API's claim at this stop is wrong ~99% of the time: the trip is
real, the deviation is real, but the bus will pass 400 m away. Nothing in any
endpoint flags this.

**Resolution (three layers, each covering the previous one's blind spot):**

1. GEOMETRIC INFERENCE, instant: detour trace active -> flag scheduled stops on the
   GTFS path but >120 m off the detour path as "likely not served." Client-side
   computable from two fetches. (This exact computation found all 4 Burton stops.)
2. OBSERVATIONAL CONFIRMATION, from the derived-actuals engine: count observed
   passages per stop per service day. Zero observed service for N consecutive days
   -> "not currently served," confidence growing with N, self-healing when service
   resumes. (The Fondo-weekend visits prove geometry alone can go stale: detour
   configs rotate.)
3. REDIRECT, the rider-value turn: at a flagged stop, don't show "no data," show
   the rescue: "Routes 3 & 24 are on detour. This stop isn't currently served.
   Nearest active stop: 400 m east, next bus ~10:04." Computed from detour geometry
   plus observed-served stops. The phantom promise becomes a working answer.

## The gap-closers (what we build to close each gap)

Ordered by leverage. (a) is the foundation; all were validated or spot-checked on
our own logs 2026-07-14.

**a. Derived actuals.** Infer arrival/departure events from GPS trails: a bus's
closest approach to a stop, timestamped, IS the observed passage (accuracy ~ the
10-15 s poll cadence, fine for minute-level claims). VALIDATED: joining 10 days of
trails against 75,730 scheduled departures yielded 50,034 observed passages (66%;
the API published 0 actuals). This is also the only UNBIASED lateness measurement
available (see corrected findings below). Full GTFS stop_times.txt is on disk, so
this extends to all 1,493 stops, not just the 270 timepoints.

**b. Normal-variance baselines.** Per route (later per route x hour x day-type)
lateness distributions from derived actuals. Unlocks "typically 2-6 min late at
this hour" and "running unusually late for this route." Validated per-route:
route 24 median 3.3 min late, p10-p90 [-2.4 .. 9.2]; route 44 median 0.3
[-2.7 .. 4.2]. Nine minutes late is NORMAL for 24 and ABNORMAL for 44; the UI can
say so honestly.

**c. Horizon-calibrated ETA confidence.** Measure official-prediction error as a
function of minutes-to-departure; display ranges that tighten as the bus
approaches. Both endpoints measured: far out = optimistic (predictions pile at
on-time), near departure = 87% within 3 min. The full curve is computable from
data we already log.

**d. Ghost and skipped-stop detection.** Cross-check StopDepartures against live
vehicles: is there actually a tracked bus that will make this departure? Our join
surfaced 22,643 bus-tracked-but-never-near-stop cases as raw signal (needs
refinement to separate collection gaps from true skips). Addresses the worst rider
failure: waiting for a bus that never comes. Largely client-side computable.

**e. Detour activation timing.** Poll GetAllRoutes every few minutes; the `_DET_`
trace filename flipping IS the activation signal, timestamped within minutes. No
text parsing. Combined with (d)-style geometry checks, powers the stop-level
detour warnings.

## What riders concretely get (memory-unlocked claims, by category)

The product case for tier 3. Every example is grounded in numbers already measured
from the 10-day log; the rider-visible phrasing is in quotes.

**ACTUALS - "what actually happened".** The killer question at a bus stop is "did
I already miss it?" and nothing in the API can answer it:
- "The 3:05 already came through - it passed this stop at 3:02." (Or: "it hasn't
  come yet; it's running 4 min behind.") 14% of departures run EARLY, so "just
  missed it" is common and invisible today.
- "Last bus passed here 7 minutes ago. Next expected in ~22." A living stop.
- "The 7:40 ran today" - trip-level confirmation, and the receipt that makes every
  other claim auditable.

**NORMALITY - "what's typical here".** Same lateness number, different meaning per
route (route 24's normal window is [-2.4 .. +9.2] min; route 44's is
[-2.7 .. +4.2]):
- "Runs 2-6 min late at this hour - that's normal for this route." Stops the
  anxious refreshing; the bus is behaving as usual.
- "Running unusually late for this route." Nine minutes late is unremarkable on
  route 24 and an anomaly on route 44; only the per-route distribution can say
  which is which.
- "Buses here sometimes leave up to 3 min early - arrive by 8:02." Route 1000's
  median is EARLY (-0.7 min), DASH's window reaches -5.8. An early departure is
  the single worst rider failure (no recovering from it), and only history reveals
  which stops have the habit.

**RELIABILITY - "the track record".**
- "This departure has run on schedule 9 of the last 10 weekdays." Confidence on a
  SPECIFIC trip, not the route average.
- "After 3 pm, delays roughly triple on this route." Measured: ~3% late at 6 am
  degrading to ~33% by 4 pm. A 2:15 and a 4:15 are not the same product.
- "Route 90 is among the most punctual; route 8 runs late about a third of PM
  rush." Honest rankings (Silver Line ~6% late-share vs route 8 ~30%).
- "ETAs shown 20+ minutes out tend to understate by a few minutes on this route."
  Meta-reliability: how much to trust the countdown itself.

**ADVICE - "what should I actually do".** Where memory compounds into judgment:
- "Need to arrive by 9:00? Take the 8:12. The 8:32 makes it only about half the
  time." From the arrival-time distribution of each specific trip.
- "This stop isn't being served during the detour. Walk 400 m east to
  Burton/Division - next bus there in ~6 min." The stop-6301 rescue: geometry
  flags it, passage history confirms it, the redirect makes it useful.
- "Tight connection: this transfer at Central Station succeeds about 4 times in 5.
  The next guaranteed one is 20 min later." Transfer feasibility needs the JOINT
  history of both legs.
- "Arrive a few minutes early at this stop" vs "no rush, this one always runs
  behind" - per-stop behavioral advice from the early/late asymmetry.

Prototype-vs-product note: first versions of nearly all of these are computable
TODAY from the existing 10-day log (that is where these numbers came from). What
continuous collection buys is that the claims stay TRUE: detours rotate, seasons
change, schedules re-cut. The argument for the always-on collector is not more
data, it is CURRENT memory.

## Emerging behavioral patterns (mined 2026-07-14 from the 50k derived passages)

Patterns beyond the trust question that should shape rider-facing design:

- **"Early" flips meaning at terminals.** Extreme early-habit stops are almost all
  terminals (Kentwood Station 94% early for rt 44, Kirkhof 90%, UM Health-West 85%):
  buses ARRIVE early and lay over, and closest-approach timing conflates arrival
  with departure at long-dwell stops. Design: at terminals, early = "bus is at the
  platform" (presence, good news); at mid-route stops, early = GONE, the one
  unrecoverable failure, where "arrive 3 min before schedule" warnings belong
  (route-level early shares run 9-32%, worst: 51, 27, 1, 33, 44). METHOD NOTE: the
  derived-actuals engine should become dwell-aware (last fix in radius = departure,
  not closest fix) before early-departure claims go public.
- **Delay accumulates along the trip, except where it doesn't.** Median dev by trip
  third: route 24 runs 0.2 -> 4.3 -> 6.9 min; most routes grow 1-2 min end to end;
  route 90 (BRT) stays flat (1.1 -> 1.6); route 8 is flat HIGH (2.3 -> 2.5), i.e.
  its schedule is miscalibrated from the first stop rather than degrading en route.
  Design: ETAs must be position-aware (stops late in the run get wider, later
  windows); route 8 deserves "habitually ~2.5 min behind its printed schedule"
  framing.
- **Frequent services bunch a little; schedule display is the wrong frame for
  them.** DASH busiest-stop gaps: median 9 min [p10 4 .. p90 16], ~11% bunched
  (< half median); route 90: 17 [9 .. 35], 10% bunched. Design: for 51/90 show
  headway ("about every 9 minutes") + live positions, not scheduled times, and
  consider showing the next TWO buses (after a long gap the second bus is often
  the real answer).
- (Established elsewhere but part of this picture: the PM-peak degradation curve,
  detours as steady state, and the single stressed southern/crosstown cluster -
  see CLAUDE.md "What the data shows so far" and the case study above.)

## What stays unclosable (design around, don't promise)

- OCCUPANCY: no data exists (every reading Empty). Drop crowding from the design.
- POSITION FRESHNESS below ~11 s: feed floor. Show recency ("as of 15 s ago")
  rather than pretending real-time. Extrapolation (parked idea) can mask latency
  but adds wrongness risk at stops/turns.
- OFFICIAL CONFIRMATION: everything we derive is observation, not agency truth.
  Frame as "observed" / "typically", which is also just more honest.
- BASELINE SEASONALITY: our baselines are 10 summer, construction-heavy days.
  They need ongoing collection, carry sample-size confidence, and must degrade
  gracefully to schedule-only display where thin.
- EVENT/CONDITIONAL DETOURS ("2 hours before events"): activation not in
  structured data; mitigated (minutes-level) by trace polling, not solved.

## Corrected findings (supersede earlier numbers in CLAUDE.md)

- SYSTEM LATENESS, unbiased (derived actuals, 50k passages): median 1.1 min late,
  p90 5.8; 33% on-time (+-1 min), 14% early, 53% >1 min late, 3% >10 min late.
  The earlier "median 3.3 / 94% late" from the reliability log was SELECTION-BIASED
  (late buses linger in the feed and get over-sampled; on-time ones vanish fast).
  The system is meaningfully better than that biased sample implied.
- API PREDICTIONS: the earlier "predictions are optimistic" finding is a HORIZON
  effect, not a blanket fault. Final pre-departure predictions are decent (87%
  within 3 min); 20+ min out they are optimistic. Trust close-in, range far-out.
- ROUTE 8's unexplained 3.4 km divergence: a real terminal loop at Rivertown that
  buses drive but BOTH the GTFS shape and the agency's own detour KML omit. A
  completeness gap in published geometry, not noise or misbehavior.

## Infrastructure prerequisite

All derivation requires an ALWAYS-ON collector; today's collectors die on Mac
lid-close. Realistic: a Raspberry Pi or ~$5/mo VPS running the vehicle poller (one
fleet call per ~12 s, comparable to the agency's own web app) plus the detour
poller (~minutes). Architecture stays serverless for riders: the collector
periodically publishes small static baseline JSONs (variance windows, calibration
curves, served-stop status); the Netlify site combines live API calls with those
baselines client-side. Ghost-bus and detour-stop cross-checks run in the rider's
browser.

## Claim vocabulary for the UI

Tiered by what the data actually supports:

- SAY FREELY: "scheduled 3:05" - "bus is 1.2 mi away, moving (as of 15 s ago)" -
  "route 24 is on detour" (from trace flag) - the detoured path drawn as the route.
- SAY WITH BASELINES: "typically 2-6 min late at this hour" - "running unusually
  late for this route" - "estimated 3:05-3:11" (range by horizon).
- SAY WITH OBSERVATION HISTORY: "this stop hasn't been served since the detour
  began; nearest active stop 400 m east" - "this trip hasn't been seen and may not
  be running."
- NEVER SAY: "departed at 3:04" - "on time" as fact - anything about crowding -
  exact minutes far in advance without a range.
