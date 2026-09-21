"use client";

import { useEffect, useRef, useState } from "react";import { useRouter } from "next/navigation";
import { usePipelineStream } from "@/hooks/usePipelineStream";
import { useCameras } from "@/hooks/useCameras";
import { Sidebar } from "@/components/layout/Sidebar";
import { camerasApi } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { DEMO_MODE } from "@/lib/demo";
import { InlineCalendar } from "@/components/ui/DatePicker";

/**
 * Local-timezone "YYYY-MM-DD".
 *
 * toISOString() converts to UTC first, so for anyone behind UTC a date picked
 * as local midnight serialises as the *previous* day — the chart would quietly
 * load the wrong day's history. Formatting from the local getters avoids that.
 */
function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";
import type { Camera, VenueTotal } from "@/types";
import {
  TrendingUp, TrendingDown,
  ChevronLeft, ChevronRight as ChevRight, Calendar,
} from "lucide-react";
import Link from "next/link";

const BG      = "#070910";
const CARD    = "#0d1020";
const CARD2   = "#111528";
const BORDER  = "#1a1f35";

// ─── Zone colour palette ──────────────────────────────────────────────────────
const ZONE_COLOURS = [
  { icon: "≡",  bg: "#1e1b4b", accent: "#818cf8", mini: "#6366f1" },
  { icon: "⊞",  bg: "#172554", accent: "#60a5fa", mini: "#3b82f6" },
  { icon: "≈",  bg: "#052e16", accent: "#34d399", mini: "#10b981" },
  { icon: "≡",  bg: "#1c1917", accent: "#fb923c", mini: "#f97316" },
  { icon: "☀",  bg: "#1c1014", accent: "#f472b6", mini: "#ec4899" },
];

function zoneColour(idx: number) { return ZONE_COLOURS[idx % ZONE_COLOURS.length]; }

