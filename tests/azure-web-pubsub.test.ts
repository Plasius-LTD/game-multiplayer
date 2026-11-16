import { afterEach, describe, expect, it, vi } from "vitest";
import { connectWebPubSub, WEB_PUBSUB_PROTOCOL } from "../src/azure-web-pubsub.js";

class Socket extends EventTarget {
  protocol = "json.webpubsub.azure.v1"; readyState = 0; bufferedAmount = 0;
  send = vi.fn((_data: string) => {}); close = vi.fn(() => { this.readyState = 3; });
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) })); }
  connected() { this.open(); this.message({ type: "system", event: "connected", connectionId: "provider-connection", userId: "private-subject" }); }
}
const input = (changes: Record<string, unknown> = {}) => ({ type: "gameClientFrame", version: "1.0.0", roomId: "room-a", generation: 1,
  kind: "intent", intentJson: '{"playerId":"p1","tick":1,"sequence":1}', ...changes });
const snapshot = (changes: Record<string, unknown> = {}) => ({ type: "gameServerFrame", version: "1.0.0", roomId: "room-a", epoch: 2,
  sequence: 1, kind: "snapshot", tick: 1, stateJson: '{"position":3}', ...changes });
const message = (changes: Record<string, unknown> = {}) => ({ type: "message", from: "server", dataType: "json", data: snapshot(), ...changes });
const setup = (changes: Record<string, unknown> = {}) => {
  const socket = new Socket(); const onFrame = vi.fn(); const controller = new AbortController();
  const createSocket = vi.fn(() => socket);
  const options = { url: "wss://arcade-fixture.webpubsub.azure.com/client/hubs/arcade?access_token=fixture",
    serviceOrigin: "wss://arcade-fixture.webpubsub.azure.com", hub: "arcade", expiresAt: Date.now() + 30_000,
    roomId: "room-a", generation: 1, epoch: 2, onFrame, createSocket, signal: controller.signal,
    handshakeTimeoutMs: 1000, ackTimeoutMs: 500, idleTimeoutMs: 2000, ...changes };
  return { transport: connectWebPubSub(options), socket, onFrame, createSocket, controller, options };
};
afterEach(() => { vi.useRealTimers(); });

