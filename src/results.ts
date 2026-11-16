import { createSchema, field } from "@plasius/schema";
import { alias, envelope, exact, integer, parseRoom, partitionShape, slug, token, type GamePartition, type GameRoom } from "./contracts.js";
import { readBoundedJson } from "./protocol.js";
import { finishRoom } from "./rooms.js";

/** Metric semantics are pinned alongside rules/content, never inferred from a client score. */
export interface RankingMetric { id: string; order: "ascending" | "descending" }
export interface RankingPartition extends GamePartition { type: "gameRankingPartition"; version: "1.0.0"; metric: RankingMetric }
/** Game-owned evaluation of a terminal runtime snapshot; ranking policy is deliberately absent. */
export interface GameOutcome {
  type: "gameOutcome"; version: "1.0.0";
  players: ({ playerId: string; outcome: "finished"; value: number } | { playerId: string; outcome: "forfeited"; value?: never })[];
}
type FinishedPlayer = { playerId: string; alias: string; outcome: "finished"; value: number; rankingEligible: boolean };
type ForfeitedPlayer = { playerId: string; alias: string; outcome: "forfeited"; value?: never; rankingEligible: false };
type AbandonedPlayer = { playerId: string; alias: string; outcome: "abandoned"; value?: never; rankingEligible: false };
interface ResultBase extends GamePartition {
  type: "gameResult"; version: "1.0.0"; roomId: string; roomRevision: number; epoch: number; endedAt: number;
}
/** A parsed record is data, not proof of ownership or permission to write a result. */
export type GameResult = (ResultBase & { status: "completed"; finalTick: number; metric: RankingMetric; players: (FinishedPlayer | ForfeitedPlayer)[] })
  | (ResultBase & { status: "abandoned"; finalTick?: number; metric?: never; players: AbandonedPlayer[] });
/** Private atomic commit candidate. Preserve all fields across uncertain outcomes. */
export interface ResultCandidate {
  idempotencyKey: string; expected: { roomId: string; revision: number; epoch: number }; notAfter: number;
  nextRoom: GameRoom; result: GameResult;
}
export interface RankingPolicyContext { roomId: string; revision: number; epoch: number; playerId: string }
export interface AuthorityResults<S> {
  metric: RankingMetric;
  evaluate(snapshot: { tick: number; state: S }): unknown;
  /** Current trusted host policy, including the ranking flag/capability and guardian/consent rules. */
  eligible?(context: RankingPolicyContext): unknown;
}
export interface RankingEntry {
  type: "gameRankingEntry"; version: "1.0.0"; partition: RankingPartition;
  roomId: string; playerId: string; alias: string; value: number; endedAt: number;
}
export const MAX_RESULT_BYTES = 16 * 1024;
const slot = () => field.string().enum(["p1", "p2", "p3", "p4"]);
const metricShape = { id: slug(), order: field.string().enum(["ascending", "descending"]) };
const metricSchema = createSchema(metricShape, "gameRankingMetric", exact);
const partitionSchema = createSchema({ ...partitionShape, metric: field.object(metricShape) }, "gameRankingPartition", envelope);
const playerOutcome = { playerId: slot(), outcome: field.string().enum(["finished", "forfeited"]), value: integer(-Number.MAX_SAFE_INTEGER).optional() };
const outcomeSchema = createSchema({ players: field.array(field.object(playerOutcome)).min(1).max(4) }, "gameOutcome", envelope);
const resultShape = { ...partitionShape, roomId: token(), roomRevision: integer(1), epoch: integer(1), endedAt: integer(0) };
const completedSchema = createSchema({ ...resultShape, status: field.string().enum(["completed"]), finalTick: integer(1),
  metric: field.object(metricShape), players: field.array(field.object({ ...playerOutcome, alias: alias(), rankingEligible: field.boolean() })).min(1).max(4),
}, "gameResult", envelope);
const abandonedSchema = createSchema({ ...resultShape, status: field.string().enum(["abandoned"]), finalTick: integer(0).optional(),
  players: field.array(field.object({ playerId: slot(), alias: alias(), outcome: field.string().enum(["abandoned"]), rankingEligible: field.boolean() })).max(4),
}, "gameResult", envelope);
const object = (raw: unknown): Record<string, unknown> => {
  const value = typeof raw === "string" ? readBoundedJson(raw, MAX_RESULT_BYTES) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid-result");
  // Schema configuration may default identity metadata; wire records must supply actual strings.
  if (typeof (value as Record<string, unknown>).type !== "string" || typeof (value as Record<string, unknown>).version !== "string") throw new TypeError("invalid-result");
  return value as Record<string, unknown>;
};
const bounded = <T>(value: T): T => { readBoundedJson(JSON.stringify(value), MAX_RESULT_BYTES); return value; };
function partitionFields(value: GamePartition): GamePartition {
  if (new Set(value.assistance).size !== value.assistance.length) throw new TypeError("invalid-result-partition");
  return { gameId: value.gameId, modeId: value.modeId, rulesVersion: value.rulesVersion, contentVersion: value.contentVersion,
    difficulty: value.difficulty, assistance: [...value.assistance].sort() };
}
function distinctSlots(players: { playerId: string }[]): void {
  if (new Set(players.map(player => player.playerId)).size !== players.length) throw new TypeError("invalid-result-players");
}
const bySlot = (a: { playerId: string }, b: { playerId: string }) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;

