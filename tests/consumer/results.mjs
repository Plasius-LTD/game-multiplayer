import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createRoom, joinRoom, startRoom, createAuthority, parseGameResult, classifyResultReplay,
  serializeGameResult, rankingPartition, serializeRankingPartition, projectRankingEntries, summarizeGameResult } from "@plasius/game-multiplayer";
import { createGameRuntime, parseInput, serializeState } from "@plasius/game-runtime";
const cjs = createRequire(import.meta.url)("@plasius/game-multiplayer");
let now = 1000;
const partition = { gameId: "vector-volley", modeId: "duel", rulesVersion: "1.0.0", contentVersion: "1.0.0", difficulty: "standard", assistance: [] };
let room = createRoom({ ...partition, roomId: "terminal-fixture", visibility: "private", capacity: 2, minimumPlayers: 2, createdAt: now, expiresAt: 100_000 });
for (const id of ["a", "b"]) room = joinRoom(room, { subject: `synthetic-${id}`, connectionId: `connection-${id}`, alias: `pilot-${id}` },
  { type: "gameAdmission", version: "1.0.0", roomId: room.roomId, revision: room.revision, subject: `synthetic-${id}`, allowed: true, expiresAt: 2000 },
  { revision: room.revision, epoch: room.epoch, now }).room;
room = startRoom(room, { revision: room.revision, epoch: room.epoch, now }).room;
const runtime = createGameRuntime({ gameId: partition.gameId, rulesVersion: partition.rulesVersion, contentVersion: partition.contentVersion,
  initialState: () => ({ count: 0, hiddenSeed: 7 }),
  parseState: value => { assert.equal(typeof value.count, "number"); return value; },
  step: state => ({ ...state, count: state.count + 1 }),
}, { seed: 1234, players: ["p1", "p2"] });
const authority = createAuthority({ room, lease: { roomId: room.roomId, epoch: room.epoch, expiresAt: 2000 }, runtime,
  clock: () => now, enabled: () => true, parseInput, projectState: snapshot => serializeState({ count: snapshot.state.count }),
  results: { metric: { id: "points", order: "descending" },
    evaluate: snapshot => snapshot.state.count < 2 ? null : { type: "gameOutcome", version: "1.0.0", players: [
      { playerId: "p1", outcome: "finished", value: snapshot.state.count }, { playerId: "p2", outcome: "forfeited" },
    ] }, eligible: context => context.playerId === "p1",
  },
});
assert.equal(authority.finalize(), null);
assert.equal(authority.advance(1000 / 60).status, "advanced"); assert.equal(authority.finalize(), null);
assert.equal(authority.advance(1000 / 60).status, "advanced");
const candidate = authority.finalize();
assert.equal(runtime.status(), "paused");
assert.equal(candidate.result.finalTick, 2); assert.equal(candidate.result.players[0].value, 2);
assert.equal(candidate.nextRoom.revision, room.revision + 1); assert.equal(candidate.nextRoom.state, "finished");
assert.deepEqual(parseGameResult(candidate.result), cjs.parseGameResult(candidate.result));
assert.equal(classifyResultReplay(null, candidate.result), "new");
assert.equal(cjs.classifyResultReplay(JSON.parse(serializeGameResult(candidate.result)), candidate.result), "identical");
assert.equal(classifyResultReplay({ ...candidate.result, endedAt: 1001 }, candidate.result), "conflict");
const ranking = projectRankingEntries(candidate.result);
assert.equal(ranking.length, 1); assert.equal(ranking[0].value, 2);
assert.equal(serializeRankingPartition(rankingPartition(candidate.result)), cjs.serializeRankingPartition(ranking[0].partition));
assert.deepEqual(Object.keys(summarizeGameResult(candidate.result)).sort(), ["abandoned", "finished", "forfeited", "gameId", "modeId", "players", "ranked", "status"]);
const canonical = structuredClone(candidate);
candidate.result.players[0].value = 999;
now = 3000; assert.deepEqual(authority.finalize(), canonical);
assert.equal(authority.advance(1000 / 60).status, "inactive"); assert.equal(runtime.snapshot().tick, 2);
authority.dispose(); assert.equal(authority.finalize(), null); assert.equal(runtime.status(), "disposed");
console.log("Packed ESM/CJS results passed: actual terminal runtime, paused simulation, partitioned ranking, canonical retry/conflict and disposal.");
