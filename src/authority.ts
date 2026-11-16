import { createSchema } from "@plasius/schema";
import { exact, integer, parseRoom, token, type GameRoom, type RoomMember } from "./contracts.js";
import { parseClientFrame, parseServerFrame, type ServerFrame } from "./protocol.js";

/** Structural port of the released game-runtime; this package never simulates ticks itself. */
export interface AuthorityRuntime<S> {
  enqueue(raw: unknown): string;
  advance(elapsedMs: number): { steps: number; discardedMs: number; alpha: number; presentationFailed: boolean };
  snapshot(): { tick: number; state: S };
  status(): string;
  pause(): void;
  dispose(): void;
}
/** Trusted persisted ownership evidence. Parsing a lease is not acquiring it. */
export interface AuthorityLease { roomId: string; epoch: number; expiresAt: number }
/** Supplied from authenticated transport context, never copied from the client payload. */
export interface ConnectionBinding { subject: string; connectionId: string }
export interface AuthorityOptions<S, I extends { playerId: string }> {
  room: unknown; lease: AuthorityLease; runtime: AuthorityRuntime<S>;
  clock(): number;
  /** Trusted cached, live host flag/capability decision. Only literal true admits work. */
  enabled(): unknown;
  parseInput(raw: unknown): I;
  /** Serialize an explicit game-owned public projection for this recipient's player slot. */
  projectState(snapshot: { tick: number; state: S }, playerId: string): string;
}
export type AuthorityStopReason = "fenced" | "lease-expired" | "clock" | "disabled" | "runtime" | "overloaded" | "projection" | "room-ended";
export interface AuthorityStatus { state: "active" | "stopped" | "disposed"; rankingEligible: boolean; reason?: AuthorityStopReason }
export type IntentReceipt = { status: "accepted"; signal?: ServerFrame } | { status: "invalid" | "denied" | "rejected" | "inactive" };
export type AuthorityAdvance = { status: "advanced" | "stopped"; steps: number; discardedMs: number } | { status: "inactive" };
export const MAX_AUTHORITY_LEASE_MS = 30_000;
const leaseSchema = createSchema({ roomId: token(), epoch: integer(1), expiresAt: integer(0) }, "gameAuthorityLease", exact);
const bindingSchema = createSchema({ subject: token(), connectionId: token() }, "gameConnectionBinding", exact);
const pinned = (room: GameRoom) => JSON.stringify([room.roomId, room.gameId, room.modeId, room.rulesVersion, room.contentVersion,
  room.difficulty, room.assistance, room.capacity, room.minimumPlayers, room.createdAt, room.expiresAt, room.visibility]);

