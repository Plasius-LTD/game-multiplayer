import { describe, expect, it, vi } from "vitest";
import { createAuthority, createRoom, joinRoom, startRoom, disconnectMember, reconnectMember, transferAuthority,
  leaveMember, finishRoom } from "../src/index.js";

const makeRoom = () => {
  let room = createRoom({ roomId: "room-a", gameId: "vector-volley", modeId: "duel", rulesVersion: "1.0.0", contentVersion: "1.0.0",
    difficulty: "standard", assistance: [], visibility: "private", capacity: 2, minimumPlayers: 2, createdAt: 1000, expiresAt: 100_000 });
  for (const id of ["a", "b"]) room = joinRoom(room, { subject: `account-${id}`, connectionId: `connection-${id}`, alias: `pilot-${id}` },
    { type: "gameAdmission", version: "1.0.0", roomId: room.roomId, revision: room.revision, subject: `account-${id}`, allowed: true, expiresAt: 2000 },
    { revision: room.revision, epoch: room.epoch, now: 1001 }).room;
  return startRoom(room, { revision: room.revision, epoch: room.epoch, now: 1001 }).room;
};
const frame = (changes: Record<string, unknown> = {}) => ({ type: "gameClientFrame", version: "1.0.0", roomId: "room-a", generation: 1,
  kind: "intent", intentJson: JSON.stringify({ playerId: "p1", tick: 1, sequence: 1 }), ...changes });
const binding = { subject: "account-a", connectionId: "connection-a" };
const setup = (overrides: Record<string, unknown> = {}) => {
  let now = 1100; const room = makeRoom();
  const runtime = { enqueue: vi.fn(() => "accepted"), advance: vi.fn(() => ({ steps: 1, discardedMs: 0, alpha: 0, presentationFailed: false })),
    status: vi.fn(() => "running"), snapshot: vi.fn(() => ({ tick: 1, state: { privateSeed: 5, position: 8 } })), pause: vi.fn(), dispose: vi.fn() };
  const parseInput = vi.fn((value: any) => { if (value.invalid) throw new Error("private error"); return value; });
  const projectState = vi.fn((snapshot: any, playerId: string) => JSON.stringify({ position: snapshot.state.position, playerId }));
  const options = { room, lease: { roomId: room.roomId, epoch: room.epoch, expiresAt: 2000 }, clock: () => now, enabled: () => true,
    runtime, parseInput, projectState, ...overrides };
  const session = createAuthority(options);
  return { session, runtime, room, parseInput, projectState, options, time: (value: number) => { now = value; } };
};
const ctx = (room: any, now = 1100) => ({ revision: room.revision, epoch: room.epoch, now });