export function parseRankingMetric(raw: unknown): RankingMetric {
  const result = metricSchema.validate(raw);
  if (!result.valid || !result.value) throw new TypeError("invalid-ranking-metric");
  return { id: result.value.id, order: result.value.order as RankingMetric["order"] };
}
/** Strict canonical durable result, detached from its input. Preserve errors, never overwrite unknown records. */
export function parseGameResult(raw: unknown): GameResult {
  const value = object(raw);
  const parsed = (value.status === "completed" ? completedSchema : abandonedSchema).validate(value);
  if (!parsed.valid) throw new TypeError("invalid-result");
  const result = parsed.value as unknown as GameResult;
  distinctSlots(result.players);
  const common = { type: "gameResult" as const, version: "1.0.0" as const, ...partitionFields(result),
    roomId: result.roomId, roomRevision: result.roomRevision, epoch: result.epoch, endedAt: result.endedAt };
  if (result.status === "completed") {
    for (const player of result.players) {
      if ((player.outcome === "finished" && player.value === undefined)
        || (player.outcome === "forfeited" && (player.value !== undefined || player.rankingEligible))) throw new TypeError("invalid-result-player");
    }
    return bounded({ ...common, status: "completed", finalTick: result.finalTick, metric: parseRankingMetric(result.metric),
      players: result.players.sort(bySlot).map(player => player.outcome === "finished"
        ? { playerId: player.playerId, alias: player.alias, outcome: "finished", value: player.value, rankingEligible: player.rankingEligible }
        : { playerId: player.playerId, alias: player.alias, outcome: "forfeited", rankingEligible: false }) });
  }
  if (result.players.some(player => player.rankingEligible)) throw new TypeError("invalid-abandoned-result");
  return bounded({ ...common, status: "abandoned", ...(result.finalTick !== undefined ? { finalTick: result.finalTick } : {}),
    players: result.players.sort(bySlot).map(player => ({ playerId: player.playerId, alias: player.alias, outcome: "abandoned", rankingEligible: false })) });
}
/** Canonical equality form. Its logical fields need provider-specific storage key mapping in the host. */
export const serializeGameResult = (raw: unknown): string => JSON.stringify(parseGameResult(raw));
/** Use inside the host's atomic result transaction; null must mean a confirmed absent record. */
export function classifyResultReplay(existing: unknown, candidate: unknown): "new" | "identical" | "conflict" {
  const proposed = serializeGameResult(candidate);
  return existing === null ? "new" : serializeGameResult(existing) === proposed ? "identical" : "conflict";
}
/** Explicit unranked evidence from an authenticated, committed terminal room. No guessed final tick. */
export function createAbandonedResult(raw: unknown, finalTick?: number): GameResult {
  const room = parseRoom(raw);
  if (room.state !== "abandoned") throw new TypeError("room-not-abandoned");
  return parseGameResult({ type: "gameResult", version: "1.0.0", ...partitionFields(room), roomId: room.roomId,
    roomRevision: room.revision, epoch: room.epoch, endedAt: room.updatedAt, status: "abandoned",
    ...(finalTick !== undefined ? { finalTick } : {}),
    players: room.members.map(member => ({ playerId: member.playerId, alias: member.alias, outcome: "abandoned", rankingEligible: false })) });
}
/** Canonical exact compatibility, including metric meaning and gameplay-changing assistance. */
export function parseRankingPartition(raw: unknown): RankingPartition {
  const parsed = partitionSchema.validate(object(raw));
  if (!parsed.valid) throw new TypeError("invalid-ranking-partition");
  const value = parsed.value as unknown as RankingPartition;
  return bounded({ type: "gameRankingPartition", version: "1.0.0", ...partitionFields(value), metric: parseRankingMetric(value.metric) });
}
export const serializeRankingPartition = (raw: unknown): string => JSON.stringify(parseRankingPartition(raw));
export function rankingPartition(raw: unknown): RankingPartition {
  const result = parseGameResult(raw);
  if (result.status !== "completed") throw new TypeError("unranked-result");
  return parseRankingPartition({ type: "gameRankingPartition", version: "1.0.0", ...partitionFields(result), metric: result.metric });
}
/** Project only a committed result. The host must still apply current public visibility/guardian/consent policy. */
export function projectRankingEntries(raw: unknown): RankingEntry[] {
  const result = parseGameResult(raw);
  if (result.status !== "completed") return [];
  const partition = rankingPartition(result);
  return result.players.flatMap(player => player.outcome === "finished" && player.rankingEligible
    ? [{ type: "gameRankingEntry" as const, version: "1.0.0" as const, partition: structuredClone(partition), roomId: result.roomId,
      playerId: player.playerId, alias: player.alias, value: player.value, endedAt: result.endedAt }] : []);
}
/** Count-only telemetry: no identifiers, aliases, scores, private state or credential fields. */
export function summarizeGameResult(raw: unknown) {
  const result = parseGameResult(raw);
  return { gameId: result.gameId, modeId: result.modeId, status: result.status, players: result.players.length,
    finished: result.players.filter(p => p.outcome === "finished").length,
    forfeited: result.players.filter(p => p.outcome === "forfeited").length,
    abandoned: result.players.filter(p => p.outcome === "abandoned").length,
    ranked: result.players.filter(p => p.rankingEligible).length };
}

