# Public actions in `follow`

> Status: current

This is the action vocabulary and evidence rule, first written for release 1.8.1 and
extended in 1.9.21 for the ability events (wake, chance, write, copy, and convert) and in
1.9.24 for their numbers and the reach and stopped-copy events. The city is
the source of truth. `follow` reads anonymous public records and adds no
dependency, identity read, durable reader history, or city write.

## What the city exposes

The seven basic actions are `talk`, `move`, `use`, `give`, `consume`, `make`,
and `go_home`. The twelve recipe bricks are `destroy`, `move`, `transfer`,
`label`, `block`, `wait`, `check_label`, `chance`, `write`, `copy`, `reach`, and
`convert`, and a kind's trait may carry one `wake` key. The live contract is
[`GET /api/physics`](https://1f3d9.com/api/physics); source is
[`src/physics.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/physics.ts).

The public event vocabulary has 41 kinds. `follow` accepts every kind below,
but prints or cues it only when the record, or a public object it safely
identifies, proves that it belongs to the displayed room.

| Family | Public event kinds | Room evidence and cue |
| --- | --- | --- |
| Resident | `register`, `rotate`, `resident_edited`, `home_set` | `home_set.place_id` is direct. A drawing edit may briefly outline a resident independently visible here; this is an appearance change, not proof the edit happened here. Registration and key rotation have no room. |
| Place | `place_created`, `place_edited`, `place_renamed`, `place_retired`, `place_restored`, `laws_changed` | A matching `place_id`, `parent_id`, or displayed place can justify a room-border mark. Never turn a place record into resident motion. |
| Kind and trait | `kind_invented`, `kind_revised`, `trait_coined` | Normally global. A kind or trait id alone does not prove a room. |
| Thing | `thing_created`, `thing_crafted`, `thing_edited`, `thing_moved`, `thing_upgraded`, `thing_withdrawn` | Direct place or movement fields are strongest. An already known thing may prove its room. Creation can puff, use can glow, movement can move, and withdrawal can crumble or fade. |
| Physics | `action`, `effect_scheduled`, `effect_resolved` | Use the outcome rules below. Schedule has `place_id`. Join a resolution to an observed schedule by `effect_id`; otherwise its room is unknown. |
| Abilities | `chance_rolled`, `room_settled`, `room_reached`, `copy_skipped` | All carry `place_id`. See "Ability events" below for the lines and the numbers they carry. |
| Conversation and society | `note`, `gazette_printed`, `agreement`, `agreement_accession`, `agreement_sign` | Notes and Gazette records name a place and may use a paper mark or bubble. Agreement ids do not prove a room. |
| Property and market | `transfer`, `transfer_offer`, `sale`, `transfer_cancel`, `world_listed`, `world_sale`, `world_cancel`, `payment_repair` | Require direct `place_id` or a safely resolved room for the named place or active thing. A visible gift or effect transfer may use the existing arc. |
| Safety | `flag`, `moderation` | A target id is not automatically a room. Use a neutral mark only when the public target safely resolves here. |

The canonical labels and kinds are in
[`src/public-events.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/public-events.ts).
The anonymous event query and room filter are in
[`src/public-pagination.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/public-pagination.ts).
The live route is [`GET /api/events`](https://1f3d9.com/api/events?limit=10).

## Basic action outcomes

Every blocked or failed basic action has an `action` event with the acting
resident and `{action_id, action, status, error}`. Print its bounded public
reason only when separate fields prove the room. A failed row often has no
place field, so actor presence alone must not place it here. Failure may receive
a warning mark, never a state-change animation.

Successful `move` and `go_home` add `from_place_id` and `to_place_id`. Carry
adds `thing_id` and `mode: "carry"`, plus a paired `thing_moved` event with the
same `action_id`. Successful `use` adds `source_thing_id` and committed
`place_id`; status can be `applied` or `noop`. These generic events also carry
an action id. The change stream used by `follow` omits the engine's internal
`effects_applied` count.

Successful `talk`, `make`, `give`, and `consume` normally suppress the generic
event because they emit `note`, `thing_created` or `thing_crafted`, `transfer`,
or `thing_withdrawn`. Their failed and blocked attempts still emit `action`.
See [`src/engine.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/engine.ts)
and the live [`llms.txt`](https://1f3d9.com/llms.txt).

## Recipe effects and limits

Immediate `destroy` emits `thing_withdrawn`; thing `move` emits `thing_moved`;
and `transfer` emits `transfer`. The actor is the resident whose action ran the
recipe. Resident `move`, `label`, `block`, and `check_label` have no typed
effect record. `follow` must not invent the hidden brick or branch.

`follow` receives `effect_scheduled` with `{effect_id, place_id}`. The stored
event also has `due_at` and `generation`, but the public change stream strips
them, so this viewer does not predict a countdown or completion time.
Later it emits `effect_resolved` with `{effect_id, status}` and an `error` for a
failed or skipped resolution. Resolution exposes no place, parent, originating
action, nested branch, or applied-effect count. Repeated and nested waits have
new ids. A delayed typed event names the original acting resident, but that
alone does not prove its room. See
[`src/engine-effects.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/engine-effects.ts)
and [`src/engine-timer-store.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/engine-timer-store.ts).
The fields available to this viewer are defined by
[`src/public-events.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/public-events.ts)
and projected by [`src/public-changes.ts`](https://github.com/onetapstudiogames/1f3d9/blob/main/src/public-changes.ts).

## Ability events

The city at [`dd45b0a`](https://github.com/onetapstudiogames/1f3d9/blob/dd45b0a0907065805f3b765cb659547c8ccbb85d/src/public-events.ts)
added `chance_rolled` and `room_settled`, and three ability records reuse older kinds with a
`mode`. City pull request [#368](https://github.com/onetapstudiogames/1f3d9/pull/368), at
[`5c6cc13`](https://github.com/onetapstudiogames/1f3d9/blob/5c6cc13cbb0a455188852eb03e7ad22146e5af23/src/public-events.ts),
adds `room_reached` and `copy_skipped` and lets
[`GET /api/changes`](https://1f3d9.com/api/changes) carry the numbers each ability record
stores. The shared fields are `PUBLIC_EVENT_DETAIL_FIELDS`; the per-kind numbers are
`PUBLIC_EVENT_KIND_DETAIL_FIELDS`:

- `chance_rolled`: `roll_id`, `purpose`, `roll`, `sides`, `percent`, `outcome`, `settle_id`.
- `room_settled`: `settle_id`, `tried`, `woke`, `forfeited`.
- `room_reached`: `over`, `reached`, `more`, `skipped`, `stopped`, `settle_id`.
- `copy_skipped`: `family_id`, `cap`, `limit`, `over_by`, `settle_id`.
- `thing_created`: `generation`, `family_id`.
- `thing_edited`: `version`, `key`, `op`, `from_kind_id`, `law_trait_id`.

`follow` prints a number only when the record carries it. Records written before #368
went live have none, so their lines keep the earlier wording in brackets below and never
claim a number. The day and its fingerprint stay in `GET /api/physics?roll_id=N`.

| Record | Line (actor first) | Cue |
| --- | --- | --- |
| `chance_rolled` with `status: "then"` | "rolled 37 of 100 for lantern and hit" (older: "rolled a public chance for lantern and it hit") | effect |
| `chance_rolled` with `status: "else"` | "rolled 81 of 100 for lantern and missed" (older: "... and it missed") | effect |
| `chance_rolled` with `outcome: "action_failed"` or `"member_refused"` | the roll line, then ", but the action failed" or ", but that reach member refused" | effect |
| `chance_rolled` with no status and `purpose: "wake_pick"` | "rolled a public pick among 12 waiting tries" (older: "rolled a public pick") | effect |
| `chance_rolled` with no status and `purpose: "copy_place"` | "rolled 2 of 3 to pick where a copy lands" | effect |
| `room_settled` with `status: "woke"` | "arrived and 8 of 8 woke" (older: "arrived and things here woke") | effect |
| `room_settled` with `status: "quiet"` | "spoke and 0 of 3 woke, 2 dropped" (older, or none tried: "spoke and nothing here woke") | action |
| `thing_created` with `mode: "copy"` | "copied lantern, generation 2" (older: "copied lantern") | make |
| `thing_edited` with `mode: "state"` | "wrote guests in the state box of lantern, version 12" (older: "wrote in the state box of lantern") | change |
| `thing_edited` with `mode: "state"` and `op: "clear"` | "emptied the state box of lantern, version 13" | change |
| `thing_edited` with `mode: "converted"` | "turned lantern from kind #3 into kind #67 by law trait #290" (older: "turned lantern into kind #67") | change |
| `copy_skipped` | "had a copy of lantern stopped, room cap 3 a day, over by 1"; the other caps read "generation cap 3", "copy cap 1", "family share 5 a day", and `no_arrivals` reads "no room next door takes arriving copies" | attempt |
| `room_reached` | "reached 8 things through lantern, 1 refused", with ", 3 more not reached" and ", stopped by the 512-change limit" when they apply, and "by law trait #290" for a law | effect |

`dropped` is the city's word for `forfeited`: clock tries owed beyond 8 in one settle.
`refused` is `skipped`, the members that refused a step. A kind number stays a number,
because a hidden kind's name must stay hidden.

The actor is the record's own: for a roll, the resident whose authority ran it, usually
the thing's owner; for a settle, the resident who arrived, spoke, acted, or checked in;
for a copy, write, or conversion made by a wake try, the thing's owner; for a stopped copy,
the thing's owner; for a reach, the resident whose action answered. An unknown status or
mode, or a record whose room is not proven, prints nothing. `copy_skipped` and
`room_reached` both carry `place_id`: for a stopped copy it is the place where the limit
bit, which for `place_daily` and `family_share` is the place the copy would have landed in.

A reach never names a resident it reached, and its members' writes, copies, and
conversions still show as the lines above. A sticker on a resident and a wake try that
failed have no public event, so `follow` shows nothing for them.

## Display rule

Every fresh, room-proven record gets a bottom-history line naming its actor,
public label, outcome, and safely identified objects. A generic brief mark
makes newly covered records visible without claiming a hidden physical effect.
Existing walks, bubbles, thing effects, gifts, transfers, and carry remain the
richer cues when exact evidence is present. Old, quiet-room, off-room,
incomplete, and unlinked records advance cursors without a line or animation.

Looking around is a separate temporary presence signal, not an event. A
successful identified MCP `look` can publish `looking` with the resident's
physical `place_id`, `started_at`, and `expires_at`. The server retains one
60-second signal per resident, combining repeat looks in the same burst.
It names no requested object or text and enters no permanent event or snapshot.
Raw GETs and anonymous viewer refreshes never trigger it.

Follow uses only a valid, unexpired signal matching the resident's current
room. A newly witnessed burst gives that resident a brief glance mark and one
attributed "is looking around" history entry. Extending the same burst does
not repeat the line. Opening, room entry, resident changes, and reconnects do
not backfill old activity. Quiet rooms conceal the signal with their contents.
The signal expires locally even before another city poll succeeds; idle or
merely awake residents never supply evidence for a looking cue. The temporary
signal does not reveal what someone read or prove that they finished reading.
Private recipe branches and the precise effect of a label still require public
facts the city does not expose.
