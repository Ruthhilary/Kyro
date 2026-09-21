"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { setLiveMode, setDemoMode, DEMO_REVIEWS } from "@/lib/demo";
import { Radio, Zap, Server, ChevronRight, ArrowLeft } from "lucide-react";

const HARDCODED_ACCOUNTS = [
  { username: "admin",        password: "Kharis2024!",  role: "admin",    desc: "Full access — all pages" },
  { username: "sarah.usher",  password: "Sarah@2024!",  role: "operator", desc: "Operator — AI Count, Cameras, Seat Map, Rota, Sessions, Analytics" },
  { username: "james.viewer", password: "James@2024!",  role: "viewer",   desc: "Viewer — Seat Map & Cameras only" },
];

function loadDemoAccounts() {
  try {
    const saved = JSON.parse(localStorage.getItem("kyro_demo_users") ?? "[]");
    const active = saved.filter((u: any) => u.is_active);
    const names = new Set(active.map((u: any) => u.username));
    const base = HARDCODED_ACCOUNTS.filter((a) => !names.has(a.username));
    return [
      ...base,
      ...active.map((u: any) => ({
        username: u.username,
        password: u.demo_password ?? "Demo@1234",
        role: u.role,
        desc: u.role === "admin" ? "Full access" : u.role === "operator" ? "Operator access" : "Read only",
      })),
    ];
  } catch { return HARDCODED_ACCOUNTS; }
}

function validateDemoLogin(username: string, password: string): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem("kyro_demo_users") ?? "[]");
    const match = saved.find((u: any) => u.username === username && u.is_active);
    if (match) return match.demo_password ? password === match.demo_password : password.length >= 1;
  } catch {}
  return HARDCODED_ACCOUNTS.some((a) => a.username === username && a.password === password);
}

type Screen = "landing" | "demo" | "live";

const ROLE_COLOURS: Record<string, { bg: string; text: string }> = {
  admin:    { bg: "rgba(139,92,246,0.15)", text: "#c4b5fd" },
  operator: { bg: "rgba(59,130,246,0.15)", text: "#93c5fd" },
  viewer:   { bg: "rgba(107,114,128,0.15)", text: "#9ca3af" },
};

