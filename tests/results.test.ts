import { describe, expect, it, vi } from "vitest";
import { createAuthority, createRoom, joinRoom, startRoom, leaveMember, transferAuthority,
  parseGameResult, serializeGameResult, classifyResultReplay, createAbandonedResult,
  rankingPartition, parseRankingPartition, serializeRankingPartition, projectRankingEntries, summarizeGameResult, type AuthorityResults } from "../src/index.js";

const partition = { gameId: "vector-volley", modeId: "duel", rulesVersion: "1.0.0", contentVersion: "1.0.0", difficulty: "standard", assistance: ["slow-motion", "aim-guide"] };
const metric = { id: "points", order: "descending" as const };
const roomFixture = () => {
  let room = createRoom({ ...partition, roomId: "run-a", visibility: "private", capacity: 2, minimumPlayers: 2, createdAt: 1000, expiresAt: 100_000 });
  for (const id of ["a", "b"]) room = joinRoom(room, { subject: `subject-${id}`, connectionId: `connection-${id}`, alias: `pilot-${id}` },
    { type: "gameAdmission", version: "1.0.0", roomId: room.roomId, revision: room.revision, subject: `subject-${id}`, allowed: true, expiresAt: 2000 },
    { revision: room.revision, epoch: room.epoch, now: 1000 }).room;
  return startRoom(room, { revision: room.revision, epoch: room.epoch, now: 1000 }).room;
};
const resultFixture = () => ({ type: "gameResult", version: "1.0.0", ...partition, roomId: "run-a", roomRevision: 4, epoch: 1,
  status: "completed", endedAt: 1100, finalTick: 5, metric,
  players: [{ playerId: "p1", alias: "pilot-a", outcome: "finished", value: 10, rankingEligible: true },
    { playerId: "p2", alias: "pilot-b", outcome: "forfeited", rankingEligible: false }] });
const outcome = () => ({ type: "gameOutcome", version: "1.0.0", players: [
  { playerId: "p1", outcome: "finished", value: 10 }, { playerId: "p2", outcome: "forfeited" },
] });
const setup = (changes: Record<string, unknown> = {}) => {
  const room = roomFixture(); let now = 1100;
  const runtime = { enqueue: vi.fn(() => "accepted"), advance: vi.fn(() => ({ steps: 1, discardedMs: 0, alpha: 0, presentationFailed: false })),
    snapshot: vi.fn(() => ({ tick: 5, state: { score: 10, privateSeed: 99 } })), status: vi.fn(() => "running"), pause: vi.fn(), dispose: vi.fn() };
  const evaluate = vi.fn<AuthorityResults<{ score: number; privateSeed: number }>["evaluate"]>(() => outcome());
  const eligible = vi.fn((): unknown => true);
  const session = createAuthority({ room, lease: { roomId: room.roomId, epoch: 1, expiresAt: 2000 }, clock: () => now, enabled: () => true,
    runtime, parseInput: (raw: any) => raw, projectState: () => "{}", results: { metric, evaluate, eligible }, ...changes });
  return { session, runtime, room, evaluate, eligible, time: (value: number) => { now = value; } };
};

