# Authoritative results and ranking partitions

Work: game-multiplayer #2, site Story #2420, Feature #2388, Epic #2382.
Inherited stored flag: `arcade.rankings.enabled`; submission also requires
`arcade.rankings.submit`. Live connector readback on 16 November 2026 confirms
rankings, multiplayer and public launch disabled at zero rollout. The full
catalogue launch barrier remains required. No rollout is part of this work.

## Existing package assessment

Reuse released Plasius schema for strict versioned records and the existing
multiplayer authority for room/lease/connection fencing. Game-runtime retains
simulation and state/input/checkpoint semantics. Graph contracts and the graph
write coordinator already own write command, queue, timeout and commit-handler
orchestration: do not duplicate a store, queue or async retry layer here. The
site must use an atomic commit handler for the room/result/outbox primary
partition, then idempotent subject-progress and leaderboard projections.
Player-system's pp/esp/tis/dis ledgers and economy currency transactions do not
own arcade match completion, metric partitions or server-run results.

## Result production and authority

Add optional game-owned result evaluation to createAuthority. A parameterless
finalize operation reads the actual runtime snapshot under its existing live
lease/rollout checks. The evaluator returns null until terminal, or a strict
versioned outcome for every pinned member slot. Client frames never carry scores,
completion or ownership. Reject malformed/foreign/duplicate/missing slots and
finished outcomes for members already marked left. Rank eligibility is a separate
trusted synchronous host policy callback, never a field chosen by game outcome
or client input. Missing/async/throwing policy denies ranking for that player.

Successful preparation pauses the runtime and preserves exactly one detached
candidate: next finished room, result, expected prior revision/epoch, stable
room-derived idempotency key and the ownership deadline. Repeated finalization
returns identical evidence, including after an uncertain external commit; it
cannot invent a new outcome, timestamp, score or key. Dispose clears the pending
candidate. Host commitment must atomically compare revision/epoch and lease
expiry, persist room/result/outbox together, and treat an identical already
committed result as idempotent success. A stale/conflicting candidate cannot
replace an existing result. No pure parser or candidate acquires authority.

Existing committed abandoned rooms can produce explicit unranked abandonment
records. No invented score or completion tick substitutes for a missing runtime
checkpoint; a final tick is optional only for abandonment. Completed results
require a real positive runtime tick. Prepared completion cannot continue stepping
or accept new intentions. Active committed roster updates preserve original
slots/subjects and nondecreasing connection generations for result integrity.

## Records and projections

Bound results to 16 KiB UTF-8 and at most four player slots. Use opaque room IDs,
generated aliases, safe-integer metric values and strict type/version contracts.
Completed/forfeited/abandoned player outcomes are explicit; only eligible finished
players in a completed result yield ranking entries. Abandonment has no metric
or score. Future or malformed durable records remain errors, never overwritten.

Partition by exact game, mode, rules/content version, difficulty, sorted unique
assistance and metric ID/order. Canonical serialization is an equality boundary,
not a claim that its string fits a provider's storage-key constraints. Hosts map
logical keys through their existing adapters. Canonical result equality supports
new/identical/conflicting replay classification inside the host transaction.
Public ranking projections retain generated aliases, slots and opaque result
references; fresh host visibility/guardian/consent policy is still required.
Aggregate telemetry is an explicit count-only whitelist without room/subject,
connection, alias, score or credential fields.

## Requirement-derived tests before implementation

- Strict completed/abandoned schemas, byte bounds, future versions, forged
  ranking grants, duplicate/foreign/missing slots and invalid cross-field states.
- Exact compatibility partitions including assistance order and metric semantics;
  canonical replay equality, conflicts and malformed/future existing records.
- Real runtime delegation, terminal-only/no-argument finalization, lease/epoch and
  rollout denial, frozen simulation, identical retry after lost response, mutation
  isolation, disposal and callback reentrancy/failure.
- Fresh host rank policy denial, exceptions and unsupported async decisions;
  forfeits/abandonment never rank; account/private fields never enter projections
  or aggregate telemetry; stale roster generations cannot rewrite participants.
- All changed source in combined LCOV and unchanged >=80% gates; types, lint,
  builds, exact tarball/dual consumers, documentation, pushed/source/main CI and
  approved main CD before claiming released contracts.

First registration remains pending the reviewed operator route. No production
workspace link, local publication, Azure infrastructure or client score endpoint
is introduced. Real storage races, provider outages and UK South 100-player
qualification remain site integration gates, not claims from library tests.

## Local validation — 16 November 2026

107 Vitest tests and 24 Node privacy tests pass. Combined LCOV covers all thirteen
source/tooling files: 1,152/1,208 lines (95.36%), 858/900 branches (95.33%) and
205/208 functions (98.56%). Vitest statements are 96.78%; the result module has
100% lines. Unchanged 80% gates pass. Types, lint, build, exact fifteen-path
tarball policy and full dependency audit (zero vulnerabilities) pass.

The isolated tarball consumer runs `tests/consumer/authority.mjs` and
`tests/consumer/results.mjs` against the actual prepared runtime tarball. Both
ESM/CJS integrations pass, including real terminal ticks, paused simulation,
canonical retry/conflict, partitions and disposal. Copy
`tests/consumer/results.mts.fixture` into that consumer as `.mts` and `.cts` and
check with strict NodeNext TypeScript; both declaration consumers pass without
skipping library checks. The fixture is not a production workspace dependency.
Source/main CI and approved registration/CD are separate delivery gates.
