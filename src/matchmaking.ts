import { createSchema } from "@plasius/schema";
import { envelope, integer, partitionShape, slug, token, type GamePartition } from "./contracts.js";

/** Private server-issued ticket, after account eligibility and queue admission. */
export interface MatchTicket extends GamePartition {
  type: "gameMatchTicket"; version: "1.0.0"; ticketId: string; revision: number; subject: string;
  region: string; minimumPlayers: number; maximumPlayers: number; createdAt: number; expiresAt: number;
  skill: number; latencyMs: number;
}
/** A plan is private and must be committed atomically against every ticket revision. */
export interface MatchPlan extends GamePartition {
  type: "gameMatchPlan"; version: "1.0.0"; region: string; minimumPlayers: number; maximumPlayers: number;
  members: { ticketId: string; revision: number; subject: string }[];
}
/** Trusted synchronous policy lookup; any other result, including a Promise, denies admission. */
export interface MatchOptions {
  now: number; skillWindow: number; maxLatencyMs: number;
  canPair: (leftSubject: string, rightSubject: string) => unknown;
}
export const MAX_MATCH_TICKETS = 256;
/** Fail closed instead of allowing adversarial block graphs to monopolize a worker. */
export const MAX_MATCH_SEARCH_STEPS = 16_384;
const ticketSchema = createSchema({ ...partitionShape, ticketId: token(), revision: integer(0), subject: token(),
  region: slug(), minimumPlayers: integer(2, 4), maximumPlayers: integer(2, 4), createdAt: integer(0), expiresAt: integer(0),
  skill: integer(0, 10_000), latencyMs: integer(0, 2000),
}, "gameMatchTicket", envelope);

/** Validate a five-minute bounded ticket without interpreting it as an authorization grant. */
export function parseMatchTicket(raw: unknown): MatchTicket {
  const result = ticketSchema.validate(raw);
  if (!result.valid) throw new TypeError("invalid-match-ticket");
  const value = result.value as unknown as MatchTicket;
  if (value.minimumPlayers > value.maximumPlayers || value.expiresAt <= value.createdAt
    || value.expiresAt - value.createdAt > 300_000 || new Set(value.assistance).size !== value.assistance.length) throw new TypeError("invalid-match-ticket");
  value.assistance.sort();
  return value;
}
const partition = (ticket: MatchTicket): GamePartition => ({ gameId: ticket.gameId, modeId: ticket.modeId,
  rulesVersion: ticket.rulesVersion, contentVersion: ticket.contentVersion, difficulty: ticket.difficulty, assistance: [...ticket.assistance] });
const compatibilityKey = (ticket: MatchTicket) => JSON.stringify([partition(ticket), ticket.region, ticket.minimumPlayers, ticket.maximumPlayers]);
const within = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** Deterministic oldest-feasible matching; no storage, reservation, network request or hidden retry. */
export function planMatch(raw: unknown, options: MatchOptions): MatchPlan | null {
  if (!options || !within(options.now, Number.MAX_SAFE_INTEGER) || !within(options.skillWindow, 10_000)
    || !within(options.maxLatencyMs, 2000) || typeof options.canPair !== "function") throw new TypeError("invalid-match-options");
  if (!Array.isArray(raw) || raw.length > MAX_MATCH_TICKETS) throw new TypeError("invalid-match-queue");
  const tickets = raw.map(parseMatchTicket);
  if (new Set(tickets.map(ticket => ticket.ticketId)).size !== tickets.length
    || new Set(tickets.map(ticket => ticket.subject)).size !== tickets.length) throw new TypeError("invalid-match-queue");
  const eligible = tickets.filter(ticket => ticket.createdAt <= options.now && ticket.expiresAt > options.now && ticket.latencyMs <= options.maxLatencyMs)
    .sort((a, b) => a.createdAt - b.createdAt || (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0));
  const keys = new Map(eligible.map(ticket => [ticket.ticketId, compatibilityKey(ticket)]));
  const skillWindow = options.skillWindow;
  const canPair = options.canPair;
  const decisions = new Map<string, boolean>();
  let asynchronousPolicy = false;
  let searchSteps = 0;
  const countSearch = () => { if (++searchSteps > MAX_MATCH_SEARCH_STEPS) throw new RangeError("match-search-budget"); };
  const allowed = (a: MatchTicket, b: MatchTicket) => {
    try {
      const result = canPair(a.subject, b.subject);
      if (result !== null && typeof result === "object" && typeof (result as Promise<unknown>).then === "function") {
        // Unsupported async lookup fails the entire plan after one call; consume rejection safely.
        asynchronousPolicy = true; void Promise.resolve(result).catch(() => {}); return false;
      }
      return result === true;
    } catch { return false; }
  };
  const mutuallyAllowed = (a: MatchTicket, b: MatchTicket) => {
    if (Math.abs(a.skill - b.skill) > skillWindow) return false;
    const key = JSON.stringify([a.ticketId, b.ticketId].sort());
    let decision = decisions.get(key);
    if (decision === undefined) { decision = allowed(a, b) && allowed(b, a); decisions.set(key, decision); }
    return decision;
  };
  for (let index = 0; index < eligible.length; index++) {
    const leader = eligible[index]!;
    const group = [leader];
    const peers = eligible.slice(index + 1).filter(ticket => keys.get(ticket.ticketId) === keys.get(leader.ticketId));
    if (peers.length + 1 < leader.minimumPlayers) continue;
    const search = (start: number): boolean => {
      if (group.length >= leader.minimumPlayers) return true;
      for (let next = start; next < peers.length; next++) {
        if (peers.length - next < leader.minimumPlayers - group.length) break;
        countSearch();
        const candidate = peers[next]!;
        if (group.every(member => mutuallyAllowed(member, candidate))) {
          group.push(candidate);
          if (search(next + 1)) return true;
          group.pop();
        }
        if (asynchronousPolicy) return false;
      }
      return false;
    };
    const found = search(0);
    if (asynchronousPolicy) return null;
    if (!found) continue;
    for (const candidate of peers) {
      if (group.length === leader.maximumPlayers) break;
      if (group.includes(candidate)) continue;
      countSearch();
      if (group.every(member => mutuallyAllowed(member, candidate))) group.push(candidate);
      if (asynchronousPolicy) return null;
    }
    return { type: "gameMatchPlan", version: "1.0.0", ...partition(leader),
      region: leader.region, minimumPlayers: leader.minimumPlayers, maximumPlayers: leader.maximumPlayers,
      members: group.map(ticket => ({ ticketId: ticket.ticketId, revision: ticket.revision, subject: ticket.subject })) };
  }
  return null;
}