describe("strict authoritative result and partition contracts", () => {
  it("canonically normalizes equivalent results and distinguishes replay from conflict", () => {
    const input = resultFixture(); const parsed = parseGameResult(JSON.stringify(input));
    expect(parsed.assistance).toEqual(["aim-guide", "slow-motion"]);
    const reordered = { ...input, assistance: [...input.assistance].reverse(), players: [...input.players].reverse() };
    expect(serializeGameResult(reordered)).toBe(serializeGameResult(input));
    expect(classifyResultReplay(null, input)).toBe("new");
    expect(classifyResultReplay(reordered, input)).toBe("identical");
    for (const change of [{ epoch: 2 }, { roomId: "other" }, { endedAt: 1101 }, { metric: { ...metric, order: "ascending" } },
      { players: input.players.map(p => p.playerId === "p1" ? { ...p, value: 11 } : p) }]) expect(classifyResultReplay(input, { ...input, ...change })).toBe("conflict");
    expect(() => classifyResultReplay({ ...input, version: "2.0.0" }, input)).toThrow();
    expect(() => classifyResultReplay(undefined, input)).toThrow();
    parsed.players[0]!.alias = "changed"; expect(input.players[0]!.alias).toBe("pilot-a");
  });

  it("rejects malformed, future, oversized and inconsistent durable records", () => {
    const base = resultFixture();
    for (const change of [{ version: "2.0.0" }, { type: undefined }, { type: null }, { type: 0 }, { version: undefined }, { roomRevision: 0 }, { epoch: 0 }, { finalTick: 0 },
      { finalTick: undefined }, { endedAt: NaN }, { score: 999 }, { subject: "private" }, { assistance: ["same", "same"] },
      { players: [] }, { players: [base.players[0], base.players[0]] }, { players: [{ ...base.players[0], playerId: "p5" }] },
      { players: [{ ...base.players[0], value: undefined }] }, { players: [{ ...base.players[0], value: Infinity }] },
      { players: [{ ...base.players[1], value: 10 }] }, { players: [{ ...base.players[1], rankingEligible: true }] },
      { metric: { id: "../escape", order: "descending" } }, { metric: { ...metric, order: "custom" } },
      { status: "abandoned" }]) expect(() => parseGameResult({ ...base, ...change }), Object.keys(change).join(",")).toThrow();
    for (const raw of ["{", "x".repeat(16_385), "\"" + "é".repeat(9000) + "\"", false, null, [], 4]) expect(() => parseGameResult(raw)).toThrow();
  });

  it("keeps every gameplay/metric partition distinct and rejects foreign partition metadata", () => {
    const base = resultFixture(); const key = serializeRankingPartition(rankingPartition(base));
    expect(parseRankingPartition(JSON.stringify(rankingPartition(base)))).toEqual(rankingPartition(base));
    expect(serializeRankingPartition({ ...rankingPartition(base), assistance: [...base.assistance].reverse() })).toBe(key);
    for (const change of [{ gameId: "prism-breaker" }, { modeId: "co-op" }, { rulesVersion: "1.1.0" }, { contentVersion: "1.1.0" },
      { difficulty: "hard" }, { assistance: [] }, { metric: { ...metric, id: "time-ms" } }, { metric: { ...metric, order: "ascending" } }]) {
      expect(serializeRankingPartition(rankingPartition({ ...base, ...change }))).not.toBe(key);
    }
    for (const change of [{ version: "2.0.0" }, { subject: "private" }, { assistance: ["same", "same"] }, { metric: null }]) {
      expect(() => parseRankingPartition({ ...rankingPartition(base), ...change })).toThrow();
    }
  });

  it("projects only eligible finished players and emits count-only aggregate telemetry", () => {
    const base = resultFixture(); const entries = projectRankingEntries(base);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "gameRankingEntry", version: "1.0.0", roomId: "run-a", playerId: "p1", alias: "pilot-a", value: 10, endedAt: 1100 });
    expect(entries[0]!.partition).toEqual(rankingPartition(base));
    expect(summarizeGameResult(base)).toEqual({ gameId: "vector-volley", modeId: "duel", status: "completed", players: 2, finished: 1, forfeited: 1, abandoned: 0, ranked: 1 });
    const telemetry = JSON.stringify(summarizeGameResult(base));
    for (const secret of ["run-a", "pilot-a", "playerId", "value", "subject", "connection"]) expect(telemetry).not.toContain(secret);
    expect(projectRankingEntries({ ...base, players: base.players.map(p => ({ ...p, rankingEligible: false })) })).toEqual([]);
  });

  it("records abandonment without inventing scores, ticks or ranking eligibility", () => {
    let room = roomFixture();
    for (const id of ["a", "b"]) room = leaveMember(room, `subject-${id}`, `connection-${id}`, { revision: room.revision, epoch: room.epoch, now: 1200 }).room;
    const abandoned = createAbandonedResult(room);
    expect(abandoned.status).toBe("abandoned"); expect(abandoned).not.toHaveProperty("finalTick"); expect(abandoned).not.toHaveProperty("metric");
    expect(abandoned.players.every(p => p.outcome === "abandoned" && !p.rankingEligible && !("value" in p))).toBe(true);
    expect(projectRankingEntries(abandoned)).toEqual([]); expect(summarizeGameResult(abandoned).abandoned).toBe(2);
    expect(createAbandonedResult(room, 5).finalTick).toBe(5); expect(() => createAbandonedResult(room, -1)).toThrow();
    expect(() => createAbandonedResult(roomFixture())).toThrow();
    expect(() => rankingPartition(abandoned)).toThrow();
    expect(() => parseGameResult({ ...abandoned, metric })).toThrow();
    expect(() => parseGameResult({ ...abandoned, players: abandoned.players.map(p => ({ ...p, rankingEligible: true })) })).toThrow();
  });
});

