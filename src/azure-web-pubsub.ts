import { createSchema } from "@plasius/schema";
import { exact, integer, token } from "./contracts.js";
import { MAX_SERVER_FRAME_BYTES, parseClientFrame, parseServerFrame, readBoundedJson, type ServerFrame } from "./protocol.js";

/** Provider protocol, deliberately isolated from the provider-neutral package entry. */
export const WEB_PUBSUB_PROTOCOL = "json.webpubsub.azure.v1";
/** Minimal native WebSocket port; injection permits protocol tests without a cloud credential. */
export interface WebPubSubSocket {
  readonly protocol: string; readonly readyState: number; readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
export type TransportCloseReason = "disposed" | "cancelled" | "handshake-timeout" | "ack-timeout" | "heartbeat-timeout" | "protocol" | "socket" | "consumer" | "remote";
export interface TransportStatus { state: "connecting" | "ready" | "closed"; pending: number; reason?: TransportCloseReason }
/** Acknowledged means provider receipt, not authoritative game acceptance or persisted progress. */
export interface TransportSendResult { status: "acknowledged" | "rejected" | "unconfirmed" | "backpressure" | "invalid" | "not-ready" | "closed" }
export interface WebPubSubOptions {
  /** Short-lived host-issued negotiation. Never log, persist or return this credential URL. */
  url: string; expiresAt: number; serviceOrigin: string; hub: string;
  roomId: string; generation: number; epoch: number;
  /** Synchronous bounded delivery; consumers own game-specific projection validation. */
  onFrame(frame: ServerFrame): unknown;
  signal?: AbortSignal;
  createSocket?(url: string, protocol: string): WebPubSubSocket;
  handshakeTimeoutMs?: number; ackTimeoutMs?: number; idleTimeoutMs?: number;
  maxPending?: number; maxBufferedBytes?: number;
}
const settingsSchema = createSchema({ roomId: token(), generation: integer(1), epoch: integer(1), expiresAt: integer(0),
  handshakeTimeoutMs: integer(100, 10_000), ackTimeoutMs: integer(100, 10_000), idleTimeoutMs: integer(1000, 60_000),
  maxPending: integer(1, 64), maxBufferedBytes: integer(4096, 256 * 1024),
}, "gameWebPubSubSettings", exact);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function settings(options: WebPubSubOptions) {
  try {
    const at = Date.now();
    if (!options || typeof options.url !== "string" || options.url.length > 16_384 || typeof options.onFrame !== "function"
      || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(options.hub)
      || (options.createSocket !== undefined && typeof options.createSocket !== "function")
      || (options.signal !== undefined && (typeof options.signal.aborted !== "boolean"
        || typeof options.signal.addEventListener !== "function" || typeof options.signal.removeEventListener !== "function"))) throw new Error();
    const origin = new URL(options.serviceOrigin);
    const url = new URL(options.url);
    if (origin.protocol !== "wss:" || !/^[a-z0-9][a-z0-9-]{0,62}\.webpubsub\.azure\.com$/.test(origin.hostname)
      || origin.port || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
      || url.origin !== origin.origin || url.username || url.password || url.hash || url.pathname !== `/client/hubs/${options.hub}`
      || [...url.searchParams.keys()].length !== 1 || !url.searchParams.get("access_token")) throw new Error();
    const result = settingsSchema.validate({ roomId: options.roomId, generation: options.generation, epoch: options.epoch, expiresAt: options.expiresAt,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5000, ackTimeoutMs: options.ackTimeoutMs ?? 2500,
      idleTimeoutMs: options.idleTimeoutMs ?? 15_000, maxPending: options.maxPending ?? 32, maxBufferedBytes: options.maxBufferedBytes ?? 64 * 1024 });
    if (!result.valid || !result.value || result.value.expiresAt <= at || result.value.expiresAt - at > 60_000) throw new Error();
    return result.value;
  } catch { throw new TypeError("invalid-transport-options"); }
}

/**
 * One connection, bounded provider acknowledgements, no automatic replay/reconnect.
 * The host must grant no client group roles and route `arcade` events through auth/authority.
 */
export function connectWebPubSub(options: WebPubSubOptions) {
  const config = settings(options);
  const onFrame = options.onFrame;
  const signal = options.signal;
  const factory = options.createSocket ?? ((url: string, protocol: string) => new WebSocket(url, protocol));
  let state: TransportStatus["state"] = "connecting";
  let reason: TransportCloseReason | undefined;
  let socket: WebPubSubSocket | undefined;
  let opened = false;
  let ackId = 0;
  let epoch = config.epoch;
  let sequence = 0;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let awaitingPong = false;
  const pending = new Map<number, { resolve: (result: TransportSendResult) => void; timer: ReturnType<typeof setTimeout> }>();
  let settleReady!: (connected: boolean) => void;
  let settleClosed!: (reason: TransportCloseReason) => void;
  const ready = new Promise<boolean>(resolve => { settleReady = resolve; });
  const closed = new Promise<TransportCloseReason>(resolve => { settleClosed = resolve; });
  const isClosed = () => state === "closed";
  function close(why: TransportCloseReason): void {
    if (isClosed()) return;
    state = "closed"; reason = why;
    clearTimeout(handshake); clearTimeout(heartbeat);
    signal?.removeEventListener("abort", onAbort);
    for (const [type, handler] of handlers) socket?.removeEventListener(type, handler);
    for (const work of pending.values()) { clearTimeout(work.timer); work.resolve({ status: "unconfirmed" }); }
    pending.clear(); settleReady(false); settleClosed(why);
    try { socket?.close(1000); } catch { /* No provider error or URL is retained. */ }
  }
  function pingLater(): void {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      if (state !== "ready") return;
      if (awaitingPong) { close("heartbeat-timeout"); return; }
      awaitingPong = true;
      try {
        if (!socket || socket.readyState !== 1 || socket.bufferedAmount + 15 > config.maxBufferedBytes) throw new Error();
        socket.send('{"type":"ping"}');
      } catch { close("socket"); return; }
      pingLater();
    }, config.idleTimeoutMs / 2);
  }
  const onAbort = () => close("cancelled");
  const onOpen = () => {
    if (isClosed()) return;
    if (opened || socket?.protocol !== WEB_PUBSUB_PROTOCOL || Date.now() >= config.expiresAt) { close("protocol"); return; }
    opened = true;
  };
  function receive(event: Event): void {
    if (isClosed()) return;
    try {
      const raw = (event as MessageEvent).data as unknown;
      if (typeof raw !== "string") throw new Error();
      const value = readBoundedJson(raw, MAX_SERVER_FRAME_BYTES + 1024);
      if (!object(value)) throw new Error();
      if (value.type === "system") {
        if (value.event === "disconnected" && keys(value, ["type", "event", "message"])) { close("remote"); return; }
        if (value.event !== "connected" || state !== "connecting" || !opened || Date.now() >= config.expiresAt
          || !keys(value, ["type", "event", "userId", "connectionId"]) || typeof value.connectionId !== "string"
          || value.connectionId.length < 1 || value.connectionId.length > 256 || (value.userId !== undefined && typeof value.userId !== "string")) throw new Error();
        state = "ready"; clearTimeout(handshake); settleReady(true); pingLater(); return;
      }
      if (state !== "ready") throw new Error();
      if (value.type === "ack") {
        if (!keys(value, ["type", "ackId", "success", "error"]) || !positive(value.ackId) || typeof value.success !== "boolean") throw new Error();
        const work = pending.get(value.ackId);
        if (work) { clearTimeout(work.timer); pending.delete(value.ackId); work.resolve({ status: value.success ? "acknowledged" : "rejected" }); }
        return;
      }
      if (value.type === "pong" && keys(value, ["type"])) { awaitingPong = false; return; }
      if (value.type !== "message" || value.from !== "server" || value.dataType !== "json" || !keys(value, ["type", "from", "dataType", "data"])) throw new Error();
      const frame = parseServerFrame(value.data);
      if (frame.roomId !== config.roomId) throw new Error();
      if (frame.epoch < epoch || (frame.epoch === epoch && frame.sequence <= sequence)) return;
      epoch = frame.epoch; sequence = frame.sequence;
      try {
        const result = onFrame(frame);
        if (result && typeof result === "object" && typeof (result as Promise<unknown>).then === "function") {
          void Promise.resolve(result).catch(() => {}); close("consumer");
        }
      } catch { close("consumer"); }
    } catch { close("protocol"); }
  }
  const handlers: [string, EventListener][] = [["open", onOpen], ["message", receive], ["error", () => close("socket")], ["close", () => close("remote")]];
  if (signal?.aborted) close("cancelled");
  else {
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      socket = factory(options.url, WEB_PUBSUB_PROTOCOL);
      if (isClosed()) socket.close(1000);
      else {
        for (const [type, handler] of handlers) socket.addEventListener(type, handler);
        handshake = setTimeout(() => close("handshake-timeout"), Math.min(config.handshakeTimeoutMs, config.expiresAt - Date.now()));
      }
    } catch { close("socket"); }
  }
  return {
    ready, closed,
    status(): TransportStatus { return { state, pending: pending.size, ...(reason ? { reason } : {}) }; },
    send(raw: unknown): Promise<TransportSendResult> {
      if (state !== "ready") return Promise.resolve({ status: isClosed() ? "closed" : "not-ready" });
      let frame;
      try { frame = parseClientFrame(raw); } catch { return Promise.resolve({ status: "invalid" }); }
      if (frame.roomId !== config.roomId || frame.generation !== config.generation) return Promise.resolve({ status: "invalid" });
      if (!socket || socket.readyState !== 1 || ackId === Number.MAX_SAFE_INTEGER) { close("socket"); return Promise.resolve({ status: "closed" }); }
      const next = ackId + 1;
      const payload = JSON.stringify({ type: "event", event: "arcade", dataType: "json", ackId: next, data: frame });
      if (pending.size >= config.maxPending || socket.bufferedAmount + new TextEncoder().encode(payload).byteLength > config.maxBufferedBytes) return Promise.resolve({ status: "backpressure" });
      ackId = next;
      const result = new Promise<TransportSendResult>(resolve => {
        const timer = setTimeout(() => close("ack-timeout"), config.ackTimeoutMs);
        pending.set(next, { resolve, timer });
      });
      try { socket.send(payload); } catch { close("socket"); }
      return result;
    },
    dispose: () => close("disposed"),
  };
}
