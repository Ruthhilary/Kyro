"use client";

import { useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useCameras } from "@/hooks/useCameras";
import { DEMO_MODE } from "@/lib/demo";
import {
  Bell, BellOff, BellRing, CheckCircle, XCircle,
  Smartphone, Monitor, Loader2, AlertTriangle, Send,
  ChevronDown, ChevronUp, Info, FlaskConical,
} from "lucide-react";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

const BG      = "#0d0f1a";
const CARD_BG = "#13152a";
const BORDER  = "#1e2235";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

const STORAGE_KEY = "kyro_notif_prefs";

function loadPrefs() {
  if (typeof window === "undefined") return { warn: 0.80, crit: 0.90, offline: true };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { warn: 0.80, crit: 0.90, offline: true };
    const p = JSON.parse(raw);
    return {
      warn:    typeof p.warn    === "number" ? p.warn    : 0.80,
      crit:    typeof p.crit    === "number" ? p.crit    : 0.90,
      offline: typeof p.offline === "boolean" ? p.offline : true,
    };
  } catch { return { warn: 0.80, crit: 0.90, offline: true }; }
}

function savePrefs(warn: number, crit: number, offline: boolean) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ warn, crit, offline })); } catch {}
}

function ThresholdSlider({ label, value, onChange, color }: {
  label: string; value: number; onChange: (v: number) => void; color: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs text-gray-400">{label}</label>
        <span className="text-xs font-bold tabular-nums" style={{ color }}>{Math.round(value * 100)}%</span>
      </div>
      <input type="range" min={50} max={100} step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(parseInt(e.target.value) / 100)}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{ accentColor: color, background: "#1f2937" }}
      />
      <div className="flex justify-between text-xs text-gray-700">
        <span>50%</span><span>75%</span><span>100%</span>
      </div>
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${active ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />;
}

