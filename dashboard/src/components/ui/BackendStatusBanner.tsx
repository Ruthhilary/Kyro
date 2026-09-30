"use client";

/**
 * BackendStatusBanner
 *
 * Only shown in Live mode. Pings the backend /health endpoint on an
 * interval; if it's unreachable, shows a fixed-top banner so users
 * understand why data isn't loading (instead of staring at silent
 * network errors in devtools).
 */

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

const CHECK_INTERVAL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 3_000;

function isLiveMode(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem("kyro_mode") === "live"; } catch { return false; }
}

async function pingHealth(): Promise<boolean> {
  const url = (process.env.NEXT_PUBLIC_API_URL ?? "") + "/health";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function BackendStatusBanner() {
  const [live, setLive]   = useState(false);
  const [down, setDown]   = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setLive(isLiveMode());
    const onStorage = () => setLive(isLiveMode());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    async function check() {
      const ok = await pingHealth();
      if (!cancelled) setDown(!ok);
    }
    check();
    const t = setInterval(check, CHECK_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [live]);

  if (!live || !down || dismissed) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 60,
        background: "#7c2d12",
        color: "#fff5f0",
        borderBottom: "1px solid #dc2626",
        padding: "10px 16px",
        display: "flex", alignItems: "center", gap: 12,
        fontSize: 13,
      }}
    >
      <AlertTriangle size={16} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <strong>Kyro backend is unreachable.</strong>{" "}
        Live data isn't loading. Check the backend server is running and reachable
        from this page — or switch to Demo mode to keep exploring.
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: "transparent", color: "inherit",
          border: "1px solid rgba(255,255,255,0.4)", borderRadius: 6,
          padding: "4px 10px", cursor: "pointer", fontSize: 12,
        }}
        aria-label="Dismiss backend warning"
      >
        Dismiss
      </button>
    </div>
  );
}
