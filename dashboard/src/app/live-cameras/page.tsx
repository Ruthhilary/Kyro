"use client";

/**
 * Live Cameras page
 *
 * Shows every registered camera as a live snapshot tile, grouped by zone/floor.
 * Includes:
 *   - Overcrowding detection (warn ≥80%, critical ≥90%)
 *   - Per-room seats available / seats left
 *   - Venue-wide capacity overview strip
 *   - "Can we fit the queue?" outside queue estimator
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { useCameras } from "@/hooks/useCameras";
import { usePipelineStream } from "@/hooks/usePipelineStream";
import { useAuth } from "@/hooks/useAuth";
import { camerasApi } from "@/lib/api";
import { DEMO_MODE } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";
import type { Camera, VenueTotal, ZoneLive } from "@/types";
import {
  Video, WifiOff, Users, ArrowUpRight, ArrowDownLeft,
  Maximize2, AlertTriangle, CheckCircle, XCircle,
  Armchair, ChevronDown, ChevronUp, Minus, Plus,
} from "lucide-react";

const BG      = "#0d0f1a";
const CARD_BG = "#13152a";
const BORDER  = "#1e2235";

// Thresholds
const WARN_PCT     = 80;  // amber warning
const CRITICAL_PCT = 90;  // red alert

// ─── Helpers ─────────────────────────────────────────────────────────────────

function occupancyColor(pct: number | null) {
  if (pct === null) return "#6366f1";
  if (pct >= CRITICAL_PCT) return "#ef4444";
  if (pct >= WARN_PCT)     return "#f59e0b";
  return "#22c55e";
}

function occupancyLabel(pct: number | null): "critical" | "warning" | "ok" | "unknown" {
  if (pct === null) return "unknown";
  if (pct >= CRITICAL_PCT) return "critical";
  if (pct >= WARN_PCT)     return "warning";
  return "ok";
}

// ─── Snapshot image ───────────────────────────────────────────────────────────

function SnapshotImage({ cameraId }: { cameraId: string }) {
  const [err, setErr] = useState(false);
  // key forces the <img> to reconnect the MJPEG stream if it drops
  const [retryKey, setRetryKey] = useState(0);

  if (inDemoMode()) {
    return (
      <div className="w-full h-full flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, #1e1b4b 0%, #172554 50%, #052e16 100%)" }}>
        <Video size={32} className="text-indigo-500 opacity-40" />
      </div>
    );
  }

  if (err) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 cursor-pointer" style={{ background: "#0a0c18" }}
        onClick={() => { setErr(false); setRetryKey((k) => k + 1); }}>
        <Video size={28} className="text-gray-700" />
        <span className="text-xs text-gray-700">Stream lost — tap to retry</span>
      </div>
    );
  }

  // MJPEG stream — the browser renders each multipart frame as it arrives,
  // no client-side polling loop or setInterval needed.
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      key={retryKey}
      src={camerasApi.streamUrl(cameraId)}
      alt="live camera feed"
      className="w-full h-full object-cover"
      draggable={false}
      onError={() => setErr(true)}
    />
  );
}

// ─── Overcrowding alert banner ────────────────────────────────────────────────

interface ZoneAlert {
  cameraId: string;
  name: string;
  pct: number;
  seatsLeft: number;
  level: "critical" | "warning";
}

function AlertBanner({ alerts }: { alerts: ZoneAlert[] }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const visible = alerts.filter((a) => !dismissed.includes(a.cameraId));
  if (visible.length === 0) return null;

  const hasCritical = visible.some((a) => a.level === "critical");

  return (
    <div
      className="rounded-2xl overflow-hidden mb-6"
      style={{
        border: `1px solid ${hasCritical ? "rgba(239,68,68,0.4)" : "rgba(245,158,11,0.4)"}`,
        background: hasCritical ? "rgba(239,68,68,0.07)" : "rgba(245,158,11,0.07)",
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <AlertTriangle size={15} className={hasCritical ? "text-red-400" : "text-amber-400"} />
        <span className={`text-sm font-semibold ${hasCritical ? "text-red-300" : "text-amber-300"}`}>
          {hasCritical ? "Overcrowding alert" : "Rooms filling up"}
        </span>
        <span className="text-xs text-gray-500 ml-auto">{visible.length} zone{visible.length !== 1 ? "s" : ""} affected</span>
      </div>
      <div className="flex flex-col" style={{ borderTop: `1px solid ${BORDER}` }}>
        {visible.map((alert, i) => (
          <div key={alert.cameraId} className="flex items-center gap-4 px-4 py-2.5"
            style={i > 0 ? { borderTop: `1px solid ${BORDER}` } : undefined}>
            <span
              className="w-2 h-2 rounded-full shrink-0 animate-pulse"
              style={{ background: alert.level === "critical" ? "#ef4444" : "#f59e0b" }}
            />
            <span className="text-sm font-medium text-white flex-1">{alert.name}</span>
            <span
              className="text-sm font-bold tabular-nums"
              style={{ color: alert.level === "critical" ? "#ef4444" : "#f59e0b" }}
            >
              {alert.pct}% full
            </span>
            {alert.seatsLeft > 0 ? (
              <span className="text-xs text-gray-400 tabular-nums w-24 text-right">
                {alert.seatsLeft.toLocaleString()} seat{alert.seatsLeft !== 1 ? "s" : ""} left
              </span>
            ) : (
              <span className="text-xs text-red-400 font-medium w-24 text-right">No seats left</span>
            )}
            <button
              onClick={() => setDismissed((p) => [...p, alert.cameraId])}
              className="text-gray-600 hover:text-gray-400 transition-colors ml-2"
              aria-label="Dismiss"
            >
              <XCircle size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Venue overview strip ─────────────────────────────────────────────────────

function VenueOverview({
  venueTotal,
  queueSize,
  setQueueSize,
}: {
  venueTotal: VenueTotal | null;
  queueSize: number;
  setQueueSize: (n: number) => void;
}) {
  const totalSeats  = venueTotal?.total_capacity ?? 0;
  const current     = venueTotal?.total_current ?? 0;
  const seatsLeft   = Math.max(0, totalSeats - current);
  const venuePct    = venueTotal?.venue_occupancy_pct ?? 0;
  const barColor    = occupancyColor(totalSeats > 0 ? venuePct : null);
  const canFitQueue = queueSize > 0 && seatsLeft >= queueSize;
  const queueFit    = queueSize > 0 ? seatsLeft - queueSize : null;

  return (
    <div
      className="rounded-2xl p-5 mb-6"
      style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}
    >
      {/* Top row */}
      <div className="flex flex-wrap items-start gap-6 mb-5">
        {/* Total in venue */}
        <div className="flex flex-col gap-0.5 min-w-[90px]">
          <span className="text-xs text-gray-500 uppercase tracking-widest">In venue</span>
          <span className="text-3xl font-bold text-white tabular-nums">{current.toLocaleString()}</span>
          {totalSeats > 0 && (
            <span className="text-xs text-gray-600 tabular-nums">of {totalSeats.toLocaleString()} seats</span>
          )}
        </div>

        {/* Seats remaining */}
        <div className="flex flex-col gap-0.5 min-w-[100px]">
          <span className="text-xs text-gray-500 uppercase tracking-widest">Seats left</span>
          <span
            className="text-3xl font-bold tabular-nums"
            style={{ color: seatsLeft === 0 ? "#ef4444" : seatsLeft < 20 ? "#f59e0b" : "#22c55e" }}
          >
            {totalSeats > 0 ? seatsLeft.toLocaleString() : "—"}
          </span>
          {totalSeats > 0 && seatsLeft === 0 && (
            <span className="text-xs text-red-400 font-medium">Full</span>
          )}
        </div>

        {/* Venue occupancy */}
        {totalSeats > 0 && (
          <div className="flex flex-col gap-0.5 min-w-[80px]">
            <span className="text-xs text-gray-500 uppercase tracking-widest">Occupancy</span>
            <span className="text-3xl font-bold tabular-nums" style={{ color: barColor }}>
              {Math.round(venuePct)}%
            </span>
          </div>
        )}

        {/* Cameras live */}
        <div className="flex flex-col gap-0.5 min-w-[80px]">
          <span className="text-xs text-gray-500 uppercase tracking-widest">Cameras</span>
          <span className="text-3xl font-bold text-white tabular-nums">
            {venueTotal?.cameras_running ?? 0}
            <span className="text-base text-gray-600 font-normal">/{venueTotal?.cameras_total ?? 0}</span>
          </span>
          <span className="text-xs text-gray-600">live</span>
        </div>

        {/* Outside queue estimator */}
        <div className="flex flex-col gap-1.5 ml-auto">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-widest">Outside queue</span>
            {queueSize > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded-full"
                style={{ background: "rgba(245,158,11,0.15)", color: "#fcd34d" }}>
                ● live
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setQueueSize(Math.max(0, queueSize - 10))}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
              style={{ background: "#1f2937" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#374151")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#1f2937")}
            >
              <Minus size={12} className="text-gray-300" />
            </button>
            <span className="text-xl font-bold text-white tabular-nums w-12 text-center">{queueSize}</span>
            <button
              onClick={() => setQueueSize(queueSize + 10)}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
              style={{ background: "#1f2937" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#374151")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#1f2937")}
            >
              <Plus size={12} className="text-gray-300" />
            </button>
          </div>
          <span className="text-xs" style={{ color: "#4b5563" }}>
            {queueSize > 0 ? "from outside camera · adjust if needed" : "no outside camera — enter manually"}
          </span>
          {queueSize > 0 && totalSeats > 0 && (
            <div className="flex items-center gap-1.5">
              {canFitQueue ? (
                <>
                  <CheckCircle size={13} className="text-green-400 shrink-0" />
                  <span className="text-xs text-green-400">
                    Yes — {queueFit} spare seat{queueFit !== 1 ? "s" : ""} after
                  </span>
                </>
              ) : (
                <>
                  <XCircle size={13} className="text-red-400 shrink-0" />
                  <span className="text-xs text-red-400">
                    No — {Math.abs(queueFit ?? 0)} too many
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Venue capacity bar */}
      {totalSeats > 0 && (
        <div>
          <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${Math.min(100, venuePct)}%`, background: barColor }}
            />
          </div>
          <div className="flex justify-between mt-1.5">
            <span className="text-xs text-gray-600">0</span>
            {totalSeats > 0 && (
              <span className="text-xs text-gray-600">{totalSeats.toLocaleString()} total seats</span>
            )}
          </div>
        </div>
      )}

      {/* Per-room seat availability table */}
      {venueTotal && venueTotal.zones.length > 0 && (
        <RoomSeatTable zones={venueTotal.zones} />
      )}
    </div>
  );
}

// ─── Per-room seat table ──────────────────────────────────────────────────────

function RoomSeatTable({ zones }: { zones: ZoneLive[] }) {
  const [open, setOpen] = useState(true);

  const zonesWithCapacity = zones.filter((z) => z.capacity > 0);
  if (zonesWithCapacity.length === 0) return null;

  return (
    <div className="mt-5">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-2 mb-3 text-xs font-semibold text-gray-500 uppercase tracking-widest hover:text-gray-300 transition-colors"
      >
        <Armchair size={13} />
        Seats by room
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {open && (
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
          {/* Header */}
          <div className="flex text-xs font-medium text-gray-500 px-4 py-2.5"
            style={{ borderBottom: `1px solid ${BORDER}`, background: "#0d0f1a" }}>
            <span className="flex-1 min-w-0">Room</span>
            <span className="w-20 text-right shrink-0">Capacity</span>
            <span className="w-20 text-right shrink-0">People in</span>
            <span className="w-24 text-right shrink-0">Seats left</span>
            <span className="w-32 text-right shrink-0">How full</span>
            <span className="w-20 text-right shrink-0">Status</span>
          </div>

          {/* Rows */}
          {zonesWithCapacity.map((zone) => {
            const left   = Math.max(0, zone.capacity - zone.current);
            const pct    = Math.round(zone.occupancy_pct);
            const color  = occupancyColor(pct);
            const status = occupancyLabel(pct);

            return (
              <div key={zone.camera_id} className="flex items-center px-4 py-3"
                style={{ borderBottom: `1px solid ${BORDER}` }}>

                {/* Room name */}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: zone.status === "error" ? "#f59e0b" : zone.is_running ? "#22c55e" : "#4b5563" }}
                    title={zone.status === "error" ? `Camera error: ${zone.error_reason ?? "unknown"}` : undefined} />
                  <span className="text-sm text-white font-medium truncate">{zone.zone_name}</span>
                </div>

                {/* Capacity */}
                <span className="w-20 text-right text-sm text-gray-400 tabular-nums shrink-0">
                  {zone.capacity.toLocaleString()}
                </span>

                {/* People in */}
                <span className="w-20 text-right text-sm text-white font-medium tabular-nums shrink-0">
                  {zone.current.toLocaleString()}
                </span>

                {/* Seats left */}
                <span className="w-24 text-right text-sm font-bold tabular-nums shrink-0"
                  style={{ color: left === 0 ? "#ef4444" : left < 10 ? "#f59e0b" : "#22c55e" }}>
                  {left === 0 ? "None left" : left.toLocaleString()}
                </span>

                {/* How full bar + % */}
                <div className="w-32 flex items-center gap-2 justify-end shrink-0">
                  <div className="w-16 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${Math.min(100, pct)}%`, background: color }} />
                  </div>
                  <span className="text-xs tabular-nums w-8 text-right font-medium" style={{ color }}>
                    {pct}%
                  </span>
                </div>

                {/* Status */}
                <div className="w-20 flex justify-end shrink-0">
                  {status === "critical" && (
                    <span className="text-xs px-2.5 py-1 rounded-full font-medium"
                      style={{ background: "rgba(239,68,68,0.15)", color: "#fca5a5" }}>Full</span>
                  )}
                  {status === "warning" && (
                    <span className="text-xs px-2.5 py-1 rounded-full font-medium"
                      style={{ background: "rgba(245,158,11,0.15)", color: "#fcd34d" }}>Filling</span>
                  )}
                  {status === "ok" && (
                    <span className="text-xs px-2.5 py-1 rounded-full font-medium"
                      style={{ background: "rgba(34,197,94,0.12)", color: "#86efac" }}>Open</span>
                  )}
                  {!zone.is_running && (
                    <span className="text-xs px-2.5 py-1 rounded-full font-medium"
                      style={{ background: "rgba(75,85,99,0.3)", color: "#9ca3af" }}>Offline</span>
                  )}
                  {zone.is_running && zone.status === "error" && (
                    <span className="text-xs px-2.5 py-1 rounded-full font-medium"
                      style={{ background: "rgba(245,158,11,0.15)", color: "#fcd34d" }}
                      title={zone.error_reason ?? undefined}>Camera error</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Individual camera tile ───────────────────────────────────────────────────

function CameraTile({
  camera,
  role,
  expanded,
  onExpand,
  onCountReport,
}: {
  camera: Camera;
  role: string;
  expanded: boolean;
  onExpand: () => void;
  onCountReport: (cameraId: string, current: number, capacity: number) => void;
}) {
  const streamRole = (role === "admin" || role === "operator") ? role as "admin" | "operator" : "viewer" as const;
  const { data, connected } = usePipelineStream(camera.camera_id, streamRole);

  const current  = data?.attendance.current ?? 0;
  const entries  = data?.attendance.entries ?? 0;
  const exits    = data?.attendance.exits   ?? 0;
  const isLive   = inDemoMode() ? true : connected && !!data;
  const capacity = camera.zone_capacity ?? 0;
  const isQueue  = camera.location === "queue";
  const pct      = (!isQueue && capacity > 0) ? Math.min(100, Math.round((current / capacity) * 100)) : null;
  const seatsLeft = (!isQueue && capacity > 0) ? Math.max(0, capacity - current) : null;
  const color    = occupancyColor(pct);
  const level    = occupancyLabel(pct);

  // Report count up — queue cameras report with 0 capacity so they don't affect indoor totals
  useEffect(() => {
    onCountReport(camera.camera_id, current, isQueue ? 0 : capacity);
  }, [camera.camera_id, current, capacity, isQueue, onCountReport]);

  const borderColor = isQueue ? "rgba(245,158,11,0.3)"
    : level === "critical" ? "rgba(239,68,68,0.6)"
    : level === "warning"  ? "rgba(245,158,11,0.5)"
    : expanded ? "#4f46e5"
    : BORDER;

  // ── Queue camera tile ──────────────────────────────────────────────────────
  if (isQueue) {
    return (
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ background: CARD_BG, border: `1px solid ${borderColor}` }}>
        {/* Snapshot */}
        <div className="relative" style={{ aspectRatio: "16/9", background: "#0a0c18" }}>
          <SnapshotImage cameraId={camera.camera_id} />
          <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-full px-2.5 py-1"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
            {isLive
              ? <><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" /><span className="text-xs font-medium text-green-400">Live</span></>
              : <><WifiOff size={11} className="text-gray-500" /><span className="text-xs font-medium text-gray-500">Offline</span></>
            }
          </div>
          {/* Big count overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <span className="text-5xl font-bold text-white tabular-nums drop-shadow-lg">{current.toLocaleString()}</span>
            <span className="text-xs font-medium px-2.5 py-1 rounded-full"
              style={{ background: "rgba(245,158,11,0.8)", color: "#fff" }}>
              people outside
            </span>
          </div>
          <button onClick={onExpand}
            className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg"
            style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(79,70,229,0.7)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.55)")}>
            <Maximize2 size={13} className="text-gray-300" />
          </button>
        </div>
        {/* Info strip */}
        <div className="px-3 pt-2.5 pb-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white leading-tight">{camera.name}</p>
              <p className="text-xs mt-0.5" style={{ color: "#f59e0b" }}>Outdoor queue</p>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: "rgba(245,158,11,0.15)", color: "#fcd34d" }}>No seats</span>
          </div>
          <div className="flex items-center gap-4 pt-0.5">
            <div className="flex items-center gap-1.5">
              <ArrowUpRight size={12} className="text-green-500" />
              <span className="text-xs text-gray-400 tabular-nums">
                <span className="text-green-400 font-medium">{entries.toLocaleString()}</span> entered
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <ArrowDownLeft size={12} className="text-red-400" />
              <span className="text-xs text-gray-400 tabular-nums">
                <span className="text-red-400 font-medium">{exits.toLocaleString()}</span> left
              </span>
            </div>
            <span className="text-xs text-gray-600 ml-auto">feeds queue estimator ↑</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Indoor tile ───────────────────────────────────────────────────────────
  return (
    <div
      className="rounded-2xl overflow-hidden flex flex-col"
      style={{
        background: CARD_BG,
        border: `1px solid ${borderColor}`,
        transition: "border-color 0.3s",
      }}
    >
      {/* Snapshot area */}
      <div className="relative" style={{ aspectRatio: "16/9", background: "#0a0c18" }}>
        <SnapshotImage cameraId={camera.camera_id} />

        {/* Alert overlay — shown when overcrowded */}
        {(level === "critical" || level === "warning") && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: level === "critical"
                ? "linear-gradient(to bottom, rgba(239,68,68,0.15) 0%, transparent 40%)"
                : "linear-gradient(to bottom, rgba(245,158,11,0.12) 0%, transparent 40%)",
            }}
          />
        )}

        {/* Status badge — top-left */}
        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-full px-2.5 py-1"
          style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
          {isLive
            ? <><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" /><span className="text-xs font-medium text-green-400">Live</span></>
            : <><WifiOff size={11} className="text-gray-500" /><span className="text-xs font-medium text-gray-500">Offline</span></>
          }
        </div>

        {/* Overcrowd badge — shown when near capacity */}
        {level === "critical" && (
          <div className="absolute top-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full px-3 py-1"
            style={{ background: "rgba(239,68,68,0.85)", backdropFilter: "blur(4px)" }}>
            <AlertTriangle size={11} className="text-white" />
            <span className="text-xs font-bold text-white">OVERCROWDED</span>
          </div>
        )}
        {level === "warning" && (
          <div className="absolute top-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full px-3 py-1"
            style={{ background: "rgba(245,158,11,0.85)", backdropFilter: "blur(4px)" }}>
            <AlertTriangle size={11} className="text-white" />
            <span className="text-xs font-bold text-white">FILLING UP</span>
          </div>
        )}

        {/* Live count + seats left — top-right */}
        <div className="absolute top-2.5 right-2.5 flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
            <Users size={12} className="text-indigo-300" />
            <span className="text-sm font-bold text-white tabular-nums">{current.toLocaleString()}</span>
            {capacity > 0 && <span className="text-xs text-gray-400">/ {capacity.toLocaleString()}</span>}
          </div>
          {seatsLeft !== null && (
            <div className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
              style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
              <Armchair size={11} style={{ color: seatsLeft === 0 ? "#ef4444" : seatsLeft < 10 ? "#f59e0b" : "#86efac" }} />
              <span className="text-xs font-medium tabular-nums"
                style={{ color: seatsLeft === 0 ? "#ef4444" : seatsLeft < 10 ? "#f59e0b" : "#86efac" }}>
                {seatsLeft === 0 ? "No seats" : `${seatsLeft.toLocaleString()} seats left`}
              </span>
            </div>
          )}
        </div>

        {/* Expand button — bottom-right */}
        <button
          onClick={onExpand}
          className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg transition-colors"
          style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(79,70,229,0.7)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.55)")}
          aria-label="Expand"
        >
          <Maximize2 size={13} className="text-gray-300" />
        </button>
      </div>

      {/* Info strip */}
      <div className="px-3 pt-2.5 pb-3 flex flex-col gap-2">
        {/* Name + status */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-white leading-tight">{camera.name}</p>
            {camera.zone_name && camera.zone_name !== camera.name && (
              <p className="text-xs text-indigo-400 mt-0.5">{camera.zone_name}</p>
            )}
          </div>
          {level === "critical" && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0 mt-0.5"
              style={{ background: "rgba(239,68,68,0.15)", color: "#fca5a5" }}>Full</span>
          )}
          {level === "warning" && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0 mt-0.5"
              style={{ background: "rgba(245,158,11,0.15)", color: "#fcd34d" }}>Filling</span>
          )}
        </div>

        {/* Occupancy bar */}
        {pct !== null && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-500">Occupancy</span>
              <span className="text-xs font-medium tabular-nums" style={{ color }}>{pct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
            </div>
          </div>
        )}

        {/* Bottom row: entries/exits + seats left */}
        <div className="flex items-center justify-between pt-0.5">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <ArrowUpRight size={12} className="text-green-500" />
              <span className="text-xs text-gray-400 tabular-nums">
                <span className="text-green-400 font-medium">{entries.toLocaleString()}</span> in
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <ArrowDownLeft size={12} className="text-red-400" />
              <span className="text-xs text-gray-400 tabular-nums">
                <span className="text-red-400 font-medium">{exits.toLocaleString()}</span> out
              </span>
            </div>
          </div>
          {seatsLeft !== null && capacity > 0 && (
            <span className="text-xs tabular-nums font-medium"
              style={{ color: seatsLeft === 0 ? "#ef4444" : seatsLeft < 10 ? "#f59e0b" : "#6b7280" }}>
              {seatsLeft} left
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Expanded modal ───────────────────────────────────────────────────────────

function ExpandedModal({ camera, role, onClose }: { camera: Camera; role: string; onClose: () => void }) {
  const streamRole = (role === "admin" || role === "operator") ? role as "admin" | "operator" : "viewer" as const;
  const { data, connected } = usePipelineStream(camera.camera_id, streamRole);
  const current   = data?.attendance.current ?? 0;
  const entries   = data?.attendance.entries ?? 0;
  const exits     = data?.attendance.exits ?? 0;
  const isLive    = inDemoMode() ? true : connected && !!data;
  const capacity  = camera.zone_capacity ?? 0;
  const pct       = capacity > 0 ? Math.min(100, Math.round((current / capacity) * 100)) : null;
  const seatsLeft = capacity > 0 ? Math.max(0, capacity - current) : null;
  const color     = occupancyColor(pct);
  const level     = occupancyLabel(pct);

  const dismissCb = useCallback((e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }, [onClose]);
  useEffect(() => { window.addEventListener("keydown", dismissCb); return () => window.removeEventListener("keydown", dismissCb); }, [dismissCb]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(6px)" }}
      onClick={onClose}>
      <div className="w-full max-w-4xl rounded-2xl overflow-hidden flex flex-col"
        style={{ background: CARD_BG, border: `1px solid ${level === "critical" ? "rgba(239,68,68,0.6)" : level === "warning" ? "rgba(245,158,11,0.5)" : "#4f46e5"}`, maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: `1px solid ${BORDER}` }}>
          <div>
            <p className="text-base font-bold text-white">{camera.name}</p>
            {camera.zone_name && camera.zone_name !== camera.name && (
              <p className="text-xs text-indigo-400">{camera.zone_name}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {level === "critical" && (
              <div className="flex items-center gap-1.5 rounded-full px-3 py-1"
                style={{ background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)" }}>
                <AlertTriangle size={12} className="text-red-400" />
                <span className="text-xs font-bold text-red-300">Overcrowded</span>
              </div>
            )}
            {level === "warning" && (
              <div className="flex items-center gap-1.5 rounded-full px-3 py-1"
                style={{ background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.4)" }}>
                <AlertTriangle size={12} className="text-amber-400" />
                <span className="text-xs font-bold text-amber-300">Filling up</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              {isLive
                ? <><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /><span className="text-xs text-green-400">Live</span></>
                : <><WifiOff size={12} className="text-gray-500" /><span className="text-xs text-gray-500">Offline</span></>
              }
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none px-1" aria-label="Close">✕</button>
          </div>
        </div>

        {/* Snapshot */}
        <div className="relative flex-1 min-h-0" style={{ aspectRatio: "16/9" }}>
          <SnapshotImage cameraId={camera.camera_id} />

          {/* Overlays */}
          <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-xl px-4 py-2.5"
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }}>
            <Users size={16} className="text-indigo-300" />
            <span className="text-2xl font-bold text-white tabular-nums">{current.toLocaleString()}</span>
            {capacity > 0 && <span className="text-sm text-gray-400">/ {capacity.toLocaleString()} seats</span>}
          </div>
          {seatsLeft !== null && (
            <div className="absolute bottom-4 right-4 flex items-center gap-2 rounded-xl px-4 py-2.5"
              style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }}>
              <Armchair size={14} style={{ color: seatsLeft === 0 ? "#ef4444" : seatsLeft < 10 ? "#f59e0b" : "#86efac" }} />
              <span className="text-lg font-bold tabular-nums"
                style={{ color: seatsLeft === 0 ? "#ef4444" : seatsLeft < 10 ? "#f59e0b" : "#86efac" }}>
                {seatsLeft === 0 ? "Full" : `${seatsLeft} left`}
              </span>
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-4" style={{ borderTop: `1px solid ${BORDER}` }}>
          {[
            { label: "In now",   value: current.toLocaleString(),   color: "text-white"  },
            { label: "Seats left", value: seatsLeft !== null ? seatsLeft.toLocaleString() : "—",
              color: seatsLeft === 0 ? "text-red-400" : seatsLeft !== null && seatsLeft < 10 ? "text-amber-400" : "text-green-400" },
            { label: "Entries",  value: entries.toLocaleString(),   color: "text-green-400" },
            { label: "Exits",    value: exits.toLocaleString(),     color: "text-red-400"   },
          ].map((stat, i) => (
            <div key={stat.label}
              className="px-5 py-3 flex flex-col gap-0.5"
              style={{ borderRight: i < 3 ? `1px solid ${BORDER}` : undefined }}>
              <span className="text-xs text-gray-500 uppercase tracking-widest">{stat.label}</span>
              <span className={`text-2xl font-bold tabular-nums ${stat.color}`}>{stat.value}</span>
              {stat.label === "In now" && pct !== null && (
                <div className="mt-1.5">
                  <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
                  </div>
                  <span className="text-xs mt-0.5 block" style={{ color }}>{pct}% full</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Floor group ──────────────────────────────────────────────────────────────

function FloorGroup({ zoneName, cameras, role, expandedId, onExpand, onCountReport }: {
  zoneName: string; cameras: Camera[]; role: string; expandedId: string | null;
  onExpand: (id: string | null) => void;
  onCountReport: (cameraId: string, current: number, capacity: number) => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-sm font-semibold text-white">{zoneName}</h2>
        <span className="text-xs px-2 py-0.5 rounded-full"
          style={{ background: "rgba(99,102,241,0.15)", color: "#a5b4fc" }}>
          {cameras.length} {cameras.length === 1 ? "camera" : "cameras"}
        </span>
        <div className="flex-1 h-px" style={{ background: BORDER }} />
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {cameras.map((cam) => (
          <CameraTile
            key={cam.camera_id} camera={cam} role={role}
            expanded={expandedId === cam.camera_id}
            onExpand={() => onExpand(expandedId === cam.camera_id ? null : cam.camera_id)}
            onCountReport={onCountReport}
          />
        ))}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LiveCamerasPage() {
  const { cameras, loading } = useCameras();
  const { role } = useAuth();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [venueTotal, setVenueTotal] = useState<VenueTotal | null>(null);
  const [queueSize, setQueueSize]   = useState(0);

  // Live counts reported by each CameraTile — avoids duplicate WebSocket connections
  const [liveCounts, setLiveCounts] = useState<Record<string, { current: number; capacity: number }>>({});

  const reportCount = useCallback((cameraId: string, current: number, capacity: number) => {
    setLiveCounts((prev) => {
      if (prev[cameraId]?.current === current && prev[cameraId]?.capacity === capacity) return prev;
      return { ...prev, [cameraId]: { current, capacity } };
    });
  }, []);

  // Poll venue totals every 5 s for real mode
  useEffect(() => {
    if (inDemoMode() || cameras.length === 0) return;
    const poll = async () => {
      try { setVenueTotal(await camerasApi.venueTotal()); } catch {}
    };
    poll();
    const t = setInterval(poll, 5_000);
    return () => clearInterval(t);
  }, [cameras.length]);

  // In real mode, sync outside queue from queue camera live counts
  useEffect(() => {
    if (inDemoMode()) return;
    const queueCams = cameras.filter((c) => c.location === "queue");
    const queueTotal = queueCams.reduce((s, c) => s + (liveCounts[c.camera_id]?.current ?? 0), 0);
    setQueueSize(queueTotal);
  }, [liveCounts, cameras]);

  // In demo mode, build venueTotal from reported live counts
  useEffect(() => {
    if (!inDemoMode()) return;
    // Separate queue cameras from indoor cameras
    const indoorCams = cameras.filter((c) => c.location !== "queue");
    const queueCams  = cameras.filter((c) => c.location === "queue");

    const zones: ZoneLive[] = indoorCams.map((cam) => {
      const lc = liveCounts[cam.camera_id] ?? { current: 0, capacity: cam.zone_capacity ?? 0 };
      const pct = lc.capacity > 0 ? Math.round((lc.current / lc.capacity) * 1000) / 10 : 0;
      return {
        camera_id:     cam.camera_id,
        zone_name:     cam.zone_name ?? cam.name,
        camera_name:   cam.name,
        current:       lc.current,
        peak:          lc.current,
        entries:       0,
        exits:         0,
        capacity:      lc.capacity,
        occupancy_pct: pct,
        is_running:    true,
        status:        "online",
        error_reason:  null,
      };
    });
    const total_current  = zones.reduce((s, z) => s + z.current, 0);
    const total_capacity = zones.reduce((s, z) => s + z.capacity, 0);

    // Auto-populate outside queue from queue cameras — always sync live
    const queueTotal = queueCams.reduce((s, c) => s + (liveCounts[c.camera_id]?.current ?? 0), 0);
    // Always update from live camera data — don't require manual input
    setQueueSize(queueTotal);

    setVenueTotal({
      total_current,
      total_peak:          total_current,
      total_entries:       0,
      total_exits:         0,
      total_capacity,
      venue_occupancy_pct: total_capacity > 0 ? Math.round((total_current / total_capacity) * 1000) / 10 : 0,
      zones,
      cameras_running:     zones.length,
      cameras_total:       cameras.length,
    });
  }, [liveCounts, cameras]);

  // Build alert list from reported counts (no extra WebSocket connections)
  const alerts: ZoneAlert[] = cameras
    .filter((cam) => cam.location !== "queue") // queue cameras don't have capacity thresholds
    .map((cam) => {
      const lc  = liveCounts[cam.camera_id];
      if (!lc || lc.capacity === 0) return null;
      const pct = Math.min(100, Math.round((lc.current / lc.capacity) * 100));
      if (pct < WARN_PCT) return null;
      return {
        cameraId:  cam.camera_id,
        name:      cam.zone_name ?? cam.name,
        pct,
        seatsLeft: Math.max(0, lc.capacity - lc.current),
        level:     (pct >= CRITICAL_PCT ? "critical" : "warning") as "critical" | "warning",
      };
    })
    .filter(Boolean)
    .sort((a, b) => b!.pct - a!.pct) as ZoneAlert[];

  // Group cameras by zone_name
  const groups = cameras.reduce<Record<string, Camera[]>>((acc, cam) => {
    const key = cam.zone_name?.trim() || cam.name;
    if (!acc[key]) acc[key] = [];
    acc[key].push(cam);
    return acc;
  }, {});

  const sortedGroups = Object.entries(groups).sort(([, a], [, b]) => {
    const minA = Math.min(...a.map((c) => c.zone_order ?? 0));
    const minB = Math.min(...b.map((c) => c.zone_order ?? 0));
    return minA - minB;
  });

  const expandedCamera = expandedId ? cameras.find((c) => c.camera_id === expandedId) ?? null : null;

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: BG }}>
      <Sidebar />
      <main className="flex-1 px-8 py-8 overflow-auto">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Live Cameras</h1>
          <p className="text-sm mt-0.5" style={{ color: "#6b7280" }}>
            All floors and rooms · snapshots every 2 s
          </p>
        </div>

        {/* Overcrowding alert banner */}
        <AlertBanner alerts={alerts} />

        {/* Venue overview + seat table */}
        {!loading && cameras.length > 0 && (
          <VenueOverview
            venueTotal={venueTotal}
            queueSize={queueSize}
            setQueueSize={setQueueSize}
          />
        )}

        {loading && <p className="text-sm text-gray-500 py-12 text-center">Loading cameras…</p>}

        {!loading && cameras.length === 0 && (
          <div className="rounded-2xl p-8 text-center" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
            <Video size={32} className="text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-400">No cameras registered yet.</p>
            <p className="text-xs text-gray-600 mt-1">Go to the Cameras page to add your first camera.</p>
          </div>
        )}

        {!loading && sortedGroups.length > 0 && (
          <div className="flex flex-col gap-10">
            {sortedGroups.map(([zoneName, cams]) => (
              <FloorGroup
                key={zoneName} zoneName={zoneName} cameras={cams} role={role}
                expandedId={expandedId} onExpand={setExpandedId}
                onCountReport={reportCount}
              />
            ))}
          </div>
        )}
      </main>

      {expandedCamera && (
        <ExpandedModal camera={expandedCamera} role={role} onClose={() => setExpandedId(null)} />
      )}
    </div>
  );
}
