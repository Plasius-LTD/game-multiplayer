import { contextMatches, parseJoiningMember, parseRoom, parseRoomConfig, permitsAdmission,
  type GameRoom, type MutationContext, type RoomConfig } from "./contracts.js";

/** A candidate is not committed until the host atomically compares its prior revision/epoch. */
export interface RoomTransition {
  status: "changed" | "unchanged" | "denied" | "stale" | "full" | "not-ready" | "invalid";
  room: GameRoom;
}
const terminal = (room: GameRoom) => room.state === "finished" || room.state === "abandoned";
const changed = (room: GameRoom, context: MutationContext): RoomTransition => ({ status: "changed",
  room: parseRoom({ ...room, revision: room.revision + 1, updatedAt: context.now }) });
const outcome = (room: GameRoom, status: RoomTransition["status"]): RoomTransition => ({ status, room });
const live = (room: GameRoom, context: MutationContext) => !terminal(room) && context.now < room.expiresAt;

/** Allocate a new private host record with no members or client-selected ownership. */
export function createRoom(config: RoomConfig | unknown): GameRoom {
  const parsed = parseRoomConfig(config);
  return parseRoom({ ...parsed, type: "gameRoom", version: "1.0.0", revision: 0, epoch: 1,
    state: "waiting", updatedAt: parsed.createdAt, members: [] });
}

/** Create a whitelist-only public view; no subjects, connection IDs or authority evidence. */
export function projectRoom(raw: unknown) {
  const room = parseRoom(raw);
  return { type: "gameRoomView" as const, version: "1.0.0" as const, roomId: room.roomId,
    gameId: room.gameId, modeId: room.modeId, rulesVersion: room.rulesVersion, contentVersion: room.contentVersion,
    difficulty: room.difficulty, assistance: room.assistance, revision: room.revision, visibility: room.visibility,
    state: room.state, capacity: room.capacity, minimumPlayers: room.minimumPlayers, expiresAt: room.expiresAt,
    members: room.members.map(member => ({ playerId: member.playerId, alias: member.alias, connected: member.connected })) };
}

/** Join only a waiting room after trusted policy for its exact roster revision. */
export function joinRoom(raw: unknown, candidate: unknown, decision: unknown, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (!live(room, context) || room.state !== "waiting") return outcome(room, "not-ready");
  const member = parseJoiningMember(candidate);
  if (!member || !permitsAdmission(room, member, decision, context.now)) return outcome(room, "denied");
  const existing = room.members.find(value => value.subject === member.subject);
  if (existing) return outcome(room, existing.connectionId === member.connectionId && existing.connected ? "unchanged" : "denied");
  if (room.members.some(value => value.connectionId === member.connectionId)) return outcome(room, "denied");
  if (room.members.length === room.capacity) return outcome(room, "full");
  const playerId = ["p1", "p2", "p3", "p4"].find(slot => !room.members.some(value => value.playerId === slot))!;
  room.members.push({ ...member, playerId, generation: 1, connected: true, left: false });
  return changed(room, context);
}

/** Start only when all allocated members are connected and minimum participation is met. */
export function startRoom(raw: unknown, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (!live(room, context) || room.state !== "waiting" || room.members.length < room.minimumPlayers
    || room.members.some(member => !member.connected)) return outcome(room, "not-ready");
  room.state = "active";
  return changed(room, context);
}

/** An old transport close cannot disconnect a replacement connection. Duplicate closes do not extend grace. */
export function disconnectMember(raw: unknown, subject: string, connectionId: string, graceMs: number, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (!live(room, context)) return outcome(room, "not-ready");
  if (!Number.isInteger(graceMs) || graceMs < 100 || graceMs > 120_000) return outcome(room, "invalid");
  const member = room.members.find(value => value.subject === subject && value.connectionId === connectionId);
  if (!member || member.left) return outcome(room, "stale");
  if (!member.connected) return outcome(room, "unchanged");
  member.connected = false;
  member.reconnectUntil = Math.min(room.expiresAt, context.now + graceMs);
  return changed(room, context);
}

/** Re-evaluate policy and replace a disconnected member's connection without changing its player slot. */
export function reconnectMember(raw: unknown, candidate: unknown, decision: unknown, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (!live(room, context)) return outcome(room, "not-ready");
  const joining = parseJoiningMember(candidate);
  if (!joining || !permitsAdmission(room, joining, decision, context.now)) return outcome(room, "denied");
  const member = room.members.find(value => value.subject === joining.subject);
  if (!member || member.left) return outcome(room, "denied");
  if (member.connected) return outcome(room, member.connectionId === joining.connectionId ? "unchanged" : "denied");
  if (member.reconnectUntil! <= context.now || member.generation === Number.MAX_SAFE_INTEGER
    || room.members.some(value => value.connectionId === joining.connectionId)) return outcome(room, "denied");
  member.connectionId = joining.connectionId; member.generation++; member.connected = true;
  delete member.reconnectUntil;
  return changed(room, context);
}

/** Leave is terminal for an active match; waiting rooms may reuse the vacated slot. */
export function leaveMember(raw: unknown, subject: string, connectionId: string, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (!live(room, context)) return outcome(room, "not-ready");
  const member = room.members.find(value => value.subject === subject && value.connectionId === connectionId);
  if (!member) return outcome(room, "stale");
  if (member.left) return outcome(room, "unchanged");
  if (room.state === "waiting") room.members = room.members.filter(value => value !== member);
  else {
    member.left = true; member.connected = false; delete member.reconnectUntil;
    if (room.members.every(value => value.left)) room.state = "abandoned";
  }
  return changed(room, context);
}

/** Apply reconnect/room deadlines explicitly using the host's monotonic wall-clock input. */
export function expireRoom(raw: unknown, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (terminal(room)) return outcome(room, "unchanged");
  if (context.now >= room.expiresAt) { room.state = "abandoned"; return changed(room, context); }
  const expired = room.members.filter(member => !member.connected && !member.left && member.reconnectUntil! <= context.now);
  if (expired.length === 0) return outcome(room, "unchanged");
  if (room.state === "waiting") room.members = room.members.filter(member => !expired.includes(member));
  else {
    for (const member of expired) { member.left = true; delete member.reconnectUntil; }
    if (room.members.every(member => member.left)) room.state = "abandoned";
  }
  return changed(room, context);
}

/** Only the trusted authoritative host invokes this; result commitment is a separate transaction. */
export function finishRoom(raw: unknown, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (!live(room, context) || room.state !== "active") return outcome(room, "not-ready");
  room.state = "finished";
  return changed(room, context);
}

/** Prepare a new fencing epoch; the host must acquire its persisted lease and commit atomically. */
export function transferAuthority(raw: unknown, context: MutationContext): RoomTransition {
  const room = parseRoom(raw);
  if (!contextMatches(room, context)) return outcome(room, "stale");
  if (!live(room, context)) return outcome(room, "not-ready");
  if (room.epoch === Number.MAX_SAFE_INTEGER) return outcome(room, "invalid");
  room.epoch++;
  return changed(room, context);
}
