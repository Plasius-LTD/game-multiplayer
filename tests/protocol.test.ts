import { describe, expect, it } from "vitest";
import { parseClientFrame, parseServerFrame, MAX_CLIENT_FRAME_BYTES, MAX_SERVER_FRAME_BYTES } from "../src/index.js";

export const intentFrame = (changes: Record<string, unknown> = {}) => ({ type: "gameClientFrame", version: "1.0.0",
  roomId: "room-a", generation: 1, kind: "intent", intentJson: JSON.stringify({ playerId: "p1", tick: 1, sequence: 1 }), ...changes });
const signal = { type: "gameClientFrame", version: "1.0.0", roomId: "room-a", generation: 1, kind: "signal", signal: "thanks", sequence: 1 };
export const snapshotFrame = (changes: Record<string, unknown> = {}) => ({ type: "gameServerFrame", version: "1.0.0",
  roomId: "room-a", epoch: 1, sequence: 1, kind: "snapshot", tick: 1, stateJson: '{"position":1}', ...changes });

describe("bounded multiplayer wire contracts", () => {
  it("round-trips versioned intentions and preset signals without claiming game validation", () => {
    expect(parseClientFrame(JSON.stringify(intentFrame()))).toEqual(intentFrame());
    expect(parseClientFrame(signal)).toEqual(signal);
    // The runtime owns intent semantics; this parser only validates the bounded JSON carrier.
    expect(parseClientFrame(intentFrame({ intentJson: '{"future":true}' })).kind).toBe("intent");
    for (const raw of [{ ...signal, signal: "free chat" }, { ...signal, score: 10 }, { ...signal, sequence: -1 },
      intentFrame({ state: {} }), intentFrame({ version: "2.0.0" }), intentFrame({ generation: 0 }),
      intentFrame({ kind: "authority" }), intentFrame({ intentJson: "{" }), intentFrame({ intentJson: "x".repeat(2049) }),
      intentFrame({ intentJson: JSON.stringify("é".repeat(1100)) }), {}, null, false, "{", " ".repeat(MAX_CLIENT_FRAME_BYTES + 1)]) {
      expect(() => parseClientFrame(raw)).toThrow();
    }
  });

  it("accepts server snapshots/signals and rejects extra identities, future versions and byte overflow", () => {
    expect(parseServerFrame(JSON.stringify(snapshotFrame()))).toEqual(snapshotFrame());
    const event = { type: "gameServerFrame", version: "1.0.0", roomId: "room-a", epoch: 2, sequence: 4,
      kind: "signal", playerId: "p2", signal: "nice" };
    expect(parseServerFrame(event)).toEqual(event);
    for (const raw of [snapshotFrame({ subject: "private-account" }), snapshotFrame({ stateJson: "{" }),
      snapshotFrame({ sequence: NaN }), snapshotFrame({ tick: -1 }), snapshotFrame({ epoch: 0 }),
      snapshotFrame({ type: "gameClientFrame" }), snapshotFrame({ stateJson: JSON.stringify("é".repeat(25_000)) }),
      snapshotFrame({ stateJson: JSON.stringify("\\".repeat(20_000)) }), { ...event, signal: "custom" },
      { ...event, playerId: "p5" }, { ...event, connectionId: "private-connection" },
      "x".repeat(MAX_SERVER_FRAME_BYTES + 1), "\"" + "é".repeat(MAX_SERVER_FRAME_BYTES / 2) + "\"", undefined]) {
      expect(() => parseServerFrame(raw)).toThrow();
    }
  });
});