// ─── Mini sparkline ───────────────────────────────────────────────────────────
function MiniSparkline({ data, colour }: { data: number[]; colour: string }) {
  if (data.length < 2) return <div style={{ width: 80, height: 24 }} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const range = max - min || 1;
  const W = 80, H = 24;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - ((v - min) / range) * (H - 4) - 2}`).join(" ");
  return (
    <svg width={W} height={H} style={{ overflow: "visible" }}>
      <polyline points={pts} fill="none" stroke={colour} strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── Big area chart for total count ──────────────────────────────────────────
function TotalChart({ history, current, timestamps }: { history: number[]; current: number; timestamps?: number[] }) {
  const W = 600, H = 100;
  if (history.length < 2) return (
    <div style={{ height: H, width: "100%", display: "flex", alignItems: "flex-end" }}>
      <div style={{ width: "100%", height: 2, background: "#6366f1", opacity: 0.3, borderRadius: 2 }} />
    </div>
  );
  const max = Math.max(...history, 1);
  const pts = history.map((v, i) => `${(i / (history.length - 1)) * W},${H - (v / max) * (H - 8) - 4}`);
  const pathD = `M${pts.join(" L")}`;
  const areaD = `${pathD} L${W},${H} L0,${H} Z`;
  const lastPt = pts[pts.length - 1].split(",");
  // Axis labels: when real timestamps are available, derive them honestly
  // from the actual data span (e.g. "12 AM ... 3 PM" for an in-progress
  // today, not a full day that hasn't happened yet). Falls back to a
  // decorative full 12 AM–12 AM axis only when no timestamps are given —
  // i.e. demo mode's synthetic full-day curves, where that's accurate.
  const timeLabels = timestamps && timestamps.length >= 2
    ? (() => {
        const first = timestamps[0], last = timestamps[timestamps.length - 1];
        const fmt = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
        const steps = 6;
        return Array.from({ length: steps + 1 }, (_, i) => fmt(first + ((last - first) * i) / steps));
      })()
    : ["12 AM", "4 AM", "8 AM", "12 PM", "4 PM", "8 PM", "12 AM"];
  const yLabels = [0, Math.round(max * 0.33), Math.round(max * 0.67), max].reverse();

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 8 }}>
        {/* Y axis */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", paddingBottom: 20 }}>
          {yLabels.map((v, i) => (
            <span key={i} style={{ fontSize: 10, color: "#374151", width: 32, textAlign: "right" }}>
              {v >= 1000 ? `${Math.round(v / 1000)}k` : v}
            </span>
          ))}
        </div>
        {/* Chart */}
        <div style={{ flex: 1 }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} preserveAspectRatio="none">
            <defs>
              <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((t) => (
              <line key={t} x1="0" y1={H * t} x2={W} y2={H * t} stroke="#1a1f35" strokeWidth="0.5" />
            ))}
            <path d={areaD} fill="url(#chartGrad)" />
            <path d={pathD} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {/* Current position dot */}
            <circle cx={parseFloat(lastPt[0])} cy={parseFloat(lastPt[1])} r="4" fill="#6366f1" />
            <circle cx={parseFloat(lastPt[0])} cy={parseFloat(lastPt[1])} r="7" fill="none" stroke="#6366f1" strokeWidth="1" opacity="0.4" />
            {/* Tooltip at current */}
            <rect x={parseFloat(lastPt[0]) - 22} y={parseFloat(lastPt[1]) - 22} width="44" height="16" rx="4" fill="#1e2235" />
            <text x={parseFloat(lastPt[0])} y={parseFloat(lastPt[1]) - 11} textAnchor="middle" fontSize="9" fill="#a5b4fc" fontFamily="sans-serif">
              {current.toLocaleString()}
            </text>
          </svg>
          {/* X axis labels */}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            {timeLabels.map((l) => (
              <span key={l} style={{ fontSize: 10, color: "#374151" }}>{l}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Zone camera card (live stream per camera) ────────────────────────────────
function ZoneCameraCard({ camera, role }: { camera: Camera; role: string }) {
  const streamRole = (role === "admin" || role === "operator") ? role as "admin"|"operator" : "viewer" as const;
  const { data, connected } = usePipelineStream(camera.camera_id, streamRole);
  const [health, setHealth] = useState<{ is_running: boolean; status: string; error_reason: string | null } | null>(null);
  const [streamErr, setStreamErr] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // Poll the camera's real health status (online/offline/error) — this is
  // the ground truth from the vision worker's heartbeat, not just "is the
  // dashboard's websocket connected", which can stay "connected" even
  // when the camera feed itself has failed.
  useEffect(() => {
    if (inDemoMode()) return;
    let cancelled = false;
    async function poll() {
      try {
        const s = await camerasApi.status(camera.camera_id);
        if (!cancelled) setHealth(s);
      } catch { if (!cancelled) setHealth(null); }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [camera.camera_id]);

  const isLive = inDemoMode() || (health?.is_running ?? (connected && !!data));
  const isError = !inDemoMode() && health?.status === "error";

  return (
    <div className="relative overflow-hidden rounded-xl" style={{ aspectRatio: "16/9", background: "#0a0c18" }}>
      {inDemoMode() ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center"
          style={{ background: "linear-gradient(135deg,#1e1b4b,#172554,#052e16)" }}>
          <span style={{ color: "#4b5563", fontSize: 11 }}>Demo feed</span>
        </div>
      ) : isLive && !streamErr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={retryKey}
          src={camerasApi.streamUrl(camera.camera_id)}
          alt={camera.zone_name ?? camera.name}
          className="absolute inset-0 w-full h-full object-cover"
          draggable={false}
          onError={() => setStreamErr(true)}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 cursor-pointer"
          style={{ background: "linear-gradient(135deg,#1e1b4b,#172554,#052e16)" }}
          onClick={() => { setStreamErr(false); setRetryKey((k) => k + 1); }}>
          <span style={{ color: "#4b5563", fontSize: 11 }}>
            {streamErr ? "Stream lost — tap to retry" : "Connecting…"}
          </span>
        </div>
      )}
      {/* Live/Offline/Error badge */}
      <div className="absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded-full"
        style={{ background: "rgba(0,0,0,0.6)" }}
        title={isError ? (health?.error_reason ?? "Camera error") : undefined}>
        <span className={`w-1.5 h-1.5 rounded-full ${isError ? "bg-amber-500" : isLive ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />
        <span style={{ fontSize: 10, color: isError ? "#fcd34d" : isLive ? "#4ade80" : "#6b7280", fontWeight: 600 }}>
          {isError ? "CAMERA ERROR" : isLive ? "LIVE" : "OFFLINE"}
        </span>
      </div>
      {/* Zone label */}
      <div className="absolute bottom-2 left-2">
        <span style={{ fontSize: 11, color: "#d1d5db", fontWeight: 600 }}>{camera.zone_name ?? camera.name}</span>
      </div>
    </div>
  );
}

// ─── Per-camera live row data ─────────────────────────────────────────────────
function useLiveRow(camera: Camera, role: string) {
  const streamRole = (role === "admin" || role === "operator") ? role as "admin"|"operator" : "viewer" as const;
  const { data } = usePipelineStream(camera.camera_id, streamRole);
  const [history, setHistory] = useState<number[]>([]);
  useEffect(() => {
    if (data) setHistory((h) => [...h.slice(-20), data.attendance.current]);
  }, [data]);
  return {
    current: data?.attendance.current ?? 0,
    peak:    data?.attendance.peak    ?? 0,
    history,
  };
}