export default function LoginPage() {
  const { login, isLoading, error, isAuthenticated, role } = useAuth();
  const router = useRouter();
  const [screen, setScreen]       = useState<Screen>("landing");
  const [user, setUser]           = useState("");
  const [pass, setPass]           = useState("");
  const [localError, setLocalError] = useState("");
  const [accounts, setAccounts]   = useState(HARDCODED_ACCOUNTS);

  const signedOut = typeof window !== "undefined" && !!sessionStorage.getItem("kyro_signed_out");

  useEffect(() => {
    if (!signedOut && isAuthenticated) {
      // Viewers go to Seat Map, everyone else goes to AI Count
      router.replace(role === "viewer" ? "/seating" : "/attendance");
    }
  }, [isAuthenticated, role, router, signedOut]);

  useEffect(() => {
    setAccounts(loadDemoAccounts());
  }, []);

  async function handleDemoLogin(username: string, password: string) {
    setLocalError("");
    if (!validateDemoLogin(username, password)) {
      setLocalError("Incorrect credentials");
      return;
    }
    // Demo login is always local — never hits the real backend
    // Set up demo session directly in localStorage/sessionStorage
    sessionStorage.removeItem("kyro_signed_out");
    sessionStorage.removeItem("kyro_live_mode"); // ensure not in live mode

    // Look up the role for this demo user
    let resolvedRole = "viewer";
    try {
      const saved = JSON.parse(localStorage.getItem("kyro_demo_users") ?? "[]");
      const match = saved.find((u: any) => u.username === username && u.is_active);
      if (match) {
        resolvedRole = match.role;
      } else {
        const hardcoded: Record<string, string> = {
          "admin": "admin", "sarah.usher": "operator", "james.viewer": "viewer",
        };
        resolvedRole = hardcoded[username] ?? "viewer";
      }
    } catch {}

    // Import DEMO_TOKEN and set up demo session
    const { DEMO_TOKEN } = await import("@/lib/demo");
    localStorage.setItem("kyro_token", DEMO_TOKEN);
    localStorage.setItem("kyro_demo_role", resolvedRole);
    setDemoMode(); // ensure kyro_mode=demo so DEMO_MODE resolves correctly
    localStorage.setItem("kyro_demo_last_user", username);

    // Hard navigate so useAuth re-hydrates from fresh localStorage
    const dest = resolvedRole === "viewer" ? "/seating" : "/attendance";
    window.location.href = dest;
  }

  async function handleLiveLogin(e: FormEvent) {
    e.preventDefault();
    setLocalError("");
    // Clear any leftover demo session — live mode always starts fresh
    localStorage.removeItem("kyro_demo_role");
    localStorage.removeItem("kyro_demo_last_user");
    const ok = await login(user, pass);
    if (ok) {
      sessionStorage.removeItem("kyro_signed_out");
      // Hard reload so DEMO_MODE re-evaluates from localStorage (kyro_mode=live)
      window.location.href = "/attendance";
    }
  }

  // ── Landing ────────────────────────────────────────────────────────────────
  if (screen === "landing") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center p-6"
        style={{ background: "linear-gradient(160deg, #070910 0%, #0d0f1a 50%, #070910 100%)" }}>

        {/* Logo */}
        <div className="mb-10 flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg"
            style={{ background: "linear-gradient(135deg,#6366f1,#4f46e5)" }}>
            <Radio size={26} className="text-white" strokeWidth={2} />
          </div>
          <div className="text-center">
            <h1 className="text-3xl font-bold text-white tracking-tight">Kyro</h1>
            <p className="text-sm mt-1" style={{ color: "#6b7280" }}>Vision Intelligence</p>
          </div>
        </div>

        {/* Mode cards */}
        <div className="w-full max-w-md flex flex-col gap-4">

          {/* Demo mode */}
          <button onClick={() => { setDemoMode(); setScreen("demo"); }}
            className="w-full rounded-2xl p-5 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: "#13152a", border: "1px solid rgba(99,102,241,0.4)" }}>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: "rgba(99,102,241,0.15)" }}>
                <Zap size={18} className="text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-base font-semibold text-white">Demo mode</p>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: "rgba(99,102,241,0.2)", color: "#a5b4fc" }}>
                    No setup needed
                  </span>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: "#6b7280" }}>
                  Explore Kyro with live simulated data — cameras, seat maps, Kyro questions,
                  analytics and more. No backend required.
                </p>
              </div>
              <ChevronRight size={18} className="text-gray-600 shrink-0 mt-1" />
            </div>
          </button>

          {/* Live mode */}
          <button onClick={() => { setLiveMode(); setScreen("live"); }}
            className="w-full rounded-2xl p-5 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: "#13152a", border: "1px solid rgba(34,197,94,0.3)" }}>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: "rgba(34,197,94,0.12)" }}>
                <Server size={18} className="text-green-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-base font-semibold text-white">Live mode</p>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: "rgba(34,197,94,0.12)", color: "#86efac" }}>
                    Real data
                  </span>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: "#6b7280" }}>
                  Connect to your Kyro backend with real cameras, live attendance tracking,
                  and full AI analysis. Sign in with your account.
                </p>
              </div>
              <ChevronRight size={18} className="text-gray-600 shrink-0 mt-1" />
            </div>
          </button>
        </div>

        <p className="text-xs mt-8" style={{ color: "#374151" }}>
          Kyro Vision Intelligence · Church Attendance Platform
        </p>
      </main>
    );
  }

  // ── Demo mode — account picker ─────────────────────────────────────────────
  if (screen === "demo") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center p-6"
        style={{ background: "linear-gradient(160deg, #070910 0%, #0d0f1a 50%, #070910 100%)" }}>

        <div className="w-full max-w-md">
          <button onClick={() => setScreen("landing")}
            className="flex items-center gap-1.5 text-sm mb-6 transition-colors"
            style={{ color: "#6b7280" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#6b7280")}>
            <ArrowLeft size={15} /> Back
          </button>

          <div className="mb-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: "rgba(99,102,241,0.15)" }}>
                <Zap size={16} className="text-indigo-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Demo mode</h2>
                <p className="text-xs" style={{ color: "#6b7280" }}>Choose an account to explore with</p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {accounts.map((a) => {
              const col = ROLE_COLOURS[a.role] ?? ROLE_COLOURS.viewer;
              return (
                <button key={a.username}
                  onClick={() => handleDemoLogin(a.username, a.password)}
                  className="w-full rounded-2xl p-4 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
                  style={{ background: "#13152a", border: "1px solid #1e2235" }}>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                      style={{ background: a.role === "admin" ? "#4f46e5" : a.role === "operator" ? "#0369a1" : "#374151" }}>
                      {a.username[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-white font-mono">{a.username}</p>
                        <span className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                          style={{ background: col.bg, color: col.text }}>{a.role}</span>
                      </div>
                      <p className="text-xs truncate" style={{ color: "#6b7280" }}>{a.desc}</p>
                    </div>
                    <ChevronRight size={15} className="text-gray-600 shrink-0" />
                  </div>
                </button>
              );
            })}
          </div>

          {localError && (
            <p className="text-red-400 text-xs mt-3 rounded-lg px-3 py-2 text-center"
              style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.3)" }}>
              {localError}
            </p>
          )}

          <p className="text-xs text-center mt-5" style={{ color: "#374151" }}>
            Demo data resets when you clear browser storage
          </p>
        </div>
      </main>
    );
  }

  // ── Live mode — sign in form ───────────────────────────────────────────────
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6"
      style={{ background: "linear-gradient(160deg, #070910 0%, #0d0f1a 50%, #070910 100%)" }}>

      <div className="w-full max-w-sm">
        <button onClick={() => setScreen("landing")}
          className="flex items-center gap-1.5 text-sm mb-6 transition-colors"
          style={{ color: "#6b7280" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#6b7280")}>
          <ArrowLeft size={15} /> Back
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: "rgba(34,197,94,0.12)" }}>
            <Server size={16} className="text-green-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Live mode</h2>
            <p className="text-xs" style={{ color: "#6b7280" }}>Sign in to your Kyro account</p>
          </div>
        </div>

        <form onSubmit={handleLiveLogin}
          className="rounded-2xl p-6 flex flex-col gap-4"
          style={{ background: "#13152a", border: "1px solid #1e2235" }}>

          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: "#6b7280" }}>Username</label>
            <input type="text" value={user} onChange={(e) => setUser(e.target.value)} required
              autoComplete="username" autoFocus
              className="rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              style={{ background: "#0d0f1a", border: "1px solid #1e2235" }} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: "#6b7280" }}>Password</label>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} required
              autoComplete="current-password"
              className="rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              style={{ background: "#0d0f1a", border: "1px solid #1e2235" }} />
          </div>

          {(localError || error) && (
            <p className="text-red-400 text-xs rounded-lg px-3 py-2"
              style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.3)" }}>
              {localError || error}
            </p>
          )}

          <button type="submit" disabled={isLoading}
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 transition-colors"
            style={{ background: "#4f46e5" }}>
            {isLoading ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-xs text-center" style={{ color: "#374151" }}>
            Backend must be running on{" "}
            <span className="font-mono" style={{ color: "#4b5563" }}>
              {process.env.NEXT_PUBLIC_API_URL ?? "localhost:8000"}
            </span>
          </p>
        </form>
      </div>
    </main>
  );
}
