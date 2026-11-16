# @plasius/game-multiplayer

Provider-neutral authoritative rooms, matching, reconnect and runtime delegation
for Plasius spatial games, with a separate native Azure Web PubSub adapter.
[Task #1](https://github.com/Plasius-LTD/game-multiplayer/issues/1),
[Feature #2387](https://github.com/Plasius-LTD/plasius-ltd-site/issues/2387),
[Epic #2382](https://github.com/Plasius-LTD/plasius-ltd-site/issues/2382).

This package is not yet published or qualified as a hosted multiplayer service.
It includes no games or production infrastructure. Hosts supply authenticated
account/guardian/block policy, atomic storage, persisted authority leases,
released game-runtime and Web PubSub credential issuance. Clients cannot confer
ownership or submit authoritative scores.

## Rooms and matching

`createRoom(config)` creates an empty waiting room. `joinRoom(room, member,
admission, context)` returns a detached candidate. Every mutation checks the
previous revision/epoch; the host must atomically compare them again and persist
the candidate before success. Parsing does not authorize a caller.
`projectRoom(committedRoom)` emits game slots, generated aliases and public room
metadata, omitting account and connection identifiers.

Rooms have at most four slots and expire within 12 hours. Admission binds room,
revision, subject and a deadline within 60 seconds. Private invitations cannot
override capability, guardian or mutual-block policy. `startRoom` requires all
allocated members connected and minimum participation. `disconnectMember` grants
100–120,000 ms of grace without extending it on duplicate closes.
`reconnectMember` requires fresh admission, preserves the slot and increments
the generation. Old closes cannot disconnect replacements. `leaveMember`,
`expireRoom`, `finishRoom` and `transferAuthority` preserve lifecycle/fencing;
finished or abandoned rooms cannot restart.

`planMatch(tickets, { now, skillWindow, maxLatencyMs, canPair })` returns a private
plan or `null`. Tickets expire within five minutes; public matches require 2–4
players. Exact game/mode/rules/content/difficulty/assistance/region/player-count
partitions, latency/skill windows and mutual peer policy constrain matching.
The oldest feasible group wins, using ticket ID to break ties. Hosts atomically
consume every returned ticket revision and create the room; plans confer no
reservation. Capacity is 256 tickets; search stops after 16,384 candidate steps
with `match-search-budget`. Resolve policy before matching: only synchronous
literal `true` admits a pair. Async policy fails the whole plan; exceptions deny
the affected pair.

## Runtime-backed authority

```ts
import { createAuthority } from "@plasius/game-multiplayer";
import { createGameRuntime, parseInput, serializeState } from "@plasius/game-runtime";

// The host supplies gameRules, committedActiveRoom and persistedLease.
const runtime = createGameRuntime(gameRules, { seed, players: ["p1", "p2"] });
const authority = createAuthority({
  room: committedActiveRoom, lease: persistedLease, runtime,
  clock: Date.now,
  enabled: () => cachedLiveHostDecision === true,
  parseInput,
  projectState: (snapshot, playerId) => serializeState(gamePublicView(snapshot, playerId)),
});
const receipt = authority.receive(authenticatedConnection, clientFrame);
const work = authority.advance(elapsedMs);
const publicSnapshot = authority.snapshot(authenticatedConnection);
```

Consume the released runtime in the host. This structural port introduces no
unreleased workspace dependency and delegates input semantics, ordering, replay,
future-window/queue decisions and fixed ticks to game-runtime. Only the bound
member slot/current generation may submit intentions. `updateRoom` accepts newer
committed compatible records; `renewLease` requires matching live leases within
30 seconds and room expiry. Higher epochs, expiry, unavailable/disabled policy,
backward clocks, runtime faults and discarded simulation time stop admission.
Overload is explicit; stopped authority is not ranking-eligible. `dispose` ends
access and disposes the runtime.

Use game-owned recipient projections, never private checkpoints. The library
cannot infer which state is safe to broadcast. Frame parsers reject extra fields,
future versions and malformed/oversized JSON. Client frames: 4 KiB UTF-8, with
2 KiB intention JSON. Server frames: 64 KiB, including outer encoding; projected
JSON alone: 48 KiB. Preset `ready`, `nice`, `thanks`, `retry` signals have per-player
replay checks and a one-second cooldown. Hosts filter recipients against blocks.

## Lazy Azure transport

```ts
const { connectWebPubSub } = await import("@plasius/game-multiplayer/azure-web-pubsub");
const transport = connectWebPubSub({
  ...authenticatedNegotiation, // url, expiresAt, serviceOrigin, hub, roomId, generation, epoch
  signal: abortController.signal,
  onFrame: frame => applyValidatedPublicGameFrame(frame), // synchronous, bounded
});
if (await transport.ready) {
  const receipt = await transport.send(clientFrame);
  // acknowledged means provider receipt, not game acceptance or saved progress.
}
// Observe transport.closed; dispose on logout and renegotiate through host policy.
```

Native WebSocket uses `json.webpubsub.azure.v1` with an exact configured
`wss://<resource>.webpubsub.azure.com` origin/hub and negotiation expiring within
60 seconds. `ready` confirms transport only; the host must establish authenticated
membership. Clients send upstream `arcade` events. Grant no group join/publish
roles. Only server-origin frames for the bound room are delivered; old epochs
and replayed sequences are discarded. Payloads, identifiers, provider error text
and credential URLs are never logged or returned in status.

Defaults: 5-second handshake, 2.5-second ack timeout, 15-second heartbeat window,
32 pending acks, 64 KiB socket buffering. There is no hidden send queue, retry or
automatic reconnect. Missing acks close the connection and resolve outstanding
sends as `unconfirmed`. Never blindly replay them: renegotiate and reconcile
through runtime sequence/checkpoint rules. Abort/dispose releases listeners and
timers and ignores late callbacks. Core imports no Azure/browser transport.

[Microsoft protocol reference](https://learn.microsoft.com/en-us/azure/azure-web-pubsub/reference-json-webpubsub-subprotocol).

## Rollout and validation

The host evaluates stored `arcade.multiplayer.enabled` and private/public backend
capabilities. All remain disabled; public exposure also requires the launch
barrier and all 24 games qualified. Rollback stops admission and preserves
results/saves. No environment override or local authorization fallback exists.

Use Node from `.nvmrc`, `npm ci`, then `npm run typecheck`, `npm run lint`,
`npm run test:coverage`, `npm run build`, `npm run pack:check`, `npm run audit:npm`.
All coverage metrics retain the 80% gate. Every source appears in combined LCOV,
including Node privacy coverage. The exact 15-path tarball contains self-contained
ESM/CJS/declarations for both entries. Private contributor records remain outside
the repository and package.

CI uses admitted frozen/protected refs on the quarantined runner group. Publish
only through main `.github/workflows/cd.yml` and `production`. The default-off
first-registration route is prepared under game-runtime#3/site#2531, pending
operator credential authorization, verified absence, sealed artifacts and OIDC
handover. Never publish locally or use production workspace links. Unit/browser
protocol tests cannot qualify Azure deployment or 100 players in UK South.

See [design](docs/design/authoritative-sessions.md),
[ADR 0001](docs/adrs/adr-0001-authoritative-session-boundaries.md),
[ADR 0002](docs/adrs/adr-0002-azure-event-transport.md),
[TDR 0001](docs/tdrs/tdr-0001-room-and-admission-bounds.md),
[contributing](CONTRIBUTING.md) and [security](SECURITY.md). Apache-2.0.