describe("runtime-backed authoritative sessions", () => {
  it("binds validated intentions to the authenticated slot and delegates ordering/queue decisions", () => {
    const { session, runtime, parseInput } = setup();
    expect(session.receive(binding, frame())).toEqual({ status: "accepted" });
    expect(parseInput).toHaveBeenCalledWith({ playerId: "p1", tick: 1, sequence: 1 });
    expect(runtime.enqueue).toHaveBeenCalledWith({ playerId: "p1", tick: 1, sequence: 1 });
    for (const decision of ["replayed", "stale", "too-far-ahead", "order-conflict", "queue-full"]) {
      runtime.enqueue.mockReturnValue(decision); expect(session.receive(binding, frame())).toEqual({ status: "rejected" });
    }
    expect(session.receive(binding, frame({ intentJson: '{"playerId":"p2"}' })).status).toBe("denied");
    expect(session.receive(binding, frame({ intentJson: '{"invalid":true}' })).status).toBe("invalid");
    expect(session.receive(binding, frame({ score: 100 })).status).toBe("invalid");
    for (const [who, value] of [[{ ...binding, subject: "other" }, frame()], [binding, frame({ roomId: "other" })],
      [binding, frame({ generation: 2 })], [{ ...binding, connectionId: "old" }, frame()], [null, frame()]]) {
      expect(session.receive(who, value).status).toBe("denied");
    }
    expect(runtime.enqueue).toHaveBeenCalledTimes(6);
  });

  it("uses only game-projected state and returns no private room identities or simulation state", () => {
    const { session, projectState } = setup();
    expect(session.snapshot(binding)).toEqual({ type: "gameServerFrame", version: "1.0.0", roomId: "room-a", epoch: 1,
      sequence: 1, kind: "snapshot", tick: 1, stateJson: '{"position":8,"playerId":"p1"}' });
    expect(projectState).toHaveBeenCalledWith({ tick: 1, state: { privateSeed: 5, position: 8 } }, "p1");
    expect(session.snapshot({ ...binding, subject: "other" })).toBeNull();
    expect(session.snapshot(binding)?.sequence).toBe(2);
  });

  it("applies committed connection replacement and leave without admitting stale callbacks", () => {
    const { session, room } = setup();
    let next = disconnectMember(room, binding.subject, binding.connectionId, 500, ctx(room)).room;
    expect(session.updateRoom(next)).toBe(true);
    expect(session.receive(binding, frame()).status).toBe("denied");
    next = reconnectMember(next, { ...binding, connectionId: "replacement", alias: "pilot-a" },
      { type: "gameAdmission", version: "1.0.0", roomId: next.roomId, revision: next.revision, subject: binding.subject, allowed: true, expiresAt: 2000 }, ctx(next)).room;
    expect(session.updateRoom(next)).toBe(true);
    expect(session.receive(binding, frame()).status).toBe("denied");
    const replacement = { ...binding, connectionId: "replacement" };
    expect(session.receive(replacement, frame()).status).toBe("denied");
    expect(session.receive(replacement, frame({ generation: 2 })).status).toBe("accepted");
    expect(session.updateRoom(room)).toBe(false);
    expect(session.updateRoom({ ...next, revision: next.revision + 1, rulesVersion: "2.0.0" })).toBe(false);
    next = leaveMember(next, replacement.subject, replacement.connectionId, ctx(next)).room;
    expect(session.updateRoom(next)).toBe(true);
    expect(session.receive(replacement, frame({ generation: 2 })).status).toBe("denied");
  });

  it("fences old workers, expires leases, denies clock reversal and requires a live rollout decision", () => {
    const a = setup(); expect(a.session.updateRoom(transferAuthority(a.room, ctx(a.room)).room)).toBe(false);
    expect(a.session.status()).toMatchObject({ state: "stopped", reason: "fenced" });
    expect(a.session.receive(binding, frame()).status).toBe("inactive"); expect(a.runtime.pause).toHaveBeenCalledOnce();
    const b = setup(); b.time(2000); expect(b.session.advance(16).status).toBe("inactive");
    expect(b.session.status().reason).toBe("lease-expired"); expect(b.session.renewLease({ roomId: "room-a", epoch: 1, expiresAt: 3000 })).toBe(false);
    const c = setup(); c.time(1099); expect(c.session.snapshot(binding)).toBeNull(); expect(c.session.status().reason).toBe("clock");
    let enabled: unknown = true; const d = setup({ enabled: () => enabled }); enabled = false;
    expect(d.session.receive(binding, frame()).status).toBe("inactive"); expect(d.session.status().reason).toBe("disabled");
    for (const gate of [() => undefined, () => { throw new Error("private error"); }, () => Promise.resolve(true)]) {
      const e = setup({ enabled: gate }); expect(e.session.status().reason).toBe("disabled");
    }
  });

  it("renews only live matching leases and halts when the committed room finishes", () => {
    const { session, room, time } = setup();
    for (const lease of [null, { roomId: "other", epoch: 1, expiresAt: 2500 }, { roomId: "room-a", epoch: 2, expiresAt: 2500 },
      { roomId: "room-a", epoch: 1, expiresAt: 1100 }, { roomId: "room-a", epoch: 1, expiresAt: 40_000 }]) expect(session.renewLease(lease)).toBe(false);
    expect(session.renewLease({ roomId: "room-a", epoch: 1, expiresAt: 2500 })).toBe(true);
    time(2001); expect(session.receive(binding, frame()).status).toBe("accepted");
    expect(session.updateRoom(finishRoom(room, ctx(room, 2001)).room)).toBe(true);
    expect(session.status()).toMatchObject({ state: "stopped", reason: "room-ended" });
  });

  it("reports actual runtime work and stops instead of hiding dropped simulation time", () => {
    const { session, runtime } = setup();
    expect(session.advance(20)).toEqual({ status: "advanced", steps: 1, discardedMs: 0 });
    expect(runtime.advance).toHaveBeenCalledWith(20);
    runtime.advance.mockReturnValue({ steps: 5, discardedMs: 20, alpha: 0.5, presentationFailed: false });
    expect(session.advance(100)).toEqual({ status: "stopped", steps: 5, discardedMs: 20 });
    expect(session.status()).toMatchObject({ reason: "overloaded", rankingEligible: false });
    expect(session.receive(binding, frame()).status).toBe("inactive");
  });

  it("bounds preset signaling, replay and cooldown and emits only server-authored slot metadata", () => {
    const { session, time, runtime } = setup();
    const signal = { type: "gameClientFrame", version: "1.0.0", roomId: "room-a", generation: 1, kind: "signal", signal: "thanks", sequence: 1 };
    expect(session.receive(binding, signal)).toEqual({ status: "accepted", signal: { type: "gameServerFrame", version: "1.0.0",
      roomId: "room-a", epoch: 1, sequence: 1, kind: "signal", playerId: "p1", signal: "thanks" } });
    expect(session.receive(binding, signal).status).toBe("rejected");
    expect(session.receive(binding, { ...signal, sequence: 2 }).status).toBe("rejected");
    session.renewLease({ roomId: "room-a", epoch: 1, expiresAt: 4000 }); time(2100);
    expect(session.receive(binding, { ...signal, sequence: 2 }).status).toBe("accepted");
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });

  it("sanitizes provider faults and releases runtime resources once on cancellation", () => {
    const a = setup(); a.runtime.enqueue.mockImplementation(() => { throw new Error("private upstream"); });
    expect(a.session.receive(binding, frame())).toEqual({ status: "inactive" }); expect(a.session.status().reason).toBe("runtime");
    const b = setup(); b.runtime.advance.mockImplementation(() => { throw new Error("private upstream"); });
    expect(b.session.advance(16).status).toBe("inactive");
    const c = setup(); c.projectState.mockImplementation(() => { throw new Error("private state"); });
    expect(c.session.snapshot(binding)).toBeNull(); expect(c.session.status().reason).toBe("projection");
    const d = setup(); d.session.dispose(); d.session.dispose();
    expect(d.runtime.dispose).toHaveBeenCalledOnce(); expect(d.session.status().state).toBe("disposed");
    expect(d.session.updateRoom(d.room)).toBe(false); expect(d.session.advance(16).status).toBe("inactive");
  });

  it("does not continue through reentrant disposal or accept an invalid runtime result", () => {
    const a = setup(); a.parseInput.mockImplementation(value => {
      expect(a.session.receive(binding, frame()).status).toBe("inactive");
      expect(a.session.status().state).toBe("active"); a.session.dispose(); return value;
    });
    expect(a.session.receive(binding, frame()).status).toBe("inactive"); expect(a.runtime.enqueue).not.toHaveBeenCalled();
    const b = setup(); b.projectState.mockImplementation(() => { b.session.dispose(); return "{}"; });
    expect(b.session.snapshot(binding)).toBeNull();
    const c = setup(); c.runtime.advance.mockReturnValue({ steps: 0, discardedMs: NaN, alpha: 0, presentationFailed: false });
    expect(c.session.advance(1)).toEqual({ status: "inactive" }); expect(c.session.status().reason).toBe("runtime");
    const d = setup(); d.runtime.status.mockReturnValue("faulted");
    expect(d.session.status().reason).toBe("runtime");
    const e = setup(); e.time(100_000); expect(e.session.status().reason).toBe("room-ended");
    const f = setup(); f.runtime.pause.mockImplementation(() => { throw new Error("provider detail"); }); f.time(2000);
    expect(f.session.status().reason).toBe("lease-expired");
    f.runtime.dispose.mockImplementation(() => { throw new Error("provider detail"); }); expect(() => f.session.dispose()).not.toThrow();
    for (const change of [{ room: { ...makeRoom(), state: "waiting" } }, { parseInput: undefined }, { lease: { roomId: "other", epoch: 1, expiresAt: 2000 } },
      { clock: () => { throw new Error("private detail"); } }, { clock: () => NaN }]) expect(() => setup(change)).toThrow(/invalid-authority/);
  });
});