export default function NotificationsPage() {
  const push = usePushNotifications();
  const { cameras } = useCameras();

  const prefs = typeof window !== "undefined" ? loadPrefs() : { warn: 0.80, crit: 0.90, offline: true };
  const [warnThreshold, setWarnThresholdState] = useState(prefs.warn);
  const [critThreshold, setCritThresholdState] = useState(prefs.crit);
  const [notifyOffline, setNotifyOfflineState] = useState(prefs.offline);
  const [showAdvanced, setShowAdvanced]        = useState(false);
  const [testSent, setTestSent]                = useState(false);
  const [demoFiring, setDemoFiring]            = useState(false);
  const [demoMsg, setDemoMsg]                  = useState<string | null>(null);
  const [savedMsg, setSavedMsg]                = useState<string | null>(null);

  // Debounce ref for auto-saving thresholds to backend
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function syncRulesToBackend(warn: number, crit: number, offline: boolean) {
    try {
      const stored = localStorage.getItem("kyro_token");
      const real   = localStorage.getItem("kyro_real_token");
      const token  = (stored && !stored.includes("demo_signature")) ? stored : real;
      if (!token) return;

      // Get current subscription endpoint
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;

      const json = sub.toJSON();
      await fetch(`${API_URL}/api/v1/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          endpoint:       json.endpoint,
          keys:           json.keys,
          warn_threshold: warn,
          crit_threshold: crit,
          notify_offline: offline,
        }),
      });
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(null), 2000);
    } catch { /* non-fatal */ }
  }

  function setWarnThreshold(v: number) {
    setWarnThresholdState(v);
    savePrefs(v, critThreshold, notifyOffline);
    scheduleSave(v, critThreshold, notifyOffline);
  }

  function setCritThreshold(v: number) {
    setCritThresholdState(v);
    savePrefs(warnThreshold, v, notifyOffline);
    scheduleSave(warnThreshold, v, notifyOffline);
  }

  function setNotifyOffline(v: boolean) {
    setNotifyOfflineState(v);
    savePrefs(warnThreshold, critThreshold, v);
    scheduleSave(warnThreshold, critThreshold, v);
  }

  function scheduleSave(warn: number, crit: number, offline: boolean) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => syncRulesToBackend(warn, crit, offline), 800);
  }

  async function handleSubscribe() {
    await push.subscribe({ warnThreshold, critThreshold, notifyOffline });
  }

  async function handleTest() {
    setTestSent(false);
    await push.sendTest();
    if (!push.error) setTestSent(true);
  }

  async function handleDemoAlerts() {
    setDemoFiring(true);
    setDemoMsg(null);
    try {
      // Get a real token first
      const stored = localStorage.getItem("kyro_token");
      const real   = localStorage.getItem("kyro_real_token");
      const token  = (stored && !stored.includes("demo_signature")) ? stored : real;
      if (!token) throw new Error("Not authenticated — enable notifications first");

      const res = await fetch(`${API_URL}/api/v1/push/demo-alerts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? "Failed");
      setDemoMsg("🔔 Sending 5 demo alerts over the next 10 seconds — minimise this tab to see them");
    } catch (e: unknown) {
      setDemoMsg(`Error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setDemoFiring(false);
    }
  }

  const isEnabled = push.subscribed && push.permission === "granted";

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: BG }}>
      <Sidebar />
      <main className="flex-1 px-8 py-8 overflow-auto max-w-2xl">

        <div className="mb-7">
          <h1 className="text-xl font-bold text-white">Notifications</h1>
          <p className="text-sm mt-0.5" style={{ color: "#6b7280" }}>
            Get push alerts on your phone or desktop even when the app is closed
          </p>
        </div>

        {/* Browser not supported */}
        {!push.supported && (
          <div className="rounded-2xl p-5 mb-6" style={{ background: CARD_BG, border: "1px solid rgba(245,158,11,0.3)" }}>
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-white mb-1">Browser not supported</p>
                <p className="text-xs text-gray-400">
                  Push notifications require a modern browser. Try Chrome, Edge, Firefox, or Safari 16.4+ on iOS.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Main enable / disable card */}
        {push.supported && (
          <div className="rounded-2xl overflow-hidden mb-6"
            style={{ background: CARD_BG, border: `1px solid ${isEnabled ? "rgba(34,197,94,0.3)" : BORDER}` }}>

            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <div className="flex items-center gap-3">
                <StatusDot active={isEnabled} />
                <div>
                  <p className="text-sm font-semibold text-white">
                    {isEnabled ? "Notifications enabled" : "Notifications off"}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
                    {push.permission === "denied"
                      ? "Blocked — reset in browser settings"
                      : isEnabled
                      ? "You'll get alerts even when this tab is closed"
                      : "Enable to receive overcrowding and camera alerts"}
                  </p>
                </div>
              </div>

              {/* Always show the button — works in demo mode too */}
              {push.permission !== "denied" && (
                <button
                  onClick={isEnabled ? push.unsubscribe : handleSubscribe}
                  disabled={push.loading}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
                  style={{
                    background: isEnabled ? "rgba(239,68,68,0.15)" : "rgba(99,102,241,0.8)",
                    color:      isEnabled ? "#fca5a5" : "#fff",
                    border:     isEnabled ? "1px solid rgba(239,68,68,0.3)" : "none",
                  }}
                >
                  {push.loading
                    ? <Loader2 size={15} className="animate-spin" />
                    : isEnabled ? <BellOff size={15} /> : <Bell size={15} />}
                  {push.loading ? "Working…" : isEnabled ? "Turn off" : "Turn on"}
                </button>
              )}
            </div>

            <div className="px-5 py-4 flex items-center gap-6">
              <div className="flex items-center gap-2.5 flex-1">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: "rgba(99,102,241,0.15)" }}>
                  <Smartphone size={15} className="text-indigo-400" />
                </div>
                <div>
                  <p className="text-xs font-medium text-white">Phone</p>
                  <p className="text-xs text-gray-500">Screen off, app closed — still notified</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5 flex-1">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: "rgba(99,102,241,0.15)" }}>
                  <Monitor size={15} className="text-indigo-400" />
                </div>
                <div>
                  <p className="text-xs font-medium text-white">Desktop</p>
                  <p className="text-xs text-gray-500">Browser minimised — still notified</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Permission blocked */}
        {push.permission === "denied" && (
          <div className="rounded-2xl p-4 mb-6 flex items-start gap-3"
            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)" }}>
            <XCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-red-300 mb-1">Notifications blocked</p>
              <p className="text-xs text-gray-400">
                Click the lock icon in your browser address bar → Notifications → Allow, then refresh.
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        {push.error && (
          <div className="rounded-xl px-4 py-3 mb-4 flex items-center gap-2"
            style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)" }}>
            <XCircle size={14} className="text-red-400 shrink-0" />
            <span className="text-xs text-red-300">{push.error}</span>
          </div>
        )}

        {/* Alert rules */}
        {push.supported && (
          <div className="rounded-2xl overflow-hidden mb-6" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
            <div className="px-5 py-4" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <p className="text-sm font-semibold text-white">Alert rules</p>
              <p className="text-xs text-gray-500 mt-0.5">When should Kyro wake your phone?</p>
            </div>
            <div className="px-5 py-4 flex flex-col gap-5">
              <div className="flex flex-col gap-3">
                {[
                  { icon: <AlertTriangle size={14} className="text-red-400" />,
                    label: "Overcrowding — critical", desc: `Room hits ${Math.round(critThreshold * 100)}% capacity`,
                    color: "#ef4444", bg: "rgba(239,68,68,0.1)" },
                  { icon: <AlertTriangle size={14} className="text-amber-400" />,
                    label: "Filling up — warning", desc: `Room hits ${Math.round(warnThreshold * 100)}% capacity`,
                    color: "#f59e0b", bg: "rgba(245,158,11,0.1)" },
                  { icon: <BellRing size={14} className="text-indigo-400" />,
                    label: "AI review question", desc: "AI is unsure and needs your answer",
                    color: "#818cf8", bg: "rgba(99,102,241,0.1)" },
                  { icon: <BellRing size={14} className="text-purple-400" />,
                    label: "Camera went offline", desc: "A camera stopped sending data",
                    color: "#a855f7", bg: "rgba(168,85,247,0.1)",
                    toggle: true, value: notifyOffline, onToggle: () => setNotifyOffline(!notifyOffline) },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                    style={{ background: item.bg, border: `1px solid ${item.color}22` }}>
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: `${item.color}20` }}>{item.icon}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-white">{item.label}</p>
                      <p className="text-xs text-gray-500 truncate">{item.desc}</p>
                    </div>
                    {item.toggle !== undefined && (
                      <button onClick={item.onToggle}
                        className="shrink-0 w-9 h-5 rounded-full transition-colors relative"
                        style={{ background: item.value ? item.color : "#374151" }}>
                        <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                          style={{ left: item.value ? "calc(100% - 18px)" : "2px" }} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div>
                <button onClick={() => setShowAdvanced(p => !p)}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                  {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  Adjust thresholds
                </button>
                {showAdvanced && (
                  <div className="mt-4 flex flex-col gap-5">
                    <ThresholdSlider label="Warning threshold" value={warnThreshold} color="#f59e0b"
                      onChange={(v) => { setWarnThreshold(v); if (v >= critThreshold) setCritThreshold(Math.min(1, v + 0.05)); }} />
                    <ThresholdSlider label="Critical threshold" value={critThreshold} color="#ef4444"
                      onChange={(v) => { setCritThreshold(v); if (v <= warnThreshold) setWarnThreshold(Math.max(0, v - 0.05)); }} />
                  <div className="rounded-xl px-3 py-2.5 flex items-start gap-2"
                      style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)" }}>
                      <Info size={12} className="text-indigo-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-gray-400">
                        Thresholds are saved automatically and applied to all future alerts.
                        {savedMsg && <span className="text-green-400 ml-1">{savedMsg} ✓</span>}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Camera coverage */}
        {cameras.length > 0 && (
          <div className="rounded-2xl overflow-hidden mb-6" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
            <div className="px-5 py-4" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <p className="text-sm font-semibold text-white">Coverage</p>
              <p className="text-xs text-gray-500 mt-0.5">All cameras monitored</p>
            </div>
            <div className="px-5 py-3">
              {cameras.map((cam, i) => (
                <div key={cam.camera_id} className="flex items-center gap-3 py-2.5"
                  style={i < cameras.length - 1 ? { borderBottom: `1px solid ${BORDER}` } : undefined}>
                  <StatusDot active={isEnabled} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">{cam.name}</p>
                    {cam.zone_name && cam.zone_name !== cam.name && (
                      <p className="text-xs text-indigo-400 truncate">{cam.zone_name}</p>
                    )}
                  </div>
                  {cam.zone_capacity > 0 && (
                    <span className="text-xs text-gray-600 tabular-nums shrink-0">{cam.zone_capacity} seats</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Test push */}
        {isEnabled && (
          <div className="rounded-2xl px-5 py-4 mb-6 flex items-center justify-between"
            style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
            <div>
              <p className="text-sm font-semibold text-white">Send test notification</p>
              <p className="text-xs text-gray-500 mt-0.5">Verify it arrives on this device</p>
            </div>
            <button onClick={handleTest} disabled={push.loading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50"
              style={{ background: "rgba(99,102,241,0.2)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.3)" }}>
              {push.loading ? <Loader2 size={14} className="animate-spin" />
                : testSent ? <CheckCircle size={14} className="text-green-400" /> : <Send size={14} />}
              {testSent ? "Sent!" : "Test"}
            </button>
          </div>
        )}

        {/* Demo alerts — demo mode only, and only when notifications are enabled */}
        {isEnabled && inDemoMode() && (
          <div className="rounded-2xl overflow-hidden mb-6"
            style={{ background: CARD_BG, border: "1px solid rgba(99,102,241,0.25)" }}>
            <div className="px-5 py-4" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <div className="flex items-center gap-2 mb-0.5">
                <FlaskConical size={14} className="text-indigo-400" />
                <p className="text-sm font-semibold text-white">Fire demo alerts</p>
              </div>
              <p className="text-xs text-gray-500">
                Sends 5 realistic alerts from the demo cameras — overcrowding warnings and critical alerts.
                Minimise this tab first so you can see the desktop notifications pop up.
              </p>
            </div>
            <div className="px-5 py-4 flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1 text-xs text-gray-500">
                <span>⚠️  Main Floor filling up (82%)</span>
                <span>🚨 Balcony overcrowded (93%)</span>
                <span>⚠️  Overflow Room filling up (80%)</span>
                <span>🚨 Main Floor overcrowded (91%)</span>
                <span>⚠️  Stadium filling up (81%)</span>
                <span>🎭 Kyro question — someone moved toward the front</span>
              </div>
              <button
                onClick={handleDemoAlerts}
                disabled={demoFiring}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium shrink-0 disabled:opacity-50"
                style={{ background: "rgba(99,102,241,0.8)", color: "#fff" }}
              >
                {demoFiring
                  ? <Loader2 size={14} className="animate-spin" />
                  : <FlaskConical size={14} />}
                {demoFiring ? "Sending…" : "Fire alerts"}
              </button>
            </div>
            {demoMsg && (
              <div className="px-5 pb-4">
                <p className={`text-xs rounded-lg px-3 py-2 ${
                  demoMsg.startsWith("Error")
                    ? "text-red-300 bg-red-900/20 border border-red-800"
                    : "text-indigo-300 bg-indigo-900/20 border border-indigo-800"
                }`}>{demoMsg}</p>
              </div>
            )}
          </div>
          )}

        {/* Add to home screen tip */}
        {push.supported && !isEnabled && push.permission !== "denied" && (
          <div className="rounded-2xl px-5 py-4 flex items-start gap-3"
            style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
            <Smartphone size={16} className="text-indigo-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-white mb-1">Tip: install as an app</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                On iPhone: tap <span className="text-white">Share</span> → <span className="text-white">Add to Home Screen</span>.
                On Android: tap <span className="text-white">⋮</span> → <span className="text-white">Install app</span>.
                Then enable notifications above for a fully native feel.
              </p>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
