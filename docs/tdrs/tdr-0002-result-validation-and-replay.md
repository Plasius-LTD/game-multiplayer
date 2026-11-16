# TDR 0002: Result validation, partitioning and uncertain outcomes

Task #2. Result envelopes and ranking partitions require explicit string type and
version metadata. Schema configuration may default its identity metadata, so the
wire boundary checks supplied strings before using the released schema package.
Unknown fields/versions, non-finite or unsafe integer values, duplicate slots or
assistance, missing/foreign slots and inconsistent outcome fields fail closed.
Four slots and 16 KiB UTF-8 bound records; completed ticks must be positive.

Canonicalization sorts assistance and player slots and reconstructs an explicit
whitelist. Ranking partitions include game, mode, rules/content version,
difficulty, assistance and metric ID/order. Every different gameplay/metric
meaning remains separate. Reordered equivalent records compare identically.
Only confirmed absence (`null`) permits a new result; undefined, malformed or
future existing records remain errors. The host maps logical partition fields
through its storage adapter rather than using an unbounded provider key.

Finalization has no caller payload. Game evaluation reads a runtime snapshot
inside the authority's exclusive operation. Capture its tick before evaluation,
recheck lease/runtime/rollout after callbacks, and reject unsupported async
evaluation. Async/throwing/missing rank policy denies that slot. Reentrant calls
cannot step or finalize; disposal takes effect before cleanup. Candidate
preparation pauses the runtime and snapshots the exact result/room/expected
revision/epoch/deadline. Retry clones cannot mutate that internal evidence.

Original subjects, slots and generated aliases remain pinned across committed
room updates. Departed slots cannot reappear, generations cannot decrease and
connection changes require a higher generation. A game outcome may forfeit an
allocated slot but cannot finish a departed one. An abandoned room yields an
explicit unranked record and does not fabricate an unknown final tick.

The host persists a primary room/result/outbox atomically using the existing
graph commit handler. On an uncertain response, reconcile the identical result
before checking the original deadline; only a still-absent write requires live
ownership and compare-and-swap. Downstream projections deduplicate by the stable
room result and player slot. Fresh public policy governs ranking disclosure.
Rollback disables new ranking admission while preserving committed results and
outbox evidence; no environment override or deletion of saves is introduced.

Tests cover canonical replay/conflict, forged/bounded/future records, terminal
evaluation, stale ownership/roster, cancellation/reentrancy, explicit policy
denial, private-field exclusion and the actual packed runtime consumer. Real
cloud races, capacity, outages and cost remain separate site qualification gates.
