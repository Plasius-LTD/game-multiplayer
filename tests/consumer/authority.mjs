import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createRoom, joinRoom, startRoom, disconnectMember, reconnectMember, createAuthority } from "@plasius/game-multiplayer";
import { createGameRuntime, parseInput, serializeState } from "@plasius/game-runtime";
const require = createRequire(import.meta.url);
const cjs = require("@plasius/game-multiplayer");
assert.equal(typeof cjs.createAuthority, "function");
assert.equal(typeof require("@plasius/game-multiplayer/azure-web-pubsub").connectWebPubSub, "function");
const azure = await import("@plasius/game-multiplayer/azure-web-pubsub");
assert.equal(typeof azure.connectWebPubSub, "function");
assert.equal(readFileSync(new URL(import.meta.resolve("@plasius/game-multiplayer")), "utf8").includes("json.webpubsub.azure.v1"), false);
let now = 1000;
const partition = { gameId: "vector-volley", modeId: "duel", rulesVersion: "1.0.0", contentVersion: "1.0.0", difficulty: "standard", assistance: [] };
let room = createRoom({ ...partition, roomId: "room-fixture", visibility: "private", capacity: 2, minimumPlayers: 2, createdAt: now, expiresAt: 100_000 });
const context = () => ({ revision: room.revision, epoch: room.epoch, now });
const admission = subject => ({ type: "gameAdmission", version: "1.0.0", roomId: room.roomId, revision: room.revision, subject, allowed: true, expiresAt: now + 1000 });
const binding = { subject: "synthetic-a", connectionId: "connection-a" };
for (const id of ["a", "b"]) room = joinRoom(room, { subject: `synthetic-${id}`, connectionId: `connection-${id}`, alias: `pilot-${id}` }, admission(`synthetic-${id}`), context()).room;
room = startRoom(room, context()).room;
assert.deepEqual(cjs.parseRoom(room), room);
const runtime = createGameRuntime({ gameId: partition.gameId, rulesVersion: partition.rulesVersion, contentVersion: partition.contentVersion,
  initialState: () => ({ position: 0, hiddenSeed: 7 }),
  parseState: value => { assert.equal(typeof value.position, "number"); return value; },
  step: (state, context) => ({ ...state, position: state.position + context.inputs.reduce((sum, input) => sum + input.axes.x, 0) }),
}, { seed: 1234, players: ["p1", "p2"] });
const authority = createAuthority({ room, lease: { roomId: room.roomId, epoch: room.epoch, expiresAt: 2000 }, runtime,
  clock: () => now, enabled: () => true, parseInput,
  projectState: snapshot => serializeState({ position: snapshot.state.position }),
});
const intention = (changes = {}) => ({ type: "gameInput", version: "1.0.0", tick: 1, sequence: 1, playerId: "p1", axes: { x: 1, y: 0, z: 0 }, buttons: 0, ...changes });
const frame = (input, generation = 1) => ({ type: "gameClientFrame", version: "1.0.0", roomId: room.roomId, generation, kind: "intent", intentJson: JSON.stringify(input) });
assert.equal(authority.receive(binding, frame(intention())).status, "accepted");
assert.equal(authority.receive(binding, frame(intention())).status, "rejected");
assert.equal(authority.receive(binding, frame(intention({ playerId: "p2" }))).status, "denied");
assert.equal(authority.receive(binding, frame(intention({ tick: 1000, sequence: 2 }))).status, "rejected");
assert.equal(authority.receive(binding, frame(intention({ score: 9000 }))).status, "invalid");
assert.equal(authority.advance(1000 / 60).status, "advanced");
assert.deepEqual(JSON.parse(authority.snapshot(binding).stateJson), { position: 1 });
assert.equal(authority.receive(binding, frame(intention())).status, "rejected");
now = 1100;
room = disconnectMember(room, binding.subject, binding.connectionId, 500, context()).room;
assert.equal(authority.updateRoom(room), true);
assert.equal(authority.receive(binding, frame(intention({ tick: 2, sequence: 2 }))).status, "denied");
room = reconnectMember(room, { ...binding, connectionId: "replacement", alias: "pilot-a" }, admission(binding.subject), context()).room;
assert.equal(authority.updateRoom(room), true);
assert.equal(authority.receive({ ...binding, connectionId: "replacement" }, frame(intention({ tick: 2, sequence: 2 }), 2)).status, "accepted");
assert.equal(authority.receive(binding, frame(intention({ tick: 3, sequence: 3 }))).status, "denied");
const overload = authority.advance(100);
assert.equal(overload.status, "stopped"); assert.ok(overload.discardedMs > 0);
assert.equal(authority.status().rankingEligible, false);
authority.dispose(); assert.equal(runtime.status(), "disposed");
console.log("Packed ESM/CJS integration passed: runtime intent validation, replay/future bounds, recipient projection, reconnect fencing and overload.");
