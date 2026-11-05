# Digital Switching, Inverters and a Person Overboard

The switches a crew throws from a display, the boat's inverter, and a person overboard.
Every switch the boat sends is one a display can PUT to; the inverter is sent with its
DC and AC sides and its mode; a person overboard goes through the server's own
Notifications API. The switches and the inverter work inside the systems model, in its
fixed steps (`switches.ts`, `inverters.ts`, `systems/model.ts`); the person overboard is a
fault the run follows (`mob.ts`, `engine/simulation.ts`).

## The Switches

Each switch is `electrical.switches.<id>.state`, 1 on and 0 off, every second, with its
name in `meta.displayName`. Most follow what the boat is doing; a PUT puts the crew's
hand on one, and how long the hand stays depends on the switch.

| Switch             | Id                          | Follows                                                              | A PUT                                                                                                                                                 | On which boats                   |
| ------------------ | --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Navigation lights  | `navLights`                 | the lights rule: on from sunset under way (and at anchor, under 7 m) | on or off, until she next changes what she is doing (leaving, anchoring, weighing, coming alongside, sail to engine) or the sun sets or rises         | every boat                       |
| Anchor light       | `anchorLight`               | on from sunset at anchor                                             | as the navigation lights                                                                                                                              | 7 m and over                     |
| Deck lights        | `deckLights`                | off                                                                  | on until switched off                                                                                                                                 | 9 m and over                     |
| Cabin lights       | `cabinLights`               | on from sunset until the crew turns in at 22:30                      | on or off until that next changes                                                                                                                     | a boat with a cabin              |
| Fresh water pump   | `freshWaterPump`            | runs as water is drawn: a few seconds every few minutes              | off: no water from the taps until switched on                                                                                                         | a boat with a fresh water tank   |
| Fridges            | `fridge`                    | on                                                                   | off: the compressors stop and the inside warms towards the cabin; on, they cool it again                                                              | a boat with a fridge             |
| Freezers           | `freezer`                   | on                                                                   | as the fridges                                                                                                                                        | a boat with a freezer            |
| Fuel transfer pump | `fuelTransferPump`          | runs while it tops a day tank up from storage                        | on: tops up the lowest day tank not full ("the day tanks are full" if none); off: stays off until switched on                                         | a boat with day tanks (the 45 m) |
| Windlass           | `windlass`                  | runs while the chain pays out and heaves in                          | at anchor, on heaves the chain in to short stay and stops; off stops it where it is; refused with the anchor up ("the anchor is up")                  | with a windlass (8 m and over)   |
| Stabilisers        | `stabilisers`               | on under way above 6 kn, and at anchor on zero-speed fins            | off: stay off, with the roll back, until switched on                                                                                                  | the 34 m and 45 m                |
| Each radar         | `radar`, `radarX`, `radarS` | transmitting under way, standby alongside and at anchor              | off: standby until switched on; on at anchor: transmits until she comes alongside; refused alongside ("the radar does not transmit alongside")        | each radar the profile counts    |
| Bilge pump         | `bilgePump`                 | its float switch: on at 30 % of the sump, off at 5 %                 | off: stays off with water in the bilge, a decision the crew made, until switched on or the high water float closes; on: runs to the float's off point | every boat                       |

