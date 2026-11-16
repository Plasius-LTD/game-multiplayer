# ADR 0002: Server-routed Azure events and native browser transport

Status: accepted for implementation. Date: 16 November 2026. Task #1.
Inherited flag: `arcade.multiplayer.enabled`; private/public capabilities and
public launch barrier remain host-owned and disabled.

Use native WebSocket behind the lazy `./azure-web-pubsub` entry. The root stays
free of browser/provider initialization. Plasius schema owns contract validation.
The documented JSON subprotocol supports upstream events without client group
permissions, so this bounded lifecycle does not need a third-party client SDK.

Clients send `arcade` events. The service authenticates transport context; the
host binds subject, connection and generation before runtime input validation.
Never grant client group roles. Receive only provider `from: server` frames with
the expected room and advancing epoch/sequence. Hosts use server-to-connection
delivery. This does not replace webhook authentication or room policy.

Connections have handshake/ack/heartbeat deadlines, bounded pending work and
native socket backpressure. Cancellation removes listeners/timers. Unknown send
outcomes remain unconfirmed; the application owns retry/reconnect after fresh
host negotiation. Errors expose fixed reasons, never URL, identity or payload.

Authority owns one runtime only while a trusted short lease and live policy
remain valid. Persisted fencing and atomic room/lease operations are host-owned;
a parsed descriptor cannot confer ownership. Games project public state explicitly.
Provider acknowledgements do not commit scores or progress.

Tradeoff: this adapter supports the public Azure endpoint form and event subset.
Other endpoint/protocol capabilities need separately reviewed contracts. Mock or
native-browser protocol checks cannot qualify Azure deployment/cost, cloud outage
recovery or 100 concurrent players in UK South. Those remain site launch gates.

Source: [Microsoft JSON Web PubSub protocol](https://learn.microsoft.com/en-us/azure/azure-web-pubsub/reference-json-webpubsub-subprotocol),
checked 16 November 2026.