function ZoneTableRow({ camera, idx, role }: { camera: Camera; idx: number; role: string }) {
  const { current, peak, history } = useLiveRow(camera, role);
  const col = zoneColour(idx);
  const trend = history.length >= 2 ? history[history.length - 1] - history[history.length - 2] : 0;
  return (
    <tr style={{ borderBottom: `1px solid ${BORDER}`, cursor: "pointer" }}
      onClick={() => window.location.href = "/seating"}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#111528")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <td style={{ padding: "14px 16px" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
            style={{ background: col.bg, color: col.accent }}>
            {col.icon}
          </div>
          <span style={{ fontSize: 13, fontWeight: 500, color: "#e5e7eb" }}>{camera.zone_name ?? camera.name}</span>
        </div>
      </td>
      <td style={{ padding: "14px 16px", fontWeight: 700, fontSize: 15, color: "#fff" }}>
        {current.toLocaleString()}
      </td>
      <td style={{ padding: "14px 16px", fontWeight: 700, fontSize: 15, color: col.accent }}>
        {peak.toLocaleString()}
      </td>
      <td style={{ padding: "14px 16px" }}>
        <div className="flex items-center gap-3">
          <MiniSparkline data={history} colour={col.mini} />
          <span className="flex items-center gap-0.5" style={{ fontSize: 11, color: trend >= 0 ? "#4ade80" : "#f87171" }}>
            {trend >= 0
              ? <TrendingUp size={11} />
              : <TrendingDown size={11} />}
          </span>
        </div>
      </td>
    </tr>
  );
}

function ZoneCard({ camera, idx, role }: { camera: Camera; idx: number; role: string }) {
  const { current, peak, history } = useLiveRow(camera, role);
  const col = zoneColour(idx);
  const cap = camera.zone_capacity ?? 0;
  const trend = history.length >= 2
    ? Math.round(((history[history.length - 1] - history[0]) / Math.max(history[0], 1)) * 100)
    : 0;
  return (
    <Link href="/seating" className="rounded-xl p-4 flex flex-col gap-2 transition-all hover:scale-[1.02] cursor-pointer"
      style={{ background: CARD2, border: `1px solid ${BORDER}`, textDecoration: "none" }}>
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
          style={{ background: col.bg, color: col.accent }}>{col.icon}</div>
        <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 500 }}>{camera.zone_name ?? camera.name}</span>
      </div>
      <div>
        <p style={{ fontSize: 28, fontWeight: 800, color: "#fff", lineHeight: 1 }}>{current.toLocaleString()}</p>
        <p style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>people</p>
      </div>
      <div className="flex items-center gap-1.5">
        <span style={{ fontSize: 11, color: trend >= 0 ? "#4ade80" : "#f87171", fontWeight: 600 }}>
          {trend >= 0 ? "▲" : "▼"} {Math.abs(trend)}%
        </span>
        <MiniSparkline data={history} colour={col.mini} />
      </div>
    </Link>
  );
}

// ─── AI Alerts panel — live from backend alert system ────────────────────────

type AlertRow = {
  icon: string; title: string; sub: string; time: string; href: string;
  iconBg: string; accent: string; resolved: boolean;
};

// Per-level presentation. "online" is a real, visible alert level — a camera
// coming back is news worth showing, not just the quiet absence of an offline
// alert, which is how it used to (not) appear.
const ALERT_STYLE: Record<string, { icon: string; bg: string; accent: string }> = {
  critical: { icon: "🚨", bg: "#7f1d1d", accent: "#f87171" },
  warning:  { icon: "⚡", bg: "#78350f", accent: "#fbbf24" },
  offline:  { icon: "📷", bg: "#1f2937", accent: "#9ca3af" },
  online:   { icon: "✅", bg: "#064e3b", accent: "#4ade80" },
  review:   { icon: "🎭", bg: "#3730a3", accent: "#a5b4fc" },
};

