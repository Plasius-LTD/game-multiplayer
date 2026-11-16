# ADR 0001: Authoritative session boundaries

Status: accepted for implementation. Date: 16 November 2026.
Task #1 / site Story #2419 / Feature #2387 / Epic #2382.

Create a provider-neutral package using the schema baseline and released
`@plasius/schema`. Keep authentication, capabilities, account/guardian eligibility,
blocks, quota middleware and persistence in their existing owning packages/host.
Game-runtime retains deterministic rules, fixed ticks and input validation via
an injected authority interface. A client cannot select an authority epoch,
authenticate itself through a descriptor or write authoritative results.

Use detached validated room transition candidates and explicit revision/fencing
checks. The host must commit with atomic comparison before success. Binding an
eligibility decision to the exact room revision prevents a concurrent join from
silently bypassing mutual-block checks. Transport reconnection replaces a
member's connection generation; stale connections lose command admission.

Matching returns bounded compatible plans with ticket revisions; it does not
pretend that an in-memory plan performs a distributed reservation. The host
transactionally consumes tickets and creates the room. Provider adapters remain
separate lazy entries. Actual cloud capacity and restart recovery require
integration evidence before production exposure.

The site evaluates stored `arcade.multiplayer.enabled` plus private/public
capabilities and the public launch barrier. No local override is introduced.
Rollback denies new admission while retaining results and saved progress.
Only approved main `cd.yml`/production may publish; first registration remains
operator-gated. No private data is included in public npm artifacts.
