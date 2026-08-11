import { afterEach, describe, expect, test } from "bun:test";
import { codexWsUpstreamFetch, shouldUseCodexWsUpstream } from "../src/server/responses/ws-upstream";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

function streamingInit(body: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, ...body }),
  };
}

describe("shouldUseCodexWsUpstream", () => {
  test("matches only streaming POSTs to the Codex backend", () => {
    expect(shouldUseCodexWsUpstream(CODEX_URL, streamingInit())).toBe(true);
    // Non-streaming turns keep HTTP: the WS path only speaks the event protocol.
    expect(shouldUseCodexWsUpstream(CODEX_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    })).toBe(false);
    expect(shouldUseCodexWsUpstream(CODEX_URL, { method: "GET" })).toBe(false);
    expect(shouldUseCodexWsUpstream("https://api.openai.com/v1/responses", streamingInit())).toBe(false);
    // Body must be the adapter's serialized string, not a stream.
    expect(shouldUseCodexWsUpstream(CODEX_URL, { method: "POST", body: new Blob(["x"]) as unknown as string })).toBe(false);
  });
});

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  url: string;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => FakeWebSocket.script(this));
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
}

const RealWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

describe("codexWsUpstreamFetch", () => {
  test("relays event frames as an SSE response and sends one response.create frame", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "codex.rate_limits", limits: {} }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.output_text.delta", delta: "hi" }) });
      ws.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: "r1" } }) });
    });
    const fallback = () => { throw new Error("fallback must not run"); };
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback as unknown as typeof fetch);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    // WS-only frames are dropped so clients see the exact SSE surface they always got.
    expect(text).not.toContain("codex.rate_limits");
    expect(text).toContain("event: response.created");
    expect(text).toContain('data: {"type":"response.output_text.delta","delta":"hi"}');
    expect(text).toContain("event: response.completed");

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]) as Record<string, unknown>;
    expect(frame.type).toBe("response.create");
    // The HTTP-only stream flag must not reach the WS create frame.
    expect("stream" in frame).toBe(false);
    expect(ws.closed).toBe(true);
  });

  test("falls back to the HTTP fetch when the upgrade is rejected before open", async () => {
    installFake(ws => ws.close());
    const sentinel = new Response("sse-fallback", { status: 429 });
    let fallbackCalls = 0;
    const fallback = (async () => {
      fallbackCalls += 1;
      return sentinel;
    }) as unknown as typeof fetch;
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback);
    // The real HTTP status must reach the existing refresh/rotation handlers.
    expect(response).toBe(sentinel);
    expect(fallbackCalls).toBe(1);
  });

  test("closes the stream when the socket drops mid-stream", async () => {
    installFake(ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      ws.close();
    });
    const fallback = () => { throw new Error("fallback must not run after open"); };
    const response = await codexWsUpstreamFetch(CODEX_URL, streamingInit(), fallback as unknown as typeof fetch);
    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).not.toContain("response.completed");
  });

  test("defaults the originator header and websocket beta on the handshake", async () => {
    // The fast lane keys on WS + originator; callers without the tag must still get it.
    const seen: Record<string, string>[] = [];
    FakeWebSocket.script = ws => {
      ws.emit("open", {});
      ws.emit("message", { data: JSON.stringify({ type: "response.completed", response: {} }) });
    };
    class HeaderCapturingWebSocket extends FakeWebSocket {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        super(url);
        seen.push(options?.headers ?? {});
      }
    }
    globalThis.WebSocket = HeaderCapturingWebSocket as unknown as typeof WebSocket;

    await codexWsUpstreamFetch(CODEX_URL, streamingInit(), (() => {
      throw new Error("fallback must not run");
    }) as unknown as typeof fetch);
    expect(seen).toHaveLength(1);
    expect(seen[0].originator).toBe("codex_cli_rs");
    expect(seen[0]["openai-beta"]).toContain("responses_websockets");
    expect(seen[0].authorization).toBe("Bearer test");
    // HTTP body-framing headers do not belong on a WS handshake.
    expect(seen[0]["content-type"]).toBeUndefined();
  });

  test("aborting before open rejects like an aborted fetch", async () => {
    installFake(() => { /* never opens */ });
    const controller = new AbortController();
    const promise = codexWsUpstreamFetch(CODEX_URL, { ...streamingInit(), signal: controller.signal }, (() => {
      throw new Error("fallback must not run");
    }) as unknown as typeof fetch);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});
