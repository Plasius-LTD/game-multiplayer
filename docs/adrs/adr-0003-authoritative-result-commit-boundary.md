# ADR 0003: Runtime result candidates and atomic host commitment

Status: accepted for implementation. Date: 16 November 2026. Task #2,
site Story #2420 / Feature #2388. Flag `arcade.rankings.enabled` and capability
`arcade.rankings.submit` remain disabled; no rollout is part of this change.

Game rules evaluate the actual authoritative runtime snapshot. A parameterless
finalization method validates every original slot and derives a completed result
and finished room candidate under the live authority lease. Ranking eligibility
comes from a separate trusted host policy, never client input or game outcome.
The runtime pauses once a candidate exists; retries return exactly that candidate.
Disposed authorities no longer return it. Completed results require a positive
tick; abandoned records can omit an unknown tick and contain no metric or score.

Keep persistence outside this library. Existing graph contracts and the graph
write coordinator own write commands, queues, timeouts and commit handlers. The
host must atomically compare the expected room revision/epoch and persisted live
ownership, and commit room/result/outbox in one primary partition. An identical
already committed result resolves an uncertain response even after the original
deadline; a conflicting result cannot replace it. New writes after the deadline
are rejected. Downstream subject-progress and ranking writes are idempotent
projections, not a cross-partition transaction.

Strict versioned schema records and canonical partition/equality forms provide
reusable validation. They confer no authority by themselves. Public ranking
projections still require current visibility, guardian and consent decisions in
the host. Count-only telemetry excludes player/room/account identifiers and scores.
Logical partition strings do not promise compatibility with provider key limits.

This boundary avoids client-selected results, divergent retries and a second
persistence framework. It requires integration tests for real atomic races,
lease loss and provider outages in the site before production qualification.
The package's unit and packed-consumer checks cannot establish those guarantees.
