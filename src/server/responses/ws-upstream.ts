// Upstream WebSocket transport for the ChatGPT Codex backend.
//
// Why this exists: the Codex backend serves the responses_websockets path from
// a measurably faster queue than the plain SSE POST path. Measured 2026-08-12
// (same account, same payload, strictly sequential): gpt-5.6-luna TTFT p50
// ~1.0s over WS vs ~3.9s over SSE. Codex CLI itself defaults to the WS
// transport; opencodex previously always POSTed SSE, which is where its extra
// 2-3s of TTFT came from.
//
// The wrapper only swaps the transport. It dials wss:// with the same headers,
// sends the JSON body as a single `response.create` frame, and re-encodes the
// returned event frames as an SSE byte stream, so every downstream consumer
// (passthrough relay, adapter parsers, usage sniffing) is unchanged.

const CODEX_RESPONSES_HTTP_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RESPONSES_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
const WS_BETA = "responses_websockets=2026-02-06";
// If the 101 never arrives (network black hole), give SSE a chance well before
// the caller's connect timeout (default 200s) would fire.
const UPGRADE_DEADLINE_MS = 10_000;

export function shouldUseCodexWsUpstream(url: string, init?: RequestInit): boolean {
  if (url !== CODEX_RESPONSES_HTTP_URL) return false;
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  const body = init?.body;
  if (typeof body !== "string") return false;
  // Turn requests always stream. JSON-mode calls (no stream flag) keep the
  // HTTP path because the WS path only speaks the event protocol. The body is
  // adapter-built JSON.stringify output, so the compact form is exact.
  return body.includes("\"stream\":true");
}

export function codexWsUpstreamFetch(
  url: string,
  init: RequestInit,
  sseFallback: typeof globalThis.fetch,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  }

  let frameText: string;
  try {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The WS create frame is implicitly streaming; the backend rejects the
    // HTTP-only `stream` flag inside a frame.
    delete body.stream;
    frameText = JSON.stringify({ ...body, type: "response.create" });
  } catch {
    return sseFallback(url, init);
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, key) => {
    // HTTP-body framing headers do not apply to a WS handshake.
    if (key === "content-type" || key === "content-length" || key === "accept" || key === "accept-encoding") return;
    headers[key] = value;
  });
  headers["openai-beta"] = headers["openai-beta"]
    ? headers["openai-beta"].includes("responses_websockets")
      ? headers["openai-beta"]
      : `${headers["openai-beta"]}, ${WS_BETA}`
    : WS_BETA;
  // The backend keys its fast lane on the originator tag, not just the WS
  // transport: measured 60KB turns run ~1.5s with `codex_cli_rs` vs ~4.6s
  // without. Codex CLI always sends it; default it for SDK-style callers.
  if (!headers.originator) headers.originator = "codex_cli_rs";

  return new Promise<Response>((resolve, reject) => {
    let ws: WebSocket;
    try {
      // Bun accepts per-handshake headers; the DOM lib types only list protocol arrays.
      ws = new WebSocket(CODEX_RESPONSES_WS_URL, { headers } as unknown as string[]);
    } catch {
      resolve(sseFallback(url, init));
      return;
    }

    let opened = false;
    let settledPreOpen = false;
    let terminal = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();

    const upgradeTimer = setTimeout(() => {
      if (opened || settledPreOpen) return;
      settledPreOpen = true;
      try { ws.close(); } catch { /* already closing */ }
      resolve(sseFallback(url, init));
    }, UPGRADE_DEADLINE_MS);

    const onAbort = () => {
      if (!opened) {
        if (settledPreOpen) return;
        // Settle BEFORE close(): the close handler treats a pre-open close as
        // an upgrade rejection and would dial the SSE fallback for a request
        // the caller just cancelled.
        settledPreOpen = true;
        clearTimeout(upgradeTimer);
        try { ws.close(); } catch { /* already closing */ }
        reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      try { ws.close(); } catch { /* already closing */ }
      if (controller && !terminal) {
        terminal = true;
        // Mirror an aborted fetch: the body read rejects with the abort reason.
        try { controller.error(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")); } catch { /* stream already done */ }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      if (settledPreOpen) return;
      opened = true;
      clearTimeout(upgradeTimer);
      const stream = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        cancel() { try { ws.close(); } catch { /* already closing */ } },
      });
      try {
        ws.send(frameText);
      } catch {
        // send() throwing means the frame never left, so no turn started; the
        // stream error routes the caller into its normal transport-retry path.
        if (controller && !terminal) {
          terminal = true;
          try { controller.error(new Error("codex websocket send failed")); } catch { /* noop */ }
        }
        try { ws.close(); } catch { /* noop */ }
      }
      resolve(new Response(stream, {
        status: 200,
        // The 101 response headers (x-codex-*-reset-at quota hints) are not
        // exposed by Bun's WebSocket; the periodic quota poller covers those.
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }));
    });

    ws.addEventListener("message", (event) => {
      if (!controller || terminal) return;
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      let type: unknown;
      try { type = (JSON.parse(text) as { type?: unknown }).type; } catch { return; }
      if (typeof type !== "string") return;
      // Relay only the event surface the SSE path produces today. WS-only
      // frames (codex.rate_limits, responsesapi.websocket_timing) are dropped
      // so downstream clients see exactly the stream shape they always got.
      if (!type.startsWith("response.") && type !== "error") return;
      try {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${text}\n\n`));
      } catch {
        return;
      }
      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "error") {
        terminal = true;
        try { controller.close(); } catch { /* already closed */ }
        try { ws.close(); } catch { /* already closing */ }
      }
    });

    ws.addEventListener("close", () => {
      signal?.removeEventListener("abort", onAbort);
      if (!opened) {
        if (settledPreOpen) return;
        settledPreOpen = true;
        clearTimeout(upgradeTimer);
        // Upgrade rejected (401/403/429/5xx). Retry over plain SSE so the real
        // HTTP status reaches the existing refresh/rotation handlers. No turn
        // started upstream, so the resend cannot double-generate.
        resolve(sseFallback(url, init));
        return;
      }
      if (controller && !terminal) {
        terminal = true;
        // Connection dropped mid-stream: close like an SSE socket drop and let
        // the caller's incomplete/stall handling take over.
        try { controller.close(); } catch { /* already closed */ }
      }
    });

    ws.addEventListener("error", () => {
      /* Bun always follows error with close; the close handler settles. */
    });
  });
}
