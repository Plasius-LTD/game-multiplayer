import { describe, expect, it } from "vitest";
import { createRoom, parseRoom, projectRoom, joinRoom, startRoom, disconnectMember, reconnectMember,
  leaveMember, expireRoom, finishRoom, transferAuthority } from "../src/index.js";

const partition = { gameId: "vector-volley", modeId: "duel", rulesVersion: "1.0.0", contentVersion: "1.0.0", difficulty: "standard", assistance: [] };
const config = { roomId: "room-a", ...partition, visibility: "private", capacity: 2, minimumPlayers: 2, createdAt: 1000, expiresAt: 100_000 };
const member = (subject = "account-a", connectionId = "connection-a") => ({ subject, connectionId, alias: "pilot-one" });
const context = (room: any, now = 1001) => ({ revision: room.revision, epoch: room.epoch, now });
const admission = (room: any, subject = "account-a", allowed = true) => ({ type: "gameAdmission", version: "1.0.0", roomId: room.roomId, revision: room.revision, subject, allowed, expiresAt: 2000 });
const joined = () => { const room = createRoom(config); return joinRoom(room, member(), admission(room), context(room)).room; };
const active = () => {
  let room = joined(); room = joinRoom(room, member("account-b", "connection-b"), admission(room, "account-b"), context(room)).room;
  return startRoom(room, context(room)).room;
};

