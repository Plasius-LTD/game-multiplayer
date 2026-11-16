import { createSchema, field } from "@plasius/schema";
import { envelope, integer, token } from "./contracts.js";

/** Fixed signals only; the host still evaluates blocks before delivering them to peers. */
export type GameSignal = "ready" | "nice" | "thanks" | "retry";
interface ClientBase { type: "gameClientFrame"; version: "1.0.0"; roomId: string; generation: number }
/** Carrier validation does not replace the runtime's gameInput parser. */
export type ClientFrame = ClientBase & ({ kind: "intent"; intentJson: string } | { kind: "signal"; signal: GameSignal; sequence: number });
interface ServerBase { type: "gameServerFrame"; version: "1.0.0"; roomId: string; epoch: number; sequence: number }
/** Game-owned public projections, never the private runtime checkpoint. */
export type ServerFrame = ServerBase & ({ kind: "snapshot"; tick: number; stateJson: string }
  | { kind: "signal"; playerId: string; signal: GameSignal });

export const MAX_CLIENT_FRAME_BYTES = 4096;
export const MAX_SERVER_FRAME_BYTES = 64 * 1024;
export const MAX_PROJECTED_STATE_BYTES = 48 * 1024;
const encoder = new TextEncoder();
const signals = () => field.string().enum(["ready", "nice", "thanks", "retry"]);
const clientBase = { roomId: token(), generation: integer(1) };
const serverBase = { roomId: token(), epoch: integer(1), sequence: integer(1) };
const intentSchema = createSchema({ ...clientBase, kind: field.string().enum(["intent"]), intentJson: field.string().min(1).max(2048) }, "gameClientFrame", envelope);
const signalSchema = createSchema({ ...clientBase, kind: field.string().enum(["signal"]), signal: signals(), sequence: integer(0) }, "gameClientFrame", envelope);
const snapshotSchema = createSchema({ ...serverBase, kind: field.string().enum(["snapshot"]), tick: integer(0),
  stateJson: field.string().min(1).max(MAX_PROJECTED_STATE_BYTES) }, "gameServerFrame", envelope);
const eventSchema = createSchema({ ...serverBase, kind: field.string().enum(["signal"]),
  playerId: field.string().enum(["p1", "p2", "p3", "p4"]), signal: signals() }, "gameServerFrame", envelope);

/** Bound UTF-8 before JSON parsing, using fixed errors that never include payloads. */
export function readBoundedJson(raw: string, maximum: number): unknown {
  if (raw.length > maximum || encoder.encode(raw).byteLength > maximum) throw new RangeError("frame-too-large");
  try { return JSON.parse(raw); } catch { throw new TypeError("invalid-frame-json"); }
}
function candidate(raw: unknown, maximum: number): Record<string, unknown> {
  const value = typeof raw === "string" ? readBoundedJson(raw, maximum) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid-frame");
  return value as Record<string, unknown>;
}
const checkBytes = (value: unknown, maximum: number) => { readBoundedJson(JSON.stringify(value), maximum); };

/** Strict transport carrier; semantic input validation is delegated to game-runtime. */
export function parseClientFrame(raw: unknown): ClientFrame {
  const value = candidate(raw, MAX_CLIENT_FRAME_BYTES);
  const result = (value.kind === "intent" ? intentSchema : signalSchema).validate(value);
  if (!result.valid) throw new TypeError("invalid-client-frame");
  const frame = result.value as unknown as ClientFrame;
  if (frame.kind === "intent") readBoundedJson(frame.intentJson, 2048);
  checkBytes(frame, MAX_CLIENT_FRAME_BYTES);
  return frame;
}
/** Bound and detach a server frame; games must separately validate their public state. */
export function parseServerFrame(raw: unknown): ServerFrame {
  const value = candidate(raw, MAX_SERVER_FRAME_BYTES);
  const result = (value.kind === "snapshot" ? snapshotSchema : eventSchema).validate(value);
  if (!result.valid) throw new TypeError("invalid-server-frame");
  const frame = result.value as unknown as ServerFrame;
  if (frame.kind === "snapshot") readBoundedJson(frame.stateJson, MAX_PROJECTED_STATE_BYTES);
  checkBytes(frame, MAX_SERVER_FRAME_BYTES);
  return frame;
}