describe("Azure Web PubSub event transport", () => {
  it("waits for provider connection confirmation and sends only server-routed events", async () => {
    vi.useFakeTimers(); const { transport, socket, createSocket } = setup();
    expect(createSocket).toHaveBeenCalledWith(expect.stringContaining("wss://arcade-fixture.webpubsub.azure.com/"), WEB_PUBSUB_PROTOCOL);
    expect(await transport.send(input())).toEqual({ status: "not-ready" });
    socket.open(); expect(transport.status().state).toBe("connecting");
    socket.message({ type: "system", event: "connected", connectionId: "provider-connection" });
    expect(await transport.ready).toBe(true); expect(transport.status()).toEqual({ state: "ready", pending: 0 });
    const pending = transport.send(input());
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({ type: "event", event: "arcade", dataType: "json", ackId: 1, data: input() });
    socket.message({ type: "ack", ackId: 1, success: true });
    expect(await pending).toEqual({ status: "acknowledged" });
    const rejected = transport.send(input()); socket.message({ type: "ack", ackId: 2, success: false, error: { name: "Forbidden", message: "private detail" } });
    expect(await rejected).toEqual({ status: "rejected" });
    transport.dispose(); expect(await transport.closed).toBe("disposed"); expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers ordered server frames, fences old epochs and suppresses replay", async () => {
    vi.useFakeTimers(); const { transport, socket, onFrame } = setup(); socket.connected(); await transport.ready;
    socket.message(message()); socket.message(message()); socket.message(message({ data: snapshot({ epoch: 1, sequence: 100 }) }));
    socket.message(message({ data: snapshot({ epoch: 3 }) })); socket.message(message({ data: snapshot({ epoch: 2, sequence: 200 }) }));
    expect(onFrame.mock.calls).toEqual([[snapshot()], [snapshot({ epoch: 3 })]]);
    socket.message(message({ data: snapshot({ roomId: "other", epoch: 4 }) }));
    expect(await transport.closed).toBe("protocol"); expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("rejects forged group updates and malformed provider envelopes without leaking values", async () => {
    vi.useFakeTimers();
    for (const raw of [message({ from: "group", group: "room-a", fromUserId: "attacker" }), message({ dataType: "text" }),
      message({ data: snapshot({ score: 999 }) }), { type: "ack", ackId: 1, success: "true" }, { type: "unknown" }, "{",
      "x".repeat(70_000), { type: "system", event: "connected" }]) {
      const { transport, socket, onFrame } = setup(); socket.connected(); await transport.ready; socket.message(raw);
      expect(await transport.closed).toBe("protocol"); expect(onFrame).not.toHaveBeenCalled();
      expect(JSON.stringify(transport.status())).not.toContain("attacker");
    }
    const binary = setup(); binary.socket.connected(); binary.socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(4) }));
    expect(await binary.transport.closed).toBe("protocol");
  });

  it("bounds outstanding acknowledgements and socket buffering with no hidden queue", async () => {
    vi.useFakeTimers(); const { transport, socket } = setup({ maxPending: 1, maxBufferedBytes: 4096 }); socket.connected();
    const first = transport.send(input()); expect(await transport.send(input())).toEqual({ status: "backpressure" });
    expect(transport.status().pending).toBe(1); socket.message({ type: "ack", ackId: 1, success: true }); await first;
    socket.bufferedAmount = 4096; expect(await transport.send(input())).toEqual({ status: "backpressure" });
    socket.bufferedAmount = 0;
    for (const raw of [input({ roomId: "other" }), input({ generation: 2 }), input({ score: 100 })]) expect(await transport.send(raw)).toEqual({ status: "invalid" });
    expect(socket.send).toHaveBeenCalledOnce(); transport.dispose();
  });

  it("closes on a missing ack and preserves an unconfirmed outcome without replaying", async () => {
    vi.useFakeTimers(); const { transport, socket } = setup(); socket.connected();
    const first = transport.send(input()); const second = transport.send(input());
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toEqual({ status: "unconfirmed" }); expect(await second).toEqual({ status: "unconfirmed" });
    expect(await transport.closed).toBe("ack-timeout"); expect(socket.send).toHaveBeenCalledTimes(2);
    socket.message({ type: "ack", ackId: 1, success: true }); socket.message(message());
    expect(await transport.send(input())).toEqual({ status: "closed" }); expect(vi.getTimerCount()).toBe(0);
  });

  it("has handshake, heartbeat and cancellation deadlines with no automatic reconnect", async () => {
    vi.useFakeTimers(); const a = setup(); await vi.advanceTimersByTimeAsync(1000);
    expect(await a.transport.ready).toBe(false); expect(await a.transport.closed).toBe("handshake-timeout"); expect(a.createSocket).toHaveBeenCalledOnce();
    const b = setup(); b.socket.connected(); await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(b.socket.send.mock.calls[0]![0])).toEqual({ type: "ping" });
    b.socket.message({ type: "pong" }); await vi.advanceTimersByTimeAsync(1000);
    expect(b.socket.send).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(1000);
    expect(await b.transport.closed).toBe("heartbeat-timeout");
    const c = setup(); c.socket.connected(); const pending = c.transport.send(input()); c.controller.abort();
    expect(await c.transport.closed).toBe("cancelled"); expect(await pending).toEqual({ status: "unconfirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires a secure exact service endpoint, current negotiation and bounded settings", () => {
    vi.useFakeTimers();
    for (const changes of [{ url: "ws://arcade-fixture.webpubsub.azure.com/client/hubs/arcade?access_token=fixture" },
      { url: "wss://other.webpubsub.azure.com/client/hubs/arcade?access_token=fixture" },
      { url: "wss://arcade-fixture.webpubsub.azure.com/client/hubs/other?access_token=fixture" },
      { url: "wss://arcade-fixture.webpubsub.azure.com/client/hubs/arcade?access_token=fixture#extra" },
      { url: "invalid" }, { serviceOrigin: "wss://custom.example" }, { serviceOrigin: "wss://arcade-fixture.webpubsub.azure.com/extra" },
      { expiresAt: Date.now() }, { expiresAt: Date.now() + 61_000 }, { maxPending: 65 }, { maxBufferedBytes: 1 },
      { ackTimeoutMs: 0 }, { handshakeTimeoutMs: 20_000 }, { idleTimeoutMs: 500 }, { generation: 0 }, { epoch: 0 }, { hub: "../escape" }]) {
      expect(() => setup(changes)).toThrow(/invalid-transport-options/);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes socket and callback faults, and ignores late callbacks after close", async () => {
    vi.useFakeTimers(); const a = setup({ createSocket: () => { throw new Error("secret URL"); } });
    expect(await a.transport.ready).toBe(false); expect(await a.transport.closed).toBe("socket");
    const b = setup(); b.socket.protocol = "wrong"; b.socket.open(); expect(await b.transport.closed).toBe("protocol");
    const c = setup(); c.socket.connected(); c.onFrame.mockImplementation(() => { throw new Error("private state"); });
    c.socket.message(message()); expect(await c.transport.closed).toBe("consumer");
    c.socket.message(message({ data: snapshot({ sequence: 2 }) })); expect(c.onFrame).toHaveBeenCalledOnce();
    const d = setup(); d.socket.connected(); d.socket.send.mockImplementation(() => { throw new Error("private error"); });
    expect(await d.transport.send(input())).toEqual({ status: "unconfirmed" }); expect(await d.transport.closed).toBe("socket");
    const e = setup(); e.socket.connected(); e.socket.message({ type: "system", event: "disconnected", message: "private reason" });
    expect(await e.transport.closed).toBe("remote");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up early aborts, async consumers and transport loss without admitting late frames", async () => {
    vi.useFakeTimers(); const controller = new AbortController(); controller.abort();
    const a = setup({ signal: controller.signal }); expect(await a.transport.closed).toBe("cancelled"); expect(a.createSocket).not.toHaveBeenCalled();
    const b = setup({ onFrame: () => Promise.reject(new Error("private consumer detail")) });
    b.socket.connected(); b.socket.message(message()); expect(await b.transport.closed).toBe("consumer"); await Promise.resolve();
    const c = setup(); c.socket.dispatchEvent(new Event("error")); expect(await c.transport.closed).toBe("socket");
    const d = setup(); d.socket.connected(); d.socket.dispatchEvent(new Event("close")); expect(await d.transport.closed).toBe("remote");
    const e = setup(); e.socket.connected(); e.socket.bufferedAmount = 256 * 1024;
    await vi.advanceTimersByTimeAsync(1000); expect(await e.transport.closed).toBe("socket");
    const f = setup(); f.socket.connected(); f.socket.message({ type: "ack", ackId: 999, success: true });
    expect(f.transport.status().pending).toBe(0); f.transport.dispose(); f.transport.dispose();
    expect(f.socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
