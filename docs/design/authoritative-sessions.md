# Authoritative arcade sessions

Work: game-multiplayer #1, site Story #2419, Feature #2387, Epic #2382.
Stored host flag: `arcade.multiplayer.enabled`, initially disabled. Backend
capabilities `arcade.multiplayer.private` and `arcade.multiplayer.public` own
access; the public launch barrier remains independently required.

## Package assessment and boundary

Use `/Users/philliphounslow/plasius/schema` as the package baseline, including
runtime/tooling files, public legal documents, private-artifact controls and
coverage gates. Reuse released `@plasius/schema` for all wire contracts.
`@plasius/auth` and `@plasius/api` own identity, middleware, quotas and cooldown;
their sessions are authentication sessions, not authoritative game rooms.
`@plasius/graph-events` owns graph event dispatch. None provides matchmaking,
room state, reconnect ownership or game authority.

`@plasius/game-runtime` owns input validation, fixed ticks, deterministic game
state and checkpoints. Do not duplicate that engine here. Define an injected
authority interface so the host supplies the released runtime and game rules.
Do not introduce a production workspace link while its registration is pending.
Provider adapters have separate lazy entry points. The site owns account/guardian
eligibility, blocks/reporting, authenticated capability evaluation, persistence,
Web PubSub credential issuance and deployment. No infrastructure is provisioned
by this package work.

## Domain contracts

Version every room descriptor, membership, command, transport envelope and result
boundary. Reject undeclared fields, non-finite numbers, oversized arrays/text,
invalid versions and client-authored scores or transforms. Stable game, mode,
rules/content version, difficulty and gameplay-affecting assistance identify a
compatible session; no cross-version matching. IDs are opaque bounded tokens,
never profile data or contacts. Public descriptors contain aliases/player slots,
not authentication subjects, invitations or transport credentials.

Room lifecycle is waiting -> active -> finished/abandoned, with explicit member
connection state and bounded reconnect deadlines. Ownership uses a persisted
monotonic fencing epoch: an old simulation worker cannot mutate a room after
authority is transferred. Clients never choose or advance that epoch. A transport
connection is bound to one room, member and generation; a replacement connection
invalidates the previous connection's commands. Disconnection has a grace period;
explicit leave and expired reconnect cannot silently rejoin an active match.

The synchronous room transition core validates commands and returns a detached
candidate. The host commits it with atomic revision/epoch comparison before
emitting success or allocating authority. No unbounded command history is kept.
Idempotent operation records and transactional storage belong to the injected
store; host integrations must prove them under duplicate and unknown outcomes.

## Eligibility and matchmaking

Eligibility is a trusted, expiring host decision covering capability, guardian
restrictions and mutual blocks. Missing, expired or unavailable decisions deny
admission. Private invitations do not override any of these checks. Join and
reconnect re-evaluate the host policy; transport possession alone is insufficient.
Persist only opaque subject partitions, and publish only game player slots/aliases.

Matching uses exact game/mode/version/difficulty/assistance partitions, bounded
latency and skill windows, queue capacity and ticket expiry. Every proposed pair
must pass mutual block/eligibility checks before atomic ticket consumption and
room creation. A pure bounded matching plan cannot itself confer a reservation
or claim distributed atomicity. Hosts use the returned ticket revisions in one
transaction; stale plans fail rather than double-admitting a player.

## Authority and transport

The authoritative service supplies a released runtime adapter. Clients send
bounded ordered intentions, never authoritative state. The adapter binds the
authenticated member slot before passing commands to runtime validation. Duplicate,
stale, foreign-generation and future-window commands are rejected before stepping.
Use the runtime's actual fixed tick/overload outcomes; do not hide discarded time
or claim capacity from a configuration value. Qualifying 100 simultaneous players
in UK South remains an integration/load-test gate, not a library default promise.

Transport frames have bounded message size and queues, explicit sequence/ack
handling, deadlines and cancellation. Only preset signals are admitted. The Azure
Web PubSub entry point must implement its documented protocol/SDK boundary with
timeouts and backpressure; no generic client publish permission grants authority.
The host issues expiring scoped access and routes messages through its account
and room checks. Provider failures never cause fail-open admission or automatic
unbounded retries. Only server-authored, transactionally committed results can
feed the separate ranking/progress contract in Task #2.

## Tests before implementation

- Strict bounded schemas, stable versions, public/private field separation and
  rejection of forged score/state fields.
- Waiting/active/finished/abandoned transitions, full rooms, duplicate membership,
  connection replacement, reconnect expiry, explicit leave and stale authority.
- Expired/denied/unavailable eligibility, guardian restrictions, mutual blocks,
  invitation bypass attempts and account isolation.
- Matching partition separation, skill/latency bounds, queue overflow/expiry,
  deterministic fair selection and stale ticket revisions.
- Runtime delegation, duplicate/reordered/future intent, authority isolation,
  overload, transport backpressure, timeout, disposal and late callbacks.
- Provider protocol contracts and separate import boundaries; actual cloud
  qualification remains visible and is never substituted with mocked evidence.
- Tests and >=80% coverage including every changed source in LCOV; types, lint,
  builds, exact public tarball, dual-module consumers, dependency/security audit,
  reviewed CI and approved main CD before claiming a released package.

README, Unreleased, ADRs, TDRs and operator/host contracts accompany implementation.
Rollback disables admission through stored controls while preserving room/results
and saves according to host retention policy. No product exposure or completed
gameplay qualification is claimed by contract preparation.


## Local validation — 16 November 2026

Before source implementation, room, matching, wire, authority and provider tests
failed for missing APIs. A greedy matching counterexample failed before bounded
backtracking was added. Packed-entry tests failed before the copied runtime
export policy was corrected. Provider-tool tests failed before safe CLI import
boundaries and redacted diagnostics were implemented.

Current validation: 95 Vitest tests plus 24 Node privacy tests pass. Types, lint,
build, exact 15-path package verification and full dependency audit (zero known
vulnerabilities) pass. Combined LCOV includes all 12 source/tooling files:
1,043/1,099 lines (94.90%), 733/772 branches (94.95%), 169/172 functions (98.26%).
Vitest statement coverage is 96.37%; Node privacy coverage independently meets
all configured 80% gates. No threshold or required test was removed.

The clean packed consumer executes ESM/CJS imports and real game-runtime input
validation, replay/future bounds, public projections, connection replacement and
overload behavior. NodeNext .mts/.cts consumers typecheck. Runtime is supplied
from its prepared test tarball only for isolated verification, never linked into
production while its registration is pending. The core bundle contains no Azure
protocol implementation.

The tracked native-browser fixture uses the packed Azure entry with Playwright
intercepting the synthetic provider endpoint. Connection confirmation, upstream
intent/ack, duplicate/old-epoch suppression, new-epoch delivery and cancellation
passed in Chromium on macOS. This is protocol evidence, not an Azure connection,
load test, cloud-outage exercise or live game qualification. The only initial
console entry was a missing local favicon; the fixture now uses an inline icon.

Open gates: reviewed pushed CI, approved main CD/first registration and permanent
OIDC; host authentication/atomic persistence/leases; real Azure deployment,
100-player UK South/cost/outage qualification; safe-block recipient fanout;
server-authored ranking/results Task #2; and the site/all-game launch barrier.
Site #2519 remains with its existing owner. No game, production infrastructure,
credential or rollout is created by this package implementation.