describe("terminal runtime result preparation", () => {
  it("freezes exactly one detached result and room candidate, retaining identical unknown-outcome retry", () => {
    const { session, runtime, evaluate, eligible, room, time } = setup();
    expect((session.finalize as any)({ score: 9999 })).toBeNull();
    const prepared = session.finalize()!;
    expect(prepared).toMatchObject({ idempotencyKey: "run-a", expected: { roomId: "run-a", revision: room.revision, epoch: 1 }, notAfter: 2000,
      nextRoom: { state: "finished", revision: room.revision + 1 }, result: { status: "completed", endedAt: 1100, finalTick: 5 } });
    expect(prepared.result).toEqual(parseGameResult(resultFixture()));
    expect(evaluate).toHaveBeenCalledWith({ tick: 5, state: { score: 10, privateSeed: 99 } });
    expect(eligible).toHaveBeenCalledWith({ roomId: room.roomId, revision: room.revision, epoch: 1, playerId: "p1" });
    expect(eligible).toHaveBeenCalledOnce(); expect(runtime.pause).toHaveBeenCalledOnce();
    const saved = structuredClone(prepared);
    prepared.result.players[0]!.alias = "changed"; prepared.nextRoom.members[0]!.alias = "changed";
    time(3000); expect(session.finalize()).toEqual(saved); expect(evaluate).toHaveBeenCalledOnce();
    expect(session.advance(16).status).toBe("inactive"); expect(session.receive({}, {}).status).toBe("inactive");
    session.dispose(); expect(session.finalize()).toBeNull();
  });

  it("keeps nonterminal games running and denies finalization without live authority or configured rules", () => {
    const a = setup(); a.evaluate.mockReturnValue(null); expect(a.session.finalize()).toBeNull(); expect(a.runtime.pause).not.toHaveBeenCalled();
    const b = setup({ results: undefined }); expect(b.session.finalize()).toBeNull(); expect(b.session.status().state).toBe("active");
    const c = setup(); c.time(2000); expect(c.session.finalize()).toBeNull(); expect(c.evaluate).not.toHaveBeenCalled();
    const d = setup(); d.session.updateRoom(transferAuthority(d.room, { revision: d.room.revision, epoch: 1, now: 1100 }).room);
    expect(d.session.finalize()).toBeNull(); expect(d.evaluate).not.toHaveBeenCalled();
    const e = setup({ enabled: () => false }); expect(e.session.finalize()).toBeNull();
    const f = setup(); f.runtime.snapshot.mockReturnValue({ tick: 0, state: { score: 0, privateSeed: 0 } });
    expect(f.session.finalize()).toBeNull(); expect(f.runtime.pause).not.toHaveBeenCalled();
  });

  it("fails closed for forged outcomes and preserves original participants/generations", () => {
    for (const value of [{ ...outcome(), score: 999 }, { ...outcome(), version: "2.0.0" }, { ...outcome(), players: [] },
      { ...outcome(), players: [outcome().players[0]] }, { ...outcome(), players: [outcome().players[0], outcome().players[0]] },
      { ...outcome(), players: outcome().players.map(p => ({ ...p, rankingEligible: true })) },
      { ...outcome(), players: outcome().players.map(p => ({ ...p, playerId: "p3" })) }]) {
      const test = setup(); test.evaluate.mockReturnValue(value); expect(test.session.finalize()).toBeNull();
      expect(test.session.status().reason).toBe("projection");
    }
    const a = setup(); const changed = { ...a.room, revision: a.room.revision + 1, members: [a.room.members[0]] };
    expect(a.session.updateRoom(changed)).toBe(false);
    const b = setup(); const next = { ...b.room, revision: b.room.revision + 1, members: b.room.members.map(p => ({ ...p, generation: 2 })) };
    expect(b.session.updateRoom(next)).toBe(true);
    expect(b.session.updateRoom({ ...b.room, revision: next.revision + 1 })).toBe(false);
    const c = setup(); const left = leaveMember(c.room, "subject-a", "connection-a", { revision: c.room.revision, epoch: 1, now: 1100 }).room;
    expect(c.session.updateRoom(left)).toBe(true); expect(c.session.finalize()).toBeNull();
  });

  it("denies unavailable rank policy and safely handles reentrant/async/failing evaluation", async () => {
    for (const decision of [false, undefined, "true", Promise.reject(new Error("synthetic policy error"))]) {
      const test = setup(); test.eligible.mockReturnValue(decision);
      expect(test.session.finalize()?.result.players[0]?.rankingEligible).toBe(false);
    }
    const a = setup(); a.eligible.mockImplementation(() => { throw new Error("private detail"); });
    expect(projectRankingEntries(a.session.finalize()!.result)).toEqual([]);
    const b = setup(); b.evaluate.mockImplementation(() => { expect(b.session.finalize()).toBeNull(); b.session.dispose(); return outcome(); });
    expect(b.session.finalize()).toBeNull();
    const c = setup(); c.evaluate.mockImplementation(() => { throw new Error("private detail"); });
    expect(c.session.finalize()).toBeNull(); expect(c.session.status().reason).toBe("projection");
    const d = setup(); d.evaluate.mockReturnValue(Promise.reject(new Error("private detail")));
    expect(d.session.finalize()).toBeNull(); expect(d.session.status().reason).toBe("projection");
    await Promise.resolve();
  });

  it("keeps the runtime tick and denies late or cancelled result callbacks", () => {
    const a = setup();
    a.evaluate.mockImplementation((snapshot: any) => { snapshot.tick = 999; return outcome(); });
    expect(a.session.finalize()?.result.finalTick).toBe(5);
    const b = setup(); b.eligible.mockImplementation(() => { b.time(2000); return true; });
    expect(b.session.finalize()).toBeNull(); expect(b.session.status().reason).toBe("lease-expired");
    const c = setup(); c.eligible.mockImplementation(() => { c.session.dispose(); return true; });
    expect(c.session.finalize()).toBeNull(); expect(c.session.status().state).toBe("disposed");
    const d = setup(); d.runtime.pause.mockImplementation(() => { d.session.dispose(); });
    expect(d.session.finalize()).toBeNull(); expect(d.session.finalize()).toBeNull();
    for (const results of [{ metric, evaluate: null }, { metric, evaluate: () => outcome(), eligible: true },
      { metric: { ...metric, order: "unknown" }, evaluate: () => outcome() }]) expect(() => setup({ results })).toThrow();
    const e = setup({ results: { metric, evaluate: () => outcome() } });
    expect(projectRankingEntries(e.session.finalize()!.result)).toEqual([]);
  });

  it("cannot resurrect departed slots, alter their alias or replace connections without advancing generation", () => {
    for (const change of [{ connectionId: "replacement" }, { alias: "new-alias" }]) {
      const test = setup();
      const next = { ...test.room, revision: test.room.revision + 1, members: test.room.members.map((p, i) => i === 0 ? { ...p, ...change } : p) };
      expect(test.session.updateRoom(next)).toBe(false);
    }
    const test = setup();
    const left = leaveMember(test.room, "subject-a", "connection-a", { revision: test.room.revision, epoch: 1, now: 1100 }).room;
    expect(test.session.updateRoom(left)).toBe(true);
    expect(test.session.updateRoom({ ...test.room, revision: left.revision + 1 })).toBe(false);
  });
});
