import { createSchema, field, type SchemaValidationContext } from "@plasius/schema";

/** Exact compatibility partition; assistance changes gameplay/ranking eligibility. */
export interface GamePartition {
  gameId: string; modeId: string; rulesVersion: string; contentVersion: string;
  difficulty: string; assistance: string[];
}
/** Private persisted member; subjects and connection identities must never be broadcast. */
export interface RoomMember {
  subject: string; playerId: string; alias: string; connectionId: string;
  generation: number; connected: boolean; left: boolean; reconnectUntil?: number;
}
/** Private host state. A parsed record is not proof of caller authorization. */
export interface GameRoom extends GamePartition {
  type: "gameRoom"; version: "1.0.0"; roomId: string; revision: number; epoch: number;
  visibility: "private" | "public"; state: "waiting" | "active" | "finished" | "abandoned";
  capacity: number; minimumPlayers: number; createdAt: number; updatedAt: number; expiresAt: number;
  members: RoomMember[];
}
/** Configure a new waiting room; server allocates member slots. */
export interface RoomConfig extends GamePartition {
  roomId: string; visibility: "private" | "public"; capacity: number; minimumPlayers: number;
  createdAt: number; expiresAt: number;
}
/** Compare these fields again in the host's atomic commit. */
export interface MutationContext { revision: number; epoch: number; now: number }
/** A trusted host decision, never a client-authored claim or wire credential. */
export interface AdmissionDecision {
  type: "gameAdmission"; version: "1.0.0"; roomId: string; revision: number;
  subject: string; allowed: boolean; expiresAt: number;
}
/** Host-authenticated member binding; aliases must be generated without personal data. */
export interface JoiningMember { subject: string; connectionId: string; alias: string }

export const MAX_ROOM_BYTES = 64 * 1024;
export const MAX_ROOM_DURATION_MS = 12 * 60 * 60 * 1000;
export const integer = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  field.number().validator(value => Number.isSafeInteger(value) && value >= min && value <= max);
export const token = () => field.string().validator(value => /^[A-Za-z0-9_-]{1,128}$/.test(value));
export const slug = () => field.string().validator(value => /^[a-z][a-z0-9-]{0,63}$/.test(value));
export const alias = () => field.string().validator(value => /^[A-Za-z][A-Za-z0-9 -]{0,31}$/.test(value));
export const exact = { version: "1.0.0", identity: "exact", unknownFields: "reject" } as const;
export const envelope = { ...exact, schemaValidator: (_value: unknown, context?: SchemaValidationContext) =>
  context?.wasProvided("type") === true && context.wasProvided("version") };
export const partitionShape = {
  gameId: slug(), modeId: slug(), rulesVersion: field.version().max(64), contentVersion: field.version().max(64),
  difficulty: slug(), assistance: field.array(slug()).max(16),
};
const configShape = { ...partitionShape, roomId: token(), visibility: field.string().enum(["private", "public"]),
  capacity: integer(1, 4), minimumPlayers: integer(1, 4), createdAt: integer(0), expiresAt: integer(0) };
const memberShape = { subject: token(), connectionId: token(), alias: alias() };
const configSchema = createSchema(configShape, "gameRoomConfig", exact);
const memberSchema = createSchema(memberShape, "gameJoiningMember", exact);
const roomSchema = createSchema({ ...configShape, revision: integer(0), epoch: integer(1), updatedAt: integer(0),
  state: field.string().enum(["waiting", "active", "finished", "abandoned"]),
  members: field.array(field.object({ ...memberShape, playerId: field.string().enum(["p1", "p2", "p3", "p4"]),
    generation: integer(1), connected: field.boolean(), left: field.boolean(), reconnectUntil: integer(0).optional() })).max(4),
}, "gameRoom", envelope);
const contextSchema = createSchema({ revision: integer(0), epoch: integer(1), now: integer(0) }, "gameMutationContext", exact);
const admissionSchema = createSchema({ roomId: token(), revision: integer(0), subject: token(), allowed: field.boolean(), expiresAt: integer(0) }, "gameAdmission", envelope);

function checkConfig(value: RoomConfig): void {
  if (value.minimumPlayers > value.capacity || value.expiresAt <= value.createdAt
    || value.expiresAt - value.createdAt > MAX_ROOM_DURATION_MS
    || new Set(value.assistance).size !== value.assistance.length) throw new TypeError("invalid-room");
  value.assistance.sort();
}
/** Parse a bounded private room and its cross-field invariants, returning detached state. */
export function parseRoom(raw: unknown): GameRoom {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_ROOM_BYTES || new TextEncoder().encode(raw).byteLength > MAX_ROOM_BYTES) throw new RangeError("room-too-large");
    try { value = JSON.parse(raw); } catch { throw new TypeError("invalid-room"); }
  }
  const result = roomSchema.validate(value);
  if (!result.valid) throw new TypeError("invalid-room");
  const room = result.value as unknown as GameRoom;
  checkConfig(room);
  if (room.updatedAt < room.createdAt || room.members.length > room.capacity) throw new TypeError("invalid-room");
  for (const property of ["subject", "connectionId", "playerId"] as const) {
    if (new Set(room.members.map(member => member[property])).size !== room.members.length) throw new TypeError("invalid-room");
  }
  for (const member of room.members) {
    if (Number(member.playerId.slice(1)) > room.capacity || (member.left && member.connected)
      || ((member.connected || member.left) && member.reconnectUntil !== undefined)
      || (!member.connected && !member.left && (member.reconnectUntil === undefined || member.reconnectUntil > room.expiresAt))
      || (room.state === "waiting" && member.left)) throw new TypeError("invalid-room");
  }
  return room;
}
export function parseRoomConfig(raw: unknown): RoomConfig {
  const result = configSchema.validate(raw);
  if (!result.valid || !result.value) throw new TypeError("invalid-room-config");
  const { type: _type, version: _version, ...value } = result.value;
  const config = value as unknown as RoomConfig;
  checkConfig(config);
  return config;
}
export function parseJoiningMember(raw: unknown): JoiningMember | null {
  const result = memberSchema.validate(raw);
  if (!result.valid || !result.value) return null;
  const member = result.value;
  return { subject: member.subject, connectionId: member.connectionId, alias: member.alias };
}
export function contextMatches(room: GameRoom, value: MutationContext): boolean {
  return contextSchema.validate(value).valid && value.revision === room.revision && value.epoch === room.epoch
    && value.now >= room.updatedAt && room.revision < Number.MAX_SAFE_INTEGER;
}
export function permitsAdmission(room: GameRoom, member: JoiningMember, raw: unknown, now: number): boolean {
  const result = admissionSchema.validate(raw);
  if (!result.valid || !result.value) return false;
  const decision = result.value;
  return decision.allowed && decision.subject === member.subject && decision.roomId === room.roomId
    && decision.revision === room.revision && decision.expiresAt > now && decision.expiresAt - now <= 60_000;
}
