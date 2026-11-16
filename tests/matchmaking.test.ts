import { describe, expect, it, vi } from "vitest";
import { parseMatchTicket, planMatch } from "../src/index.js";

const partition = { gameId: "vector-volley", modeId: "duel", rulesVersion: "1.0.0", contentVersion: "1.0.0", difficulty: "standard", assistance: [] };
const ticket = (id: string, changes = {}) => ({ type: "gameMatchTicket", version: "1.0.0", ...partition,
  ticketId: id, revision: 0, subject: `account-${id}`, region: "uksouth", minimumPlayers: 2, maximumPlayers: 2,
  createdAt: 1000, expiresAt: 6000, skill: 100, latencyMs: 50, ...changes });
const options = { now: 2000, skillWindow: 50, maxLatencyMs: 150, canPair: () => true };

describe("bounded compatible matchmaking plans", () => {
  it("selects the oldest feasible group deterministically and retains revisions for atomic host consumption", () => {
    const input = [ticket("z", { createdAt: 1200 }), ticket("c"), ticket("b"), ticket("a", { skill: 900 })];
    const before = structuredClone(input); const plan = planMatch(input, options);
    expect(plan).toMatchObject({ type: "gameMatchPlan", version: "1.0.0", ...partition, region: "uksouth",
      members: [{ ticketId: "b", revision: 0, subject: "account-b" }, { ticketId: "c", revision: 0, subject: "account-c" }] });
    expect(input).toEqual(before); expect(planMatch([...input].reverse(), options)).toEqual(plan);
    plan!.assistance.push("changed"); expect(input.every(value => value.assistance.length === 0)).toBe(true);
  });

  it("never matches across version, mode, difficulty, assistance or region partitions", () => {
    for (const change of [{ gameId: "other" }, { modeId: "doubles" }, { rulesVersion: "2.0.0" },
      { contentVersion: "2.0.0" }, { difficulty: "relaxed" }, { assistance: ["slow-motion"] },
      { region: "ukwest" }, { minimumPlayers: 3, maximumPlayers: 4 }, { maximumPlayers: 4 }]) {
      expect(planMatch([ticket("a"), ticket("b", change)], options)).toBeNull();
    }
    expect(planMatch([ticket("a", { assistance: ["aim", "slow"] }), ticket("b", { assistance: ["slow", "aim"] })], options)).not.toBeNull();
  });

  it("requires mutual affirmative policy and bounds unavailable, denied and asynchronous checks", () => {
    const input = [ticket("a"), ticket("b")];
    for (const canPair of [() => false, (a: string) => a === "account-a", () => { throw new Error("private detail"); }, () => Promise.resolve(true)]) {
      expect(planMatch(input, { ...options, canPair })).toBeNull();
    }
    const canPair = vi.fn(() => true); expect(planMatch(input, { ...options, canPair })).not.toBeNull();
    expect(canPair.mock.calls).toEqual([["account-a", "account-b"], ["account-b", "account-a"]]);
  });

  it("enforces expiry, queue limits, latency and all-pair skill windows", () => {
    expect(planMatch([], options)).toBeNull();
    for (const change of [{ expiresAt: 2000 }, { createdAt: 2001 }, { latencyMs: 151 }, { skill: 151 }]) {
      expect(planMatch([ticket("a"), ticket("b", change)], options)).toBeNull();
    }
    const four = [ticket("a", { minimumPlayers: 3, maximumPlayers: 4, skill: 100 }),
      ticket("b", { minimumPlayers: 3, maximumPlayers: 4, skill: 50 }),
      ticket("c", { minimumPlayers: 3, maximumPlayers: 4, skill: 150 })];
    expect(planMatch(four, options)).toBeNull();
    expect(() => planMatch(Array.from({ length: 257 }, (_, index) => ticket(`t${index}`)), options)).toThrow("invalid-match-queue");
    expect(() => planMatch([ticket("a"), ticket("a")], options)).toThrow("invalid-match-queue");
    expect(() => planMatch([ticket("a"), ticket("b", { subject: "account-a" })], options)).toThrow("invalid-match-queue");
  });

  it("rejects malformed and forged input before policy evaluation", () => {
    const policy = vi.fn(() => true);
    for (const change of [{ version: "2.0.0" }, { revision: -1 }, { subject: "email@example.test" },
      { score: 100 }, { expiresAt: 301_001 }, { minimumPlayers: 1 }, { minimumPlayers: 5 }, { assistance: ["aim", "aim"] }, { latencyMs: NaN }]) {
      expect(() => parseMatchTicket({ ...ticket("a"), ...change })).toThrow();
      expect(() => planMatch([{ ...ticket("a"), ...change }], { ...options, canPair: policy })).toThrow();
    }
    expect(policy).not.toHaveBeenCalled();
    for (const change of [{ now: -1 }, { skillWindow: NaN }, { maxLatencyMs: 2001 }, { canPair: null }]) {
      expect(() => planMatch([], { ...options, ...change } as any)).toThrow("invalid-match-options");
    }
  });

  it("does not let an incompatible early peer starve an older feasible group", () => {
    const input = ["a", "b", "c", "d"].map(id => ticket(id, { minimumPlayers: 3, maximumPlayers: 3 }));
    const canPair = (a: string, b: string) => !([a, b].includes("account-b") && [a, b].some(value => value === "account-c" || value === "account-d"));
    expect(planMatch(input, { ...options, canPair })?.members.map(member => member.ticketId)).toEqual(["a", "c", "d"]);
  });

  it("caps adversarial compatibility searches and consumes unsupported rejected policies", async () => {
    const input = Array.from({ length: 256 }, (_, index) => ticket(`t${index}`, { minimumPlayers: 4, maximumPlayers: 4 }));
    const canPair = vi.fn((a: string, b: string) => Number(a.slice(9)) % 3 !== Number(b.slice(9)) % 3);
    expect(() => planMatch(input, { ...options, canPair })).toThrow("match-search-budget");
    expect(canPair.mock.calls.length).toBeLessThanOrEqual(2 * 16_384 * 3);
    const asyncPolicy = vi.fn(() => Promise.reject(new Error("private detail")));
    expect(planMatch([ticket("a"), ticket("b"), ticket("c")], { ...options, canPair: asyncPolicy })).toBeNull();
    await Promise.resolve(); expect(asyncPolicy).toHaveBeenCalledOnce();
    const full = ["a", "b", "c", "d"].map(id => ticket(id, { maximumPlayers: 4 }));
    expect(planMatch(full, options)?.members).toHaveLength(4);
  });
});
