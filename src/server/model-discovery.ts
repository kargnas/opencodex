export type ModelDiscoveryFlavor = "anthropic" | "codex" | "openai";

export function modelDiscoveryFlavor(url: URL, headers: Headers): ModelDiscoveryFlavor {
  if (url.searchParams.has("client_version")) return "codex";
  if (headers.has("anthropic-version") || url.searchParams.get("flavor") === "anthropic") return "anthropic";
  return "openai";
}
