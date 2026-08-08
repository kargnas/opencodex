import { useState } from "react";
import { useT } from "../i18n/shared";

/**
 * Self-contained manual login code / redirect-URL paste input for an in-flight
 * OAuth login. Providers whose registered callback is a loopback address
 * (e.g. Anthropic's fixed http://localhost:54545/callback) can never reach a
 * remote proxy's callback server, so pasting the full redirect URL into
 * POST /api/oauth/login/code is the only way to finish the flow from the web.
 * Owns its own input state so any surface (workspace panel, add-provider
 * modal, catalog account rows) can drop it in without threading a reducer.
 */
export function ManualLoginCodeInput({ apiBase, provider }: { apiBase: string; provider: string }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(true);

  const submit = async () => {
    const input = code.trim();
    if (!input || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, input }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setOk(false);
        setMsg(t("prov.pasteFail", { error: data.error || res.statusText }));
        return;
      }
      setCode("");
      setOk(true);
      setMsg(t("prov.pasteOk"));
    } catch {
      setOk(false);
      setMsg(t("modal.networkError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="muted text-label">{t("prov.pasteRedirectHint")}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t("prov.pasteRedirect")}
          aria-label={t("prov.pasteRedirect")}
          disabled={busy}
          className="input text-label"
          style={{ flex: 1 }}
        />
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy || !code.trim()}
          onClick={() => void submit()}
        >
          {busy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
        </button>
      </div>
      {msg && (
        <div className="text-label" style={{ color: ok ? "var(--accent-hover)" : "var(--amber)" }}>
          {msg}
        </div>
      )}
    </div>
  );
}