/** Internal authority boundary. Parsing an outcome alone cannot finalize a room. */
export function parseGameOutcome(raw: unknown, room: GameRoom): GameOutcome {
  const parsed = outcomeSchema.validate(object(raw));
  if (!parsed.valid) throw new TypeError("invalid-game-outcome");
  const value = parsed.value as unknown as GameOutcome;
  distinctSlots(value.players);
  if (value.players.length !== room.members.length) throw new TypeError("invalid-game-outcome");
  for (const player of value.players) {
    const member = room.members.find(m => m.playerId === player.playerId);
    if (!member || (player.outcome === "finished" && (member.left || player.value === undefined))
      || (player.outcome === "forfeited" && player.value !== undefined)) throw new TypeError("invalid-game-outcome");
  }
  return value;
}
/** Internal helper; createAuthority owns lease, input, runtime and policy checks before calling this. */
export function prepareCompletedResult(room: GameRoom, finalTick: number, outcome: GameOutcome, metric: RankingMetric,
  eligible: ReadonlySet<string>, now: number, notAfter: number): ResultCandidate {
  const transition = finishRoom(room, { revision: room.revision, epoch: room.epoch, now });
  if (transition.status !== "changed" || notAfter <= now || notAfter > room.expiresAt) throw new TypeError("invalid-result-commit");
  const result = parseGameResult({ type: "gameResult", version: "1.0.0", ...partitionFields(room), roomId: room.roomId,
    roomRevision: transition.room.revision, epoch: room.epoch, endedAt: now, finalTick, metric, status: "completed",
    players: outcome.players.map(player => ({ ...player, alias: room.members.find(m => m.playerId === player.playerId)!.alias,
      rankingEligible: player.outcome === "finished" && eligible.has(player.playerId) })) });
  return { idempotencyKey: room.roomId, expected: { roomId: room.roomId, revision: room.revision, epoch: room.epoch },
    notAfter, nextRoom: transition.room, result };
}