/** Own one runtime under a short, renewable host lease; never retain client data in logs. */
export function createAuthority<S, I extends { playerId: string }>(options: AuthorityOptions<S, I>) {
  let room = parseRoom(options.room);
  const { runtime, clock, enabled, parseInput, projectState } = options;
  if (room.state !== "active" || [clock, enabled, parseInput, projectState, runtime?.enqueue, runtime?.advance,
    runtime?.snapshot, runtime?.status, runtime?.pause, runtime?.dispose].some(fn => typeof fn !== "function")) throw new TypeError("invalid-authority-options");
  let state: AuthorityStatus["state"] = "active";
  let reason: AuthorityStopReason | undefined;
  let lastNow = room.updatedAt;
  let busy = false;
  let sequence = 0;
  const signals = new Map<string, { sequence: number; at: number }>();
  const originalRoster = new Map(room.members.map(member => [member.playerId, member.subject]));
  const identity = pinned(room);
  const stop = (why: AuthorityStopReason) => {
    if (state !== "active") return;
    state = "stopped"; reason = why;
    try { runtime.pause(); } catch { /* State is already fenced even if the provider failed. */ }
  };
  function now(): number | null {
    let value: number;
    try { value = clock(); } catch { stop("clock"); return null; }
    if (!Number.isSafeInteger(value) || value < lastNow) { stop("clock"); return null; }
    lastNow = value; return value;
  }
  function parseLease(raw: unknown, at: number): AuthorityLease | null {
    const result = leaseSchema.validate(raw);
    if (!result.valid || !result.value) return null;
    const value = result.value;
    return value.roomId === room.roomId && value.epoch === room.epoch && value.expiresAt > at
      && value.expiresAt <= room.expiresAt && value.expiresAt - at <= MAX_AUTHORITY_LEASE_MS
      ? { roomId: value.roomId, epoch: value.epoch, expiresAt: value.expiresAt } : null;
  }
  const initialTime = now();
  let lease = initialTime === null ? null : parseLease(options.lease, initialTime);
  if (!lease) { stop("lease-expired"); throw new TypeError("invalid-authority-lease"); }

  const isActive = () => state === "active";
  function live(): boolean {
    if (!isActive()) return false;
    const at = now();
    if (at === null) return false;
    if (at >= room.expiresAt) { stop("room-ended"); return false; }
    if (at >= lease!.expiresAt) { stop("lease-expired"); return false; }
    try {
      const decision = enabled();
      if (decision !== true) {
        // Async policy must be resolved in the host before entry; consume accidental rejection.
        if (decision && typeof decision === "object" && typeof (decision as Promise<unknown>).then === "function") void Promise.resolve(decision).catch(() => {});
        stop("disabled"); return false;
      }
      if (runtime.status() !== "running") { stop("runtime"); return false; }
    } catch { stop("disabled"); return false; }
    return isActive();
  }
  function memberFor(raw: unknown): RoomMember | undefined {
    const result = bindingSchema.validate(raw);
    if (!result.valid || !result.value) return undefined;
    const value = result.value;
    return room.members.find(member => member.subject === value.subject && member.connectionId === value.connectionId && member.connected && !member.left);
  }
  function nextSequence(): number {
    if (sequence === Number.MAX_SAFE_INTEGER) throw new RangeError("authority-sequence-overflow");
    return ++sequence;
  }
  function exclusive<T>(fallback: T, operation: () => T): T {
    if (busy) return fallback;
    busy = true;
    try { return live() ? operation() : fallback; } finally { busy = false; }
  }

  return {
    status(): AuthorityStatus {
      // No re-entrant provider callbacks from status called inside a host hook.
      if (!busy) { busy = true; try { live(); } finally { busy = false; } }
      return { state, rankingEligible: state === "active", ...(reason ? { reason } : {}) };
    },
    receive(binding: unknown, raw: unknown): IntentReceipt {
      return exclusive<IntentReceipt>({ status: "inactive" }, () => {
        let frame;
        try { frame = parseClientFrame(raw); } catch { return { status: "invalid" }; }
        const member = memberFor(binding);
        if (!member || frame.roomId !== room.roomId || frame.generation !== member.generation) return { status: "denied" };
        if (frame.kind === "signal") {
          const previous = signals.get(member.playerId);
          if (previous && (frame.sequence <= previous.sequence || lastNow - previous.at < 1000)) return { status: "rejected" };
          let signal: ServerFrame;
          try { signal = parseServerFrame({ type: "gameServerFrame", version: "1.0.0", roomId: room.roomId, epoch: room.epoch,
            sequence: nextSequence(), kind: "signal", playerId: member.playerId, signal: frame.signal }); }
          catch { stop("runtime"); return { status: "inactive" }; }
          signals.set(member.playerId, { sequence: frame.sequence, at: lastNow });
          return { status: "accepted", signal };
        }
        let input: I;
        try { input = parseInput(JSON.parse(frame.intentJson)); } catch { return { status: "invalid" }; }
        if (!input || input.playerId !== member.playerId) return { status: "denied" };
        if (!live()) return { status: "inactive" };
        try {
          const decision = runtime.enqueue(input);
          if (!isActive()) return { status: "inactive" };
          return { status: decision === "accepted" ? "accepted" : "rejected" };
        } catch { stop("runtime"); return { status: "inactive" }; }
      });
    },
    snapshot(binding: unknown): ServerFrame | null {
      return exclusive<ServerFrame | null>(null, () => {
        const member = memberFor(binding);
        if (!member) return null;
        try {
          const snapshot = runtime.snapshot();
          const stateJson = projectState(snapshot, member.playerId);
          if (!live()) return null;
          return parseServerFrame({ type: "gameServerFrame", version: "1.0.0", roomId: room.roomId, epoch: room.epoch,
            sequence: nextSequence(), kind: "snapshot", tick: snapshot.tick, stateJson });
        } catch { stop("projection"); return null; }
      });
    },
    advance(elapsedMs: number): AuthorityAdvance {
      return exclusive<AuthorityAdvance>({ status: "inactive" }, () => {
        try {
          const outcome = runtime.advance(elapsedMs);
          if (!Number.isSafeInteger(outcome.steps) || outcome.steps < 0 || !Number.isFinite(outcome.discardedMs)
            || outcome.discardedMs < 0 || runtime.status() !== "running") throw new TypeError("invalid-runtime-outcome");
          if (!live()) return { status: "inactive" };
          if (outcome.discardedMs > 0) stop("overloaded");
          return { status: isActive() ? "advanced" : "stopped", steps: outcome.steps, discardedMs: outcome.discardedMs };
        } catch { stop("runtime"); return { status: "inactive" }; }
      });
    },
    /** Supply only a committed host record; old revisions cannot undo revocation or replacement. */
    updateRoom(raw: unknown): boolean {
      return exclusive(false, () => {
        let next: GameRoom;
        try { next = parseRoom(raw); } catch { return false; }
        if (next.roomId !== room.roomId) return false;
        if (next.epoch > room.epoch) { stop("fenced"); return false; }
        if (next.epoch !== room.epoch || next.revision <= room.revision || next.updatedAt < room.updatedAt
          || next.updatedAt > lastNow || pinned(next) !== identity || next.state === "waiting"
          || next.members.some(member => originalRoster.get(member.playerId) !== member.subject)) return false;
        room = next;
        if (room.state !== "active") stop("room-ended");
        return true;
      });
    },
    /** Renewal is host-owned and must reflect a successful persisted lease operation. */
    renewLease(raw: unknown): boolean {
      return exclusive(false, () => {
        const next = parseLease(raw, lastNow);
        if (!next || next.expiresAt < lease!.expiresAt) return false;
        lease = next; return true;
      });
    },
    dispose(): void {
      if (state === "disposed") return;
      state = "disposed"; signals.clear(); room.members = [];
      try { runtime.dispose(); } catch { /* Cancellation has already closed every entry point. */ }
    },
  };
}