describe("authoritative room boundaries", () => {
  it("creates a bounded detached versioned room and removes private fields from the public projection", () => {
    const room = joined();
    expect(room).toMatchObject({ type: "gameRoom", version: "1.0.0", state: "waiting", revision: 1, epoch: 1 });
    const publicRoom = projectRoom(room);
    expect(publicRoom.members).toEqual([{ playerId: "p1", alias: "pilot-one", connected: true }]);
    expect(JSON.stringify(publicRoom)).not.toContain("account-a"); expect(JSON.stringify(publicRoom)).not.toContain("connection-a");
    expect(publicRoom).not.toHaveProperty("epoch");
    const copy = parseRoom(room); copy.members[0]!.alias = "changed"; expect(room.members[0]!.alias).toBe("pilot-one");
  });

  it("rejects malformed/oversized room contracts and client score or transform fields", () => {
    for (const change of [{ capacity: 5 }, { minimumPlayers: 3 }, { expiresAt: 999 }, { roomId: "../escape" },
      { assistance: Array(17).fill("assist") }, { rulesVersion: "future" }, { score: 100 }, { transform: [1, 2, 3] }]) {
      expect(() => createRoom({ ...config, ...change })).toThrow();
    }
    const room = joined();
    for (const change of [{ version: "2.0.0" }, { revision: -1 }, { epoch: NaN }, { members: [...room.members, ...room.members] }, { score: 999 }]) {
      expect(() => parseRoom({ ...room, ...change })).toThrow();
    }
  });

  it("denies missing, expired, foreign and stale eligibility even for a private invite", () => {
    const room = createRoom(config); const allowed = admission(room);
    for (const decision of [undefined, { ...allowed, allowed: false }, { ...allowed, expiresAt: 1001 },
      { ...allowed, expiresAt: 100_000 }, { ...allowed, subject: "other" }, { ...allowed, roomId: "other" }, { ...allowed, revision: 1 }]) {
      expect(joinRoom(room, member(), decision, context(room)).status).toBe("denied");
    }
    expect(room.members).toEqual([]);
    const current = joined();
    expect(joinRoom(current, member("account-b", "connection-b"), { ...allowed, subject: "account-b" }, context(current)).status).toBe("denied");
  });

  it("keeps allocation and lifecycle bounded and rejects stale revision/authority", () => {
    const empty = createRoom(config); expect(startRoom(empty, context(empty)).status).toBe("not-ready");
    let room = joined();
    expect(joinRoom(room, member(), admission(room), context(room)).status).toBe("unchanged");
    expect(joinRoom(room, member("account-b", "connection-b"), admission(room, "account-b"), { ...context(room), revision: 0 }).status).toBe("stale");
    expect(startRoom(room, { ...context(room), epoch: 0 }).status).toBe("stale");
    room = joinRoom(room, member("account-b", "connection-b"), admission(room, "account-b"), context(room)).room;
    expect(room.members.map((m: any) => m.playerId)).toEqual(["p1", "p2"]);
    expect(joinRoom(room, member("account-c", "connection-c"), admission(room, "account-c"), context(room)).status).toBe("full");
    room = startRoom(room, context(room)).room; expect(room.state).toBe("active");
    expect(startRoom(room, context(room)).status).toBe("not-ready");
    const finished = finishRoom(room, context(room)); expect(finished.room.state).toBe("finished");
    expect(startRoom(finished.room, context(finished.room)).status).toBe("not-ready");
  });

  it("replaces connections without admitting stale callbacks or losing the player slot", () => {
    const initial = active();
    const disconnected = disconnectMember(initial, "account-a", "connection-a", 500, context(initial)).room;
    expect(disconnected.members[0]).toMatchObject({ connected: false, reconnectUntil: 1501, generation: 1 });
    const resumed = reconnectMember(disconnected, member("account-a", "connection-new"), admission(disconnected), context(disconnected, 1200)).room;
    expect(resumed.members[0]).toMatchObject({ connected: true, playerId: "p1", connectionId: "connection-new", generation: 2 });
    expect(disconnectMember(resumed, "account-a", "connection-a", 500, context(resumed, 1201)).status).toBe("stale");
    expect(reconnectMember(disconnected, member("account-a", "connection-new"), admission(disconnected), context(disconnected, 1501)).status).toBe("denied");
    const left = leaveMember(resumed, "account-a", "connection-new", context(resumed, 1300)).room;
    expect(reconnectMember(left, member(), admission(left), context(left, 1301)).status).toBe("denied");
  });

  it("preserves active room state across authority transfer and abandons expired sessions", () => {
    const room = active(); const transferred = transferAuthority(room, context(room));
    expect(transferred.room.epoch).toBe(2); expect(transferred.room.members).toEqual(room.members);
    expect(finishRoom(transferred.room, context(room)).status).toBe("stale");
    expect(expireRoom(room, context(room, 100_000)).room.state).toBe("abandoned");
    expect(joinRoom(room, member("other"), admission(room, "other"), context(room, 100_000)).status).toBe("not-ready");
  });

  it("expires disconnected members, reuses waiting slots and abandons only after all active players leave", () => {
    let waiting = joined();
    waiting = disconnectMember(waiting, "account-a", "connection-a", 500, context(waiting)).room;
    expect(startRoom(waiting, context(waiting)).status).toBe("not-ready");
    expect(expireRoom(waiting, context(waiting, 1500)).status).toBe("unchanged");
    waiting = expireRoom(waiting, context(waiting, 1501)).room; expect(waiting.members).toEqual([]);
    waiting = joinRoom(waiting, member("account-b", "connection-b"), admission(waiting, "account-b"), context(waiting, 1502)).room;
    expect(waiting.members[0]?.playerId).toBe("p1");
    expect(leaveMember(waiting, "account-b", "connection-b", context(waiting, 1503)).room.members).toEqual([]);

    let room = active(); room = disconnectMember(room, "account-a", "connection-a", 500, context(room)).room;
    room = expireRoom(room, context(room, 1501)).room; expect(room.state).toBe("active"); expect(room.members[0]?.left).toBe(true);
    expect(leaveMember(room, "account-a", "connection-a", context(room, 1502)).status).toBe("unchanged");
    room = disconnectMember(room, "account-b", "connection-b", 500, context(room, 1502)).room;
    expect(expireRoom(room, context(room, 2002)).room.state).toBe("abandoned");
    room = active(); room = leaveMember(room, "account-a", "connection-a", context(room)).room;
    expect(leaveMember(room, "account-b", "connection-b", context(room)).room.state).toBe("abandoned");
  });

  it("rejects stale or terminal mutations across every command", () => {
    const commands = [
      (room: any, ctx: any) => joinRoom(room, member(), admission(room), ctx),
      (room: any, ctx: any) => startRoom(room, ctx),
      (room: any, ctx: any) => disconnectMember(room, "account-a", "connection-a", 500, ctx),
      (room: any, ctx: any) => reconnectMember(room, member("account-a", "new"), admission(room), ctx),
      (room: any, ctx: any) => leaveMember(room, "account-a", "connection-a", ctx),
      (room: any, ctx: any) => finishRoom(room, ctx),
      (room: any, ctx: any) => transferAuthority(room, ctx),
    ];
    const room = active();
    for (const command of [...commands, expireRoom]) {
      expect(command(room, { ...context(room), epoch: 2 }).status).toBe("stale");
      expect(command(room, { ...context(room), now: 0 }).status).toBe("stale");
    }
    const finished = finishRoom(room, context(room)).room;
    for (const command of commands) expect(command(finished, context(finished)).status).toBe("not-ready");
    expect(expireRoom(finished, context(finished, 100_001)).status).toBe("unchanged");
    expect(transferAuthority({ ...room, epoch: Number.MAX_SAFE_INTEGER }, { ...context(room), epoch: Number.MAX_SAFE_INTEGER }).status).toBe("invalid");
    expect(startRoom({ ...joined(), revision: Number.MAX_SAFE_INTEGER }, { revision: Number.MAX_SAFE_INTEGER, epoch: 1, now: 1001 }).status).toBe("stale");
  });

  it("preserves connection generation, bounded grace and private membership invariants", () => {
    const room = active();
    for (const grace of [0, NaN, 120_001]) expect(disconnectMember(room, "account-a", "connection-a", grace, context(room)).status).toBe("invalid");
    expect(leaveMember(room, "other", "connection-a", context(room)).status).toBe("stale");
    const off = disconnectMember(room, "account-a", "connection-a", 120_000, context(room)).room;
    expect(off.members[0]?.reconnectUntil).toBe(room.expiresAt);
    expect(disconnectMember(off, "account-a", "connection-a", 100, context(off)).status).toBe("unchanged");
    const max = structuredClone(off); max.members[0]!.generation = Number.MAX_SAFE_INTEGER;
    expect(reconnectMember(max, member("account-a", "new"), admission(max), context(max)).status).toBe("denied");
    expect(reconnectMember(off, member("account-a", "connection-b"), admission(off), context(off)).status).toBe("denied");
    expect(reconnectMember(off, member("missing", "new"), admission(off, "missing"), context(off)).status).toBe("denied");
    expect(reconnectMember(off, member("account-a", "new"), admission(off, "account-a", false), context(off)).status).toBe("denied");
    expect(reconnectMember(room, member(), admission(room), context(room)).status).toBe("unchanged");
    expect(reconnectMember(room, member("account-a", "new"), admission(room), context(room)).status).toBe("denied");
    expect(joinRoom(joined(), member("account-b", "connection-a"), admission(joined(), "account-b"), context(joined())).status).toBe("denied");
    expect(joinRoom(joined(), member("account-a", "new"), admission(joined()), context(joined())).status).toBe("denied");
  });

  it("rejects invalid cross-field state and bounded serialized input", () => {
    const room = joined(); expect(parseRoom(JSON.stringify(room))).toEqual(room);
    expect(() => parseRoom("{")).toThrow("invalid-room"); expect(() => parseRoom("x".repeat(65537))).toThrow("room-too-large");
    const malformed = [
      { ...room, updatedAt: 0 },
      { ...room, members: [{ ...room.members[0], playerId: "p4" }] },
      { ...room, members: [{ ...room.members[0], connected: false }] },
      { ...room, members: [{ ...room.members[0], left: true }] },
      { ...room, members: [{ ...room.members[0], reconnectUntil: 1500 }] },
      { ...room, members: [{ ...room.members[0], connected: false, reconnectUntil: room.expiresAt + 1 }] },
    ];
    for (const value of malformed) expect(() => parseRoom(value)).toThrow("invalid-room");
    expect(joinRoom(createRoom(config), { ...member(), alias: "name@example.test" }, admission(createRoom(config)), context(createRoom(config))).status).toBe("denied");
  });
});