The 4 m boat has only `navLights` and `bilgePump`. The bilge pump's state is sent while the
bilge has water, as before (see the [faults README](../faults/README.md#bilge-flooding)).

**Their draw** stays where it was in the books, and the switch takes it away: the
navigation and anchor lights each 10 W plus 1.5 W a metre (`navigation lights`), the
windlass in bursts (`windlass`), the fridges' and freezers' compressors (`fridges`), the
stabilisers on the generators. The cabin lights are a tenth of the hotel load (on the
generators, the shore or the inverter), or of the house bank's own load on a boat with no
generator. Three loads gain a line of their own on the house bank: the deck lights, 6 W a
metre (`deck lights`); the fresh water pump, 60 W, more on a boat over 15 m
(`fresh water pump`); and the fuel transfer pump, 400 W (`fuel transfer pump`).

A switch's value moves at the model's next step, within two seconds of scenario time. The
crew's hands are saved with the systems, so a restart keeps them.

## PUT

The plugin registers a PUT handler with the server (`app.registerPutHandler`) for every
switch, by its own path and on its bank channel; the server marks each `supportsPut` in
its metadata. A display PUTs the value as KIP and the NMEA 2000 switch displays send it:

- `1` or `0`, `true` or `false`, `"on"` or `"off"` (in any case);
- anything else is refused: `a switch takes 1 or 0, true or false, "on" or "off"`.

The answer is the server's ActionResult: `{ "state": "COMPLETED", "statusCode": 200 }`,
with a `message` where there is something to say ("on: they work under way above 6 kn"),
or `statusCode` 400 and the reason when it is refused.

```sh
curl -X PUT -H 'Content-Type: application/json' -d '{"value": 1}' \
  http://localhost:3000/signalk/v1/api/vessels/self/electrical/switches/deckLights/state
```

## The Switch Bank

The same switches are sent as the NMEA 2000 converter sends a switch bank:
`electrical.switches.bank.0.<n>.state`, channels numbered from 1 in the profile's fixed
order (the table's), the first sixteen, with the switch's name in `meta.displayName` on the
channel and its `state`. A display built for a switch bank sees the same switches and can
PUT to them there. The numbering depends only on the profile, so it is the same across a
run and a restart.

## The Inverter

A boat with an inverter in the books sends `electrical.inverters.inverter`, every second:
the hybrid catamaran, whose inverter carries her hotel load off the propulsion bank, and
the boats under 24 m with a generator (the 12 m yacht, the 15 m sailing yacht and
motor-sailer, the 20 m motor yacht), whose inverter carries the sockets off the house bank.

| Path                                             | Value                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `dc.voltage`, `dc.current`                       | its bank's voltage, and the current it draws from it                                                                     |
| `ac.lineNeutralVoltage`                          | the boat's AC voltage while it can carry a load, 0 otherwise                                                             |
| `ac.frequency`                                   | the boat's AC frequency while it can carry a load, 0 otherwise                                                           |
| `ac.current`, `ac.realPower`, `ac.apparentPower` | what it carries, at a power factor of 0.9                                                                                |
| `inverterMode`                                   | `idle` under no load, `inverting` under load, `standby` alongside or with a generator running, `faulted` under the fault |

What it puts out is what the books take from its bank, less 10 % of losses.

**The fault, `inverterFailure`**: the inverter trips to `faulted`, its AC goes to 0 and
the loads on it are shed (a hybrid's hotel load and water maker with it), and the alarm
panel raises `notifications.electrical.inverters.inverter.inverterMode` at `alarm`,
`visual` and `sound`, "Inverter failure: no AC from the batteries". It clears after 10 to 60
minutes or by hand. See the [faults README](../faults/README.md#inverter-failure).

## A Person Overboard

The server's Notifications API has `POST /signalk/v2/api/notifications/mob`, which
raises `notifications.mob.<id>` at `emergency` with her position and the time. The
simulator uses the same API rather than raising its own:

- **The fault, `personOverboard`**, raised by hand (the seed never throws it), calls the
  plugin API's `app.notifications.mob`, before her next position goes out, so the alarm
  has where she was. Its message gives the scenario time: "Person overboard at 15:21:07
  UTC". If the autopilot was engaged it stands by, and the helm has her.
- **She goes on**, and the run view and the status line give the person's bearing and
  distance from her: "person overboard, 120 m astern, bearing 263°", the side (ahead, to
  starboard, astern, to port) by her heading.
- **It clears only by hand**, "recovered", which resolves the notification through the
  same API (`app.notifications.clear`). With the server's notification management off the
  plugin sends the notification back to `normal` itself.
- **A MOB raised by anyone else** on the server (a display posting to the same API, or a
  device sending `notifications.mob`) is heard through a subscription, and the run shows
  her bearing and distance from it too, until it goes back to normal.

The boat's own alarm panel raises nothing for it: the server's notification is the alarm.

## The Paths

| Path                                                       | When                                           | On which boats            |
| ---------------------------------------------------------- | ---------------------------------------------- | ------------------------- |
| `electrical.switches.<id>.state`                           | every second (the bilge pump while wet)        | each switch in the table  |
| `electrical.switches.bank.0.<n>.state`                     | with the switch it carries                     | the first sixteen of them |
| `electrical.inverters.inverter.*`                          | every second                                   | a boat with an inverter   |
| `notifications.electrical.inverters.inverter.inverterMode` | while it has failed, and `normal` as it clears | a boat with an inverter   |
| `notifications.mob.<id>`                                   | raised and resolved by the server              | any boat                  |

**The schema.** Signal K schema 1.8.2 takes the inverter's paths. It has no
`electrical.switches` at all, so the schema checks leave the switches and the bank out, as
they do the sails inventory; a test checks they are still refused.

## The Page, the Run View and the Status Line

- **The page** has a Switches card: each switch with its bank channel, its state, and a
  button that throws it with a PUT to the server's own API, as a display would; a refusal
  shows as the page's error, and a message under the card. The Systems card shows the
  inverter's mode and what it carries; the Where the Boat Is card shows a person
  overboard, their bearing and distance, where they went in and when.
- **`GET /run`** carries `switches` (`id`, `name`, `state`, `channel`), `inverters` (`id`,
  `name`, `mode`, `acPowerW`, `dcPowerW`, `bank`) and `mob` (`by`, `notificationId`,
  `latitude`, `longitude`, `since`, `distanceM`, `bearingDeg`, `side`, `words`).
- **The status line** adds each person overboard, straight after her speed.

## Tests

`test/simulator-switching.ts` runs on the controllable clock: the values the displays send;
each boat's switches and their bank order; the navigation and anchor lights held and let
go as the lights she should show change; the stabilisers held off with the roll back; a
radar on standby, refused alongside and watching at anchor; the windlass heaving in,
stopping and refused with the anchor up; the deck lights', fresh water pump's and transfer
pump's draw by switch; the fridges warming and cooling; the cabin lights by the sun; the
bilge pump held off until the high water float; the bank and the holds across a restore;
the inverter on every profile that has one and none on the rest, its mode, its AC against
the books, and its fault; the person overboard through the server's own notification
manager, the bearing and distance as she goes on, a MOB raised by another source, and its
clearing; the plugin's PUT handlers and their answers; and the schema on every new path.
The systems soak checks the same on every profile's day (see the [soak
README](../soak/README.md)).