/** "just now" / "4m ago" / "2h ago" / clock time once it's over a day old. */
function relativeTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 45)   return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AIAlertsPanel() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Bumped on a timer purely to re-render relative timestamps, so "just now"
  // becomes "3m ago" without waiting for the next 30s data poll.
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (inDemoMode()) {
      const demo = [
        { level: "critical", title: "High Density Detected", sub: "Stadium — Main Bowl", ago: 5,  resolved: false },
        { level: "online",   title: "Camera Back Online",    sub: "Balcony Camera 03",   ago: 12, resolved: false },
        { level: "warning",  title: "Approaching Capacity",  sub: "Main Floor",          ago: 20, resolved: false },
        { level: "offline",  title: "Camera Offline",        sub: "Balcony Camera 03",   ago: 40, resolved: true  },
      ];
      setAlerts(demo.map((d) => {
        const s = ALERT_STYLE[d.level] ?? ALERT_STYLE.warning;
        return {
          icon: s.icon, iconBg: s.bg, accent: s.accent,
          title: d.title, sub: d.sub,
          time: relativeTime(new Date(Date.now() - d.ago * 60000).toISOString()),
          href: d.level === "offline" || d.level === "online" ? "/cameras" : "/live-cameras",
          resolved: d.resolved,
        };
      }));
      setLoaded(true);
      return;
    }

    const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
    const token = localStorage.getItem("kyro_token") ?? "";
    const fetchAlerts = () =>
      fetch(`${API_URL}/api/v1/attendance/alerts?limit=8`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          setLoaded(true);
          if (!Array.isArray(data)) return;
          setAlerts(data.map((a: any) => {
            const s = ALERT_STYLE[a.level] ?? ALERT_STYLE.warning;
            return {
              icon:     s.icon,
              iconBg:   s.bg,
              accent:   s.accent,
              // The backend now sends a clean title and a separate detail
              // line, so there's no need to split a composite string on "·"
              // and hope the halves land in the right place.
              title:    a.message || "Alert",
              sub:      a.detail ? `${a.zone_name ?? a.camera_id} · ${a.detail}` : (a.zone_name ?? a.camera_id),
              time:     relativeTime(a.triggered_at),
              href:     a.level === "offline" || a.level === "online" ? "/cameras" : "/live-cameras",
              resolved: Boolean(a.resolved),
            };
          }));
        })
        .catch(() => setLoaded(true));
    fetchAlerts();
    const t = setInterval(fetchAlerts, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>AI Alerts</span>
        <Link href="/notifications" style={{ fontSize: 11, color: "#6366f1" }}>View all</Link>
      </div>
      {!loaded ? (
        <p className="px-4 py-6 text-center" style={{ fontSize: 12, color: "#374151" }}>Loading alerts…</p>
      ) : alerts.length === 0 ? (
        <p className="px-4 py-6 text-center" style={{ fontSize: 12, color: "#374151" }}>No alerts — system nominal</p>
      ) : (
        <div className="flex flex-col">
          {alerts.map((a, i) => (
            <Link key={i} href={a.href}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/5"
              style={{
                borderBottom: i < alerts.length - 1 ? `1px solid ${BORDER}` : "none",
                textDecoration: "none",
                opacity: a.resolved ? 0.5 : 1,   // cleared alerts fade, not vanish
              }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0"
                style={{ background: a.iconBg }}>{a.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p style={{ fontSize: 13, fontWeight: 600, color: a.resolved ? "#9ca3af" : "#e5e7eb" }}>{a.title}</p>
                  {a.resolved && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: "#4ade80", background: "rgba(74,222,128,0.12)",
                                   padding: "1px 5px", borderRadius: 4, letterSpacing: "0.04em" }}>
                      CLEARED
                    </span>
                  )}
                </div>
                <p className="truncate" style={{ fontSize: 11, color: "#6b7280" }}>{a.sub}</p>
              </div>
              <span style={{ fontSize: 11, color: "#4b5563", whiteSpace: "nowrap" }}>{a.time}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── System status panel ──────────────────────────────────────────────────────
function SystemStatus({ camerasTotal, camerasRunning }: { camerasTotal: number; camerasRunning?: number }) {
  const [backendOk, setBackendOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (inDemoMode()) { setBackendOk(true); return; }
    const check = async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/health`);
        setBackendOk(res.ok);
      } catch { setBackendOk(false); }
    };
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, []);

  const running = camerasRunning ?? camerasTotal;
  const items = [
    { label: "AI Service",  value: backendOk === null ? "Checking…" : backendOk ? "Operational" : "Offline", color: backendOk ? "#4ade80" : backendOk === false ? "#f87171" : "#6b7280", href: "/seating" },
    { label: "Cameras",     value: `${running} / ${camerasTotal} Online`, color: running === camerasTotal && camerasTotal > 0 ? "#60a5fa" : running === 0 ? "#6b7280" : "#f59e0b", href: "/cameras" },
    { label: "Data Feed",   value: backendOk ? "Live" : "Disconnected", color: backendOk ? "#4ade80" : "#f87171", href: "/live-cameras" },
  ];
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>System Status</span>
      </div>
      <div className="px-4 py-3 flex flex-col gap-3">
        {items.map((item) => (
          <Link key={item.label} href={item.href}
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
            style={{ textDecoration: "none" }}>
            <div className="flex-1">
              <p style={{ fontSize: 12, color: "#9ca3af" }}>{item.label}</p>
              <p style={{ fontSize: 12, fontWeight: 600, color: item.color }}>{item.value}</p>
            </div>
          </Link>
        ))}
      </div>
      {/* Orbital graphic */}
      <div className="flex items-center justify-center pb-4 pt-1">
        <svg width="80" height="80" viewBox="0 0 80 80">
          <ellipse cx="40" cy="40" rx="35" ry="12" fill="none" stroke="#1e2235" strokeWidth="1.5" transform="rotate(-20 40 40)" />
          <ellipse cx="40" cy="40" rx="35" ry="12" fill="none" stroke="#1e2235" strokeWidth="1.5" transform="rotate(40 40 40)" />
          <circle cx="40" cy="40" r="8" fill="#4f46e5" opacity="0.9" />
          <circle cx="40" cy="40" r="5" fill="#818cf8" />
          <circle cx="70" cy="34" r="3" fill="#22c55e" />
          <circle cx="18" cy="50" r="2.5" fill="#22c55e" opacity="0.7" />
          <circle cx="55" cy="18" r="2" fill="#60a5fa" opacity="0.6" />
        </svg>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AttendancePage() {
  const { cameras, loading: camsLoading } = useCameras();
  const { username, role, isAuthenticated, canViewAttendance } = useAuth();
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [venueTotal, setVenueTotal] = useState<VenueTotal | null>(null);
  const [venueHistory, setVenueHistory] = useState<number[]>([]);
  // Per-metric history so the metric selector can switch what the chart shows
  const [metricHistory, setMetricHistory] = useState<{
    people: number[]; occupancy: number[]; entries: number[]; exits: number[];
  }>({ people: [], occupancy: [], entries: [], exits: [] });
  const [camIdx, setCamIdx] = useState(0);
  // vs yesterday — ONLY shown in demo mode. Live mode shows no fake comparison.
  // Computed after hydration so it respects the user's live/demo choice.
  const [showVsYesterday, setShowVsYesterday] = useState(false);
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    setHydrated(true);
    const demo = inDemoMode();
    setIsDemo(demo);
    setShowVsYesterday(demo);
  }, []);
  useEffect(() => {
    if (!hydrated || inDemoMode()) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    // Viewers don't access the AI Count page — redirect to Seat Map
    if (!canViewAttendance || role === "viewer") { router.replace("/seating"); return; }
  }, [hydrated, isAuthenticated, canViewAttendance, role, router]);

  // Real-mode: poll venue total every 5s
  useEffect(() => {
    if (inDemoMode() || cameras.length === 0) return;
    const poll = async () => {
      try {
        const vt = await camerasApi.venueTotal();
        setVenueTotal(vt);
        setVenueHistory((h) => [...h.slice(-80), vt.total_current]);
        setMetricHistory((m) => ({
          people:    [...m.people.slice(-80),    vt.total_current],
          occupancy: [...m.occupancy.slice(-80), Math.round(vt.venue_occupancy_pct)],
          entries:   [...m.entries.slice(-80),   vt.total_entries],
          exits:     [...m.exits.slice(-80),     vt.total_exits],
        }));
      } catch {}
    };
    poll();
    const t = setInterval(poll, 5_000);
    return () => clearInterval(t);
  }, [cameras.length]);

  // Demo-mode: sum all camera streams
  const indoorCameras = cameras.filter((c) => c.location !== "queue");

  // Seed venue history in demo mode from the venue total polling
  useEffect(() => {
    if (!inDemoMode() || cameras.length === 0) return;
    // Start with a realistic church-attendance curve
    const people = Array.from({ length: 40 }, (_, i) => {
      const phase = i / 40;
      const base = phase < 0.4 ? phase * 2.5 * 7500
        : phase < 0.7 ? 7500 + Math.sin((phase - 0.4) * 10) * 500
        : 7500 - (phase - 0.7) * 3 * 3000;
      return Math.max(0, Math.round(base + (Math.random() - 0.5) * 300));
    });
    setVenueHistory(people);
    // Derive the other metrics from the same curve so switching metric is meaningful
    const capacity = 10000;
    let cumEntries = 0, cumExits = 0;
    const entries: number[] = [], exits: number[] = [], occupancy: number[] = [];
    people.forEach((v, i) => {
      const prev = i === 0 ? 0 : people[i - 1];
      const delta = v - prev;
      if (delta > 0) cumEntries += delta; else cumExits += -delta;
      entries.push(cumEntries);
      exits.push(cumExits);
      occupancy.push(Math.round((v / capacity) * 100));
    });
    setMetricHistory({ people, occupancy, entries, exits });
  }, [cameras.length]);

  // Build live camera slides (indoor only)
  const liveCams = indoorCameras.slice(0, 4);

  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showLiveMenu, setShowLiveMenu] = useState(false);
  const [showMetricMenu, setShowMetricMenu] = useState(false);
  const datePickerRef = useRef<HTMLDivElement>(null);
  const liveMenuRef   = useRef<HTMLDivElement>(null);
  const metricMenuRef = useRef<HTMLDivElement>(null);
  type Metric = "people" | "occupancy" | "entries" | "exits";
  const [metric, setMetric] = useState<Metric>("people");
  // Historical analytics for the selected date — now fetched for TODAY
  // too, not just past dates. Previously "today" relied purely on
  // client-side polling samples (at most a few minutes' worth, since it
  // only existed from when the page was opened) plotted against a
  // hardcoded "12 AM to 12 AM" axis that had nothing to do with the
  // actual data — meaning the chart could show a single flat point
  // stretched across a fake full-day axis. Real per-metric timestamped
  // history now backs this for every date, including today.
  const [historicalData, setHistoricalData] = useState<{
    date: string;
    history: number[];
    timestamps: number[];
    total: number;
  } | null>(null);

  const METRIC_LABELS: Record<Metric, string> = {
    people:    "People Count",
    occupancy: "Occupancy %",
    entries:   "Entries",
    exits:     "Exits",
  };

  // Close dropdowns on outside click — only close a menu when the click
  // landed OUTSIDE that menu's container (checked via ref).
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      if (datePickerRef.current && !datePickerRef.current.contains(t)) setShowDatePicker(false);
      if (liveMenuRef.current   && !liveMenuRef.current.contains(t))   setShowLiveMenu(false);
      if (metricMenuRef.current && !metricMenuRef.current.contains(t)) setShowMetricMenu(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Fetch historical analytics for the selected date — now including
  // today, so the chart has real backend history to show instead of
  // relying purely on ephemeral client-side polling.
  useEffect(() => {
    const now = new Date();
    const isToday_ = selectedDate.toDateString() === now.toDateString();
    const dateStr_ = toLocalDateStr(selectedDate);

    if (inDemoMode()) {
      if (isToday_) { setHistoricalData(null); return; } // demo "today" uses live poll data as before
      // Demo: generate deterministic fake history for that date
      const seed = selectedDate.getTime();
      const rng = (i: number) => ((seed / 1000 + i * 7919) % 1) ;
      const fake = Array.from({ length: 40 }, (_, i) => {
        const phase = i / 40;
        const base = phase < 0.4 ? phase * 2.5 * 600
          : phase < 0.7 ? 600 + Math.sin((phase - 0.4) * 10) * 50
          : 600 - (phase - 0.7) * 3 * 300;
        return Math.max(0, Math.round(base + rng(i) * 60 - 30));
      });
      setHistoricalData({ date: dateStr_, history: fake, timestamps: [], total: Math.max(...fake) });
      return;
    }

    // Real mode: fetch from analytics API for the first camera
    if (cameras.length === 0) return;
    const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
    const token = localStorage.getItem("kyro_token") ?? "";
    const cam = cameras.find((c) => c.location !== "queue") ?? cameras[0];
    fetch(`${API_URL}/api/v1/analytics/${cam.camera_id}/history?date=${dateStr_}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!Array.isArray(data)) return;
        const pick = (d: any) => (
          metric === "people"     ? (d.attendance ?? 0) :
          metric === "occupancy"  ? Math.round(d.occupancy_pct ?? 0) :
          metric === "entries"    ? (d.total_entries ?? 0) :
          /* exits */               (d.total_exits ?? 0)
        );
        const history = data.map(pick);
        const timestamps = data.map((d: any) => new Date(d.timestamp).getTime());
        setHistoricalData({ date: dateStr_, history, timestamps, total: Math.max(...history, 0) });
      })
      .catch(() => {});
  }, [selectedDate, cameras, metric]);

  const now = new Date();
  const dateStr = selectedDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const isToday = selectedDate.toDateString() === now.toDateString();

  // What to show in the chart and total — real backend history as the
  // base, with the live-polled current value appended as the freshest
  // point when viewing today (the periodic snapshotter that backs
  // history writes every couple of minutes, so the very latest number
  // comes from live polling instead of waiting for the next snapshot).
  const activeMetricHistory = metricHistory[metric] ?? [];
  const metricNow = activeMetricHistory[activeMetricHistory.length - 1] ?? 0;
  const chartHistory = isToday && !inDemoMode()
    ? [...(historicalData?.history ?? []), metricNow]
    : isToday
      ? activeMetricHistory  // demo mode: unchanged, pure live-poll based
      : (historicalData?.history ?? []);
  const chartTimestamps = isToday && !inDemoMode() && historicalData
    ? [...historicalData.timestamps, Date.now()]
    : historicalData?.timestamps;
  const displayTotal = isToday
    ? metricNow
    : (historicalData?.total ?? 0);
  // Suffix for the big number (e.g. "%" for occupancy)
  const metricSuffix = metric === "occupancy" ? "%" : "";
  const metricTitle = isToday
    ? { people: "Total people in building", occupancy: "Venue occupancy", entries: "Total entries today", exits: "Total exits today" }[metric]
    : `${METRIC_LABELS[metric]} on ${selectedDate.toLocaleDateString("en-US",{month:"short",day:"numeric"})}`;

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: BG }}>
      <Sidebar />
      <main className="flex-1 overflow-auto p-5 flex flex-col gap-5 min-w-0">

        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              Welcome back, {username || "admin"} 👋
            </h1>
            <p style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
              Here's what's happening across your venues
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
          {/* Date picker dropdown */}
          <div className="relative" ref={datePickerRef}>
            <button
              onClick={() => { setShowDatePicker((p) => !p); setShowLiveMenu(false); setShowMetricMenu(false); }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl transition-colors hover:opacity-80"
              style={{ background: CARD, border: `1px solid ${BORDER}` }}>
              <Calendar size={13} style={{ color: "#6b7280" }} />
              <span style={{ fontSize: 12, color: "#9ca3af" }}>{dateStr}</span>
              <ChevRight size={10} style={{ color: "#6b7280", transform: showDatePicker ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.2s" }} />
            </button>
            {showDatePicker && (
              <div className="absolute right-0 top-full mt-1 z-50 rounded-xl overflow-hidden shadow-2xl"
                style={{ background: "#0d1020", border: `1px solid ${BORDER}`, minWidth: 240 }}>
                <div className="px-3 py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <p style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Select date</p>
                </div>
                <div className="p-3 flex flex-col gap-1">
                  {[
                    { label: "Today", date: new Date() },
                    { label: "Yesterday", date: new Date(Date.now() - 86400000) },
                    { label: "7 days ago", date: new Date(Date.now() - 7 * 86400000) },
                    { label: "30 days ago", date: new Date(Date.now() - 30 * 86400000) },
                  ].map((opt) => {
                    const isSelected = selectedDate.toDateString() === opt.date.toDateString();
                    return (
                      <button key={opt.label}
                        onClick={() => { setSelectedDate(opt.date); setShowDatePicker(false); }}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs transition-colors"
                        style={{ background: isSelected ? "rgba(99,102,241,0.15)" : "transparent",
                                 color: isSelected ? "#a5b4fc" : "#9ca3af" }}
                        onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "#1a1f35"; }}
                        onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>
                        <span className="font-medium">{opt.label}</span>
                        <span className="ml-2" style={{ color: "#4b5563" }}>
                          {opt.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {/* Custom date — themed calendar, not the OS's white one */}
                <div style={{ borderTop: `1px solid ${BORDER}` }}>
                  <p className="px-3 pt-2 pb-1" style={{ fontSize: 10, color: "#6b7280" }}>Custom date</p>
                  <InlineCalendar
                    value={toLocalDateStr(selectedDate)}
                    max={toLocalDateStr(new Date())}
                    showFooter={false}
                    onChange={(v) => {
                      // Parse as local midnight. `new Date("2026-09-15")` is
                      // parsed as UTC, which lands on the previous day for
                      // anyone behind UTC — an off-by-one-day bug on exactly
                      // the kind of date the user just clicked.
                      const [y, m, d] = v.split("-").map(Number);
                      setSelectedDate(new Date(y, m - 1, d));
                      setShowDatePicker(false);
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Live status dropdown */}
          <div className="relative" ref={liveMenuRef}>
            <button
              onClick={() => { setShowLiveMenu((p) => !p); setShowDatePicker(false); setShowMetricMenu(false); }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl transition-colors hover:opacity-80"
              style={{ background: CARD, border: `1px solid ${BORDER}` }}>
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>Live</span>
              <ChevRight size={10} style={{ color: "#6b7280", transform: showLiveMenu ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.2s" }} />
            </button>
            {showLiveMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 rounded-xl overflow-hidden shadow-2xl"
                style={{ background: "#0d1020", border: `1px solid ${BORDER}`, minWidth: 200 }}>
                <div className="px-4 py-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
                    <p style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>Connected</p>
                  </div>
                  <p style={{ fontSize: 11, color: "#6b7280" }}>Backend: localhost:8000</p>
                  <p style={{ fontSize: 11, color: "#6b7280" }}>Polling every 5s</p>
                  <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 8, marginTop: 4 }}>
                    <p style={{ fontSize: 10, color: "#374151" }}>
                      {isToday ? "Showing live data" : `Showing data for ${dateStr}`}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>

        {/* ── Main 2-column layout ── */}
        <div className="flex gap-5 items-start">

          {/* Left column — 2/3 width */}
          <div className="flex flex-col gap-5 min-w-0" style={{ flex: "1 1 0" }}>

            {/* Total count + chart */}
            <div className="rounded-2xl p-5" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {metricTitle}
                  </p>
                  <p style={{ fontSize: 56, fontWeight: 900, color: "#818cf8", lineHeight: 1, marginTop: 4 }}>
                    {displayTotal.toLocaleString()}{metricSuffix}
                  </p>
                  {showVsYesterday && isToday && (
                  <div className="flex items-center gap-1.5 mt-2">
                    <TrendingUp size={12} className="text-green-400" />
                    <span style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>
                      +12.45% vs yesterday
                    </span>
                  </div>
                  )}
                  {!isToday && (
                  <div className="flex items-center gap-1.5 mt-2">
                    <Calendar size={12} style={{ color: "#6b7280" }} />
                    <span style={{ fontSize: 12, color: "#6b7280" }}>
                      Historical data
                    </span>
                  </div>
                  )}
                </div>
                {/* Metric selector dropdown — admin/operator only */}
                {(role === "admin" || role === "operator") && (
                <div className="relative" ref={metricMenuRef}>
                  <button
                    onClick={() => { setShowMetricMenu((p) => !p); setShowDatePicker(false); setShowLiveMenu(false); }}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors hover:opacity-80"
                    style={{ background: "rgba(99,102,241,0.15)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.25)" }}>
                    {METRIC_LABELS[metric]} ▾
                  </button>
                  {showMetricMenu && (
                    <div className="absolute right-0 top-full mt-1 z-50 rounded-xl overflow-hidden shadow-2xl"
                      style={{ background: "#0d1020", border: `1px solid ${BORDER}`, minWidth: 160 }}>
                      {(Object.entries(METRIC_LABELS) as [Metric, string][]).map(([key, label]) => (
                        <button key={key}
                          onClick={() => { setMetric(key); setShowMetricMenu(false); }}
                          className="w-full text-left px-4 py-2.5 text-xs transition-colors"
                          style={{
                            background: metric === key ? "rgba(99,102,241,0.15)" : "transparent",
                            color: metric === key ? "#a5b4fc" : "#9ca3af",
                            borderBottom: `1px solid ${BORDER}`,
                          }}
                          onMouseEnter={(e) => { if (metric !== key) (e.currentTarget as HTMLButtonElement).style.background = "#1a1f35"; }}
                          onMouseLeave={(e) => { if (metric !== key) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                )}
              </div>
              <TotalChart
                history={chartHistory}
                current={displayTotal}
                timestamps={chartTimestamps}
              />
            </div>

            {/* Zone overview cards */}
            <div className="rounded-2xl p-5" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
                Zone Overview
              </p>
              {camsLoading ? (
                <p style={{ fontSize: 13, color: "#4b5563" }}>Loading…</p>
              ) : (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(indoorCameras.length, 5)}, 1fr)` }}>
                  {indoorCameras.map((cam, i) => (
                    <ZoneCard key={cam.camera_id} camera={cam} idx={i} role={role as string} />
                  ))}
                </div>
              )}
            </div>

            {/* Detailed zone table — operator/admin only */}
            {(role === "admin" || role === "operator") && (
            <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
              <div className="px-5 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Detailed Zone Analytics
                </p>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                    {["Zone", "Now", "Peak ⓘ", "Trend (Today)"].map((h, i) => (
                      <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 600, color: "#4b5563",
                        textAlign: i === 0 ? "left" : "left", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {camsLoading ? (
                    <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: "#4b5563", fontSize: 13 }}>Loading…</td></tr>
                  ) : indoorCameras.length === 0 ? (
                    <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: "#4b5563", fontSize: 13 }}>No cameras — add one in Cameras</td></tr>
                  ) : (
                    indoorCameras.map((cam, i) => (
                      <ZoneTableRow key={cam.camera_id} camera={cam} idx={i} role={role as string} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
            )}
          </div>

          {/* Right column — fixed 300px */}
          <div className="flex flex-col gap-4 shrink-0" style={{ width: 300 }}>

            {/* Live overview camera carousel */}
            <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
              <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>Live Overview</span>
                <Link href="/live-cameras" style={{ fontSize: 11, color: "#6366f1" }}>View all</Link>
              </div>
              <div className="p-3">
                {liveCams.length > 0 ? (
                  <>
                    <ZoneCameraCard camera={liveCams[camIdx % liveCams.length]} role={role as string} />
                    {liveCams.length > 1 && (
                      <div className="flex items-center justify-between mt-2">
                        <div className="flex gap-1">
                          {liveCams.map((_, i) => (
                            <button key={i} onClick={() => setCamIdx(i)}
                              className="w-2 h-2 rounded-full transition-colors"
                              style={{ background: i === camIdx % liveCams.length ? "#6366f1" : "#1e2235" }} />
                          ))}
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => setCamIdx((p) => (p - 1 + liveCams.length) % liveCams.length)}
                            className="w-6 h-6 rounded-lg flex items-center justify-center"
                            style={{ background: "#1e2235" }}>
                            <ChevronLeft size={12} className="text-gray-400" />
                          </button>
                          <button onClick={() => setCamIdx((p) => (p + 1) % liveCams.length)}
                            className="w-6 h-6 rounded-lg flex items-center justify-center"
                            style={{ background: "#1e2235" }}>
                            <ChevRight size={12} className="text-gray-400" />
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-center justify-center py-8 rounded-xl"
                    style={{ background: "#0a0c18", fontSize: 12, color: "#4b5563" }}>
                    No cameras registered
                  </div>
                )}
              </div>
            </div>

            {/* AI Alerts — operator and admin only */}
            {(role === "admin" || role === "operator") && <AIAlertsPanel />}

            {/* System Status — admin only */}
            {role === "admin" && <SystemStatus camerasTotal={cameras.length} camerasRunning={venueTotal?.cameras_running} />}

          </div>
        </div>
      </main>
    </div>
  );
}
