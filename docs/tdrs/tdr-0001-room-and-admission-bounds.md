# TDR 0001: Room and admission bounds

Task #1. Account, room, connection and ticket identities are opaque bounded ASCII
tokens. Room/player limits are explicit, at most four slots per room. Public
descriptors omit subjects, connection identities and host admission evidence.
Only generated aliases and fixed communication signals cross the public path.

Room mutations compare a safe-integer revision and authority epoch, increment
the revision once per actual transition, and reject overflow. A reconnect keeps
the same player slot, increments its connection generation, and replaces the
connection identity. Old connections cannot disconnect or command their
replacement. Reconnect deadlines never extend beyond room expiry. Finished or
abandoned rooms cannot be restarted or accept new players.

Trusted admission decisions expire within one minute and bind the subject,
room ID and room revision. The host must obtain them from authenticated
capability/guardian/mutual-block evaluation, never from client JSON. Denied,
missing, malformed, expired or stale decisions fail closed. A private invitation
does not alter those checks.

Matching operates on at most 256 bounded validated tickets. Expired tickets are
ignored. Exact game/mode/rules/content/difficulty/assistance/region partitions,
skill and latency windows constrain deterministic oldest-feasible selection.
Every proposed peer pair requires an affirmative trusted policy result. The
returned revisions must be atomically consumed by the host; stale plans do not
confer admission. No unbounded queue, retry or history is stored in this core.

Runtime/transport adapters must preserve deadlines, abort, bounded queues,
fixed-tick/overload reporting and server authority. The 100-concurrent-player
UK South target remains a measured service qualification, not a configurable
library assertion.

Tickets last at most five minutes and public matching requires 2–4 players.
Bounded backtracking avoids greedy peer selection starving an older feasible
group. At 16,384 candidate steps the search throws `match-search-budget`.
Unsupported async policy fails the plan and consumes rejection; policy exceptions
deny affected pairs. Player-count constraints also partition matching.

Authority leases last at most 30 seconds, bounded by room expiry. Only newer
committed compatible rooms update membership. Higher epochs, expired leases,
clock reversal, disabled/unavailable policy, faults and discarded simulation time
stop admission. Reentrant calls cannot step/admit inside a host callback;
disposal takes effect before calling provider cleanup.

Client frames are limited to 4 KiB UTF-8 (intention JSON 2 KiB); server frames
64 KiB including escaping (projected JSON 48 KiB). Games explicitly omit secrets
and hidden state. Preset signals have per-player watermarks and 1-second cooldown;
hosts re-evaluate blocks before fanout.

Azure negotiation expires within 60 seconds at an exact public-Azure WSS
origin/hub. Defaults/maxima: handshake 5/10 seconds, ack 2.5/10 seconds, heartbeat
window 15/60 seconds, pending acks 32/64, buffered bytes 64/256 KiB. Pings run each
half-window; a missing pong closes the connection. No hidden send queue or
retry/reconnect is retained. Missing acks remain unconfirmed. Server-only room,
epoch and sequence checks precede bounded synchronous delivery callbacks.
