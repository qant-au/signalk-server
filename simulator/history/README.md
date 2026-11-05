# The Record and the History API

What the boat has sent since the run started, kept so the server's own History API
(`/signalk/v2/api/history`) and its older playback and snapshot API answer from the run.
A chart plotter asking for the last hour's track, or a display drawing the speed over the
morning, gets what the simulator sent, at the times of the scenario.

## The Record

`record.ts` keeps, in typed arrays:

- **The own vessel:** every path sent with a number for its value, and the position. One
  row every ten seconds of scenario time (`RECORD_STEP_MS`), holding the last value each
  path sent in those ten seconds. A path sent once a minute has a value in one row in six
  and nothing in the others. A value sent as text or as an object (`navigation.state`,
  `environment.current`, `navigation.attitude`) is not kept, and a path sent from two
  sources keeps whichever was sent last in the ten seconds.
- **Each AIS target:** its position, speed over ground and course over ground as it was
  heard, a row for each ten seconds it was heard in. All targets share one ring.

The record holds **a day at most**: an own row, or a target row, more than a day older
than the newest is dropped as a new one comes. At a time multiplier of 24 a tick is 24 s of
scenario time, so most ten-second rows are empty; the record still holds a day, not 8640
rows.

The record is kept in the plugin's data directory (`record.bin`, beside `state.json`):
written every minute of the run, as the boat arrives, and as the plugin stops. A resume
reads it back and carries on recording, dropping anything after the time it resumes from.
A jump back from the page drops what comes after the time it jumps to; a jump forward
leaves a gap. A fresh run (a new sample, or resume off) starts a fresh record.

### What It Costs

The memory is fixed by what is recorded, not by how long the run is:

| Part                  | Each                                                     | For a day                         |
| --------------------- | -------------------------------------------------------- | --------------------------------- |
| The own vessel's rows | 20 bytes a row: its time and the position                | 169 KiB                           |
| Each own path         | a column of 8640 doubles, made as the path is first sent | 67.5 KiB                          |
| The targets           | 32 bytes a row, the ring doubling as it fills            | at most 30.5 MiB (1,000,000 rows) |

`recordBoundBytes(paths)` gives the bound for a number of own paths. Measured:

- Miami's 20 m boat with the traffic on, a day: 153 own paths and 769 targets heard,
  112,729 rows, **14.2 MiB** in memory, 13.4 MiB saved; saving it takes 16 ms and reading
  it back 42 ms.
- The systems soak, without traffic: the largest is the 45 m motor yacht's day out, 251 own paths and **16.8 MiB** for the day.

## The History API

The plugin registers the record with `app.registerHistoryApiProvider`
(`provider.ts`). The server's routes parse the query; the provider answers.

- **`GET /signalk/v2/api/history/values?paths=...&duration=PT1H`** gives the values over
  the range: `from` and `to`, `from` and `duration`, `to` and `duration`, `duration` alone
  or `from` alone. A range with no end ends at the scenario time the run has reached, so
  `duration=PT1H` is the run's last hour, whatever the clock on the wall says. A duration
  in months or years has no fixed length and is refused.
- **`resolution`** (seconds, or `1m`, `1h`) buckets the rows; a bucket's time is its start.
  Without one, or with one under ten seconds, a bucket is a row.
- **Every aggregate:** `average`, `min`, `max`, `first`, `last`, `mid`, `middle_index`,
  `sma` (default 5 buckets) and `ema` (default alpha 0.2), the last two over the buckets'
  means. A path whose units the server's metadata gives as `rad` is averaged round the
  circle, `sma` and `ema` too: 359° and 1° average to 0°, the result in the samples' own
  convention, and samples that cancel give null.
- **`navigation.position`** goes out as `[longitude, latitude]`, each aggregated on its
  own; its default aggregate is `first`, as the server parses it.
- **Nothing sent is `null`**: a bucket the path has no value in, before the record and
  ahead of it.
- **`context`** is the own vessel when left out, `vessels.self` or the server's own
  context, or a target's context.
- **`sourcePolicy=all`** gives each path `$source: simulator`; a path asked for with
  another source (`path|n2k.115`) has nothing.
- **`GET /signalk/v2/api/history/contexts`** lists the own vessel and each target heard in
  the range; **`/paths`** the paths sent in it, the own vessel's or a target's.

### The Default Provider

The server makes the first history provider registered its default and saves it in
`settings.json` (`historyApi.defaultProvider`), but a settings file that already names
another provider keeps it. The rig's names `kip`, whose own history provider registers
there too. Where the named one is not registered, the server answers from another and
raises a warn notification, `notifications.server.history.defaultProvider`, the first
time it does.

So as the run starts, after registering, the plugin makes itself the default through the
server's own History API, `POST /signalk/v2/api/history/_providers/_default/signalk-simulator`,
over the loopback to the server's HTTP port. That saves it in the settings, the Admin UI's
Default History Provider (Apps & Plugins, Configuration) shows it, and no request ever finds the
default missing, so the warning never comes. It asks first and does nothing when the
simulator is the default already. The plugin setting **Make the simulator the server's
default history provider** (`historyDefault`, on by default) turns it off. Where the
server will not have it (security on answers 403; a server serving only TLS refuses plain
HTTP), the plugin says so in the server log and the default stays as it was; set it in
the Admin UI.

`GET /signalk/v2/api/history/_providers` lists the providers and which is the default.

## The Playback

The plugin also registers the record with `app.registerHistoryProvider`, the older API
(`playback.ts`):

- **Playback:** a WebSocket opened at
  `/signalk/v1/playback?startTime=2024-03-16T14:00:00Z&playbackRate=10` replays the record
  from that time, the own vessel's row and each target's row as deltas stamped with the
  times they were recorded, at ten times real time. It stops sending at the end of the
  record. A time after the record's end closes the socket with "No data found".
- **Snapshot:** `/signalk/v1/snapshot/vessels/self?time=...` gives the own vessel as it was
  at that time (its row within the minute before it), and each target last heard within
  the ten minutes before it.

## The Page and the Run View

The page's **History and Weather** card shows the record's span (from when, how many
rows, how much memory), the Weather API's latest observation at the boat, how far ahead
it forecasts and its warnings. `GET /plugins/signalk-simulator/run` has the same as
`history: { from, to, rows, bytes }` and, beside the instruments' weather,
`weather: { observation, forecastTo, warnings }`. The status line gives the record's
length: "record 2 h 14 min".

## Tests

`test/simulator-history.ts`: the record (rows, paths, targets, the day's bound, the memory,
save and restore, the keeper through a resume, a restart and a fresh run), the History
API (every form of time range, every aggregate, the circular average, bucketing, nulls,
the position's order, a target, contexts and paths, sources), the playback and snapshot,
and the plugin registering all three and saving the record as it stops.
