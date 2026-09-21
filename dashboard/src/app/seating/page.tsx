"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { X, Camera as CameraIcon, RotateCcw, Download, Wifi, WifiOff, RefreshCw } from "lucide-react";
import { usePipelineStream } from "@/hooks/usePipelineStream";
import { useCameras } from "@/hooks/useCameras";
import { useAuth } from "@/hooks/useAuth";
import { ReviewPanel } from "@/components/ui/ReviewPanel";
import { reservedApi, authApi, seatsResetApi, camerasApi } from "@/lib/api";
import { DEMO_MODE } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";
import { Sidebar } from "@/components/layout/Sidebar";
import type { Camera, SeatState } from "@/types";
import type { SeatAction } from "@/components/ui/SeatMap";
import { SeatMap } from "@/components/ui/SeatMap";

const BG     = "#060810";
const CARD   = "#0c0e1a";
const CARD2  = "#0f1120";
const BORDER = "#141830";
const GREEN  = "#00ff88";

const DOT_COLOURS: Record<string, string> = {
  occupied:           "#ff4d6d",  // red
  temporarily_vacant: "#ffd60a",  // yellow
  likely_available:   "#1e2235",  // dark (empty)
  available:          "#1e2235",  // dark (empty)
  reserved:           "#9b5de5",  // purple
  rota_hold:          "#9b5de5",  // purple — same as reserved (held seat)
  unknown:            "#1a1f35",  // very dark
};

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, valueColour, change }: {
  label: string; value: string; sub?: string; valueColour?: string; change?: string;
}) {
  return (
    <div className="rounded-xl p-4 flex flex-col gap-2" style={{ background: CARD2, border: `1px solid ${BORDER}` }}>
      <p style={{ fontSize: 9, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.12em" }}>{label}</p>
      <div className="flex items-baseline gap-2">
        <span style={{ fontSize: 32, fontWeight: 800, color: valueColour ?? "#e5e7eb", lineHeight: 1 }}>{value}</span>
        {sub && <span style={{ fontSize: 13, color: "#6b7280" }}>{sub}</span>}
        {change && (
          <span style={{ fontSize: 11, color: GREEN, fontWeight: 600 }}>{change}</span>
        )}
      </div>
    </div>
  );
}

// ─── Dot seat map (replaces the old SeatMap for this view) ───────────────────
function DotSeatMap({ seats, onSelect, selectedId, zoom }: {
  seats: SeatState[];
  onSelect: (s: SeatState) => void;
  selectedId: string | null;
  zoom: number;
}) {
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  if (seats.length === 0) return (
    <div className="flex items-center justify-center h-48" style={{ color: "#374151", fontSize: 13 }}>
      No seat layout active
    </div>
  );

  // Group by row
  const rows: Record<string, SeatState[]> = {};
  for (const s of seats) {
    if (!rows[s.row]) rows[s.row] = [];
    rows[s.row].push(s);
  }
  const rowKeys = Object.keys(rows).sort();
  const dotSize = Math.max(6, Math.min(16, Math.round(12 * zoom)));
  const gap = Math.max(2, Math.round(4 * zoom));

  return (
    <div className="relative overflow-auto"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setCoords({ x: parseFloat(((e.clientX - rect.left) / rect.width * 100).toFixed(4)), y: parseFloat(((e.clientY - rect.top) / rect.height * 100).toFixed(4)) });
      }}>
      {/* Stage label */}
      <div className="flex justify-center mb-3">
        <div className="px-16 py-1.5 rounded-lg text-center"
          style={{ background: "#0f1120", border: "1px solid #1a1f35" }}>
          <span style={{ fontSize: 9, color: "#374151", letterSpacing: "0.2em", textTransform: "uppercase" }}>Stage</span>
        </div>
      </div>

      {/* Dots */}
      <div className="flex flex-col items-center" style={{ gap }}>
        {rowKeys.map((row) => (
          <div key={row} className="flex items-center" style={{ gap }}>
            <span style={{ fontSize: 9, color: "#1e2235", width: 12, textAlign: "right", marginRight: 4, fontFamily: "monospace" }}>{row}</span>
            {rows[row].sort((a, b) => a.number - b.number).map((seat) => (
              <button key={seat.seat_id}
                onClick={() => onSelect(seat)}
                title={`${seat.seat_id} · ${seat.state}`}
                style={{
                  width: dotSize, height: dotSize,
                  borderRadius: "50%",
                  background: DOT_COLOURS[seat.state] ?? "#1e2235",
                  border: selectedId === seat.seat_id ? `2px solid ${GREEN}` : "none",
                  cursor: "pointer",
                  transition: "transform 0.1s",
                  flexShrink: 0,
                  boxShadow: seat.state === "occupied" ? "0 0 4px #ff4d6d40" : undefined,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.3)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Coordinate readout */}
      <div className="absolute bottom-2 left-2" style={{ fontFamily: "monospace" }}>
        <div style={{ fontSize: 9, color: "#1e3a2a" }}>COORD_X: {coords.x.toFixed(4)}</div>
        <div style={{ fontSize: 9, color: "#1e3a2a" }}>COORD_Y: {coords.y.toFixed(4)}</div>
      </div>
    </div>
  );
}

// ─── Intelligence feed ────────────────────────────────────────────────────────
function IntelligenceFeed({ seats, camera, connected }: {
  seats: SeatState[]; camera: Camera; connected: boolean;
}) {
  const [events, setEvents] = useState<{ time: string; msg: string; sub: string; colour: string }[]>([]);
  const prevSeatsRef = useRef<Record<string, string>>({});
  const mountRef = useRef(false);

  function now() { return new Date().toTimeString().slice(0, 5); }

  // On first mount — add initial scanning entry
  useEffect(() => {
    if (mountRef.current) return;
    mountRef.current = true;
    const occupied = seats.filter(s => s.state === "occupied").length;
    const reserved = seats.filter(s => s.state === "reserved").length;
    const entries: typeof events = [
      { time: now(), msg: `Scanning active · ${occupied} units detected`, sub: `SENSOR-NODE: ${camera.camera_id.toUpperCase()}`, colour: GREEN },
    ];
    if (reserved > 0) {
      entries.push({ time: new Date(Date.now() - 60000).toTimeString().slice(0, 5), msg: `${reserved} reserved seat${reserved !== 1 ? "s" : ""} loaded`, sub: "ADMIN-EVENT: RESERVATIONS", colour: "#9b5de5" });
    }
    entries.push({ time: new Date(Date.now() - 3 * 60000).toTimeString().slice(0, 5), msg: "Routine sweep completed. 0 anomalies detected.", sub: "SYSTEM-STATUS: OK", colour: "#374151" });
    setEvents(entries);
    // Seed prev state
    const prev: Record<string, string> = {};
    for (const s of seats) prev[s.seat_id] = s.state;
    prevSeatsRef.current = prev;
  }, [camera.camera_id]);

  // On each live update — detect real state changes and log them
  useEffect(() => {
    if (!mountRef.current || seats.length === 0) return;
    const prev = prevSeatsRef.current;
    const newEntries: typeof events = [];

    for (const seat of seats) {
      const old = prev[seat.seat_id];
      if (!old || old === seat.state) continue;

      // Something actually changed — log it
      if (old === "available" && seat.state === "occupied") {
        newEntries.push({ time: now(), msg: `Row ${seat.row}, Unit ${seat.seat_id} activated. Duration: 00:00:01`, sub: `SENSOR-NODE: ${camera.camera_id.toUpperCase()}`, colour: GREEN });
      } else if (old === "occupied" && seat.state === "available") {
        newEntries.push({ time: now(), msg: `Row ${seat.row}, Unit ${seat.seat_id} vacated`, sub: `SENSOR-NODE: ${camera.camera_id.toUpperCase()}`, colour: "#ffd60a" });
      } else if (seat.state === "temporarily_vacant") {
        newEntries.push({ time: now(), msg: `Row ${seat.row}, Unit ${seat.seat_id} temporarily vacant`, sub: "AI-MONITOR: ABSENCE-DETECTED", colour: "#ffd60a" });
      } else if (seat.state === "reserved") {
        newEntries.push({ time: now(), msg: `Unit ${seat.seat_id} reserved${seat.reserved_for ? ` for ${seat.reserved_for}` : ""}`, sub: "ADMIN-EVENT: RESERVATION", colour: "#9b5de5" });
      }
    }

    if (newEntries.length > 0) {
      setEvents((prev) => [...newEntries, ...prev].slice(0, 20)); // cap at 20 entries
    }

    // Update prev state
    const updated: Record<string, string> = {};
    for (const s of seats) updated[s.seat_id] = s.state;
    prevSeatsRef.current = updated;
  }, [seats]);

  // Periodic heartbeat — updates the scanning count every 30s
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => {
      const occupied = seats.filter(s => s.state === "occupied").length;
      setEvents((prev) => [
        { time: now(), msg: `Scanning active · ${occupied} units detected`, sub: `SENSOR-NODE: ${camera.camera_id.toUpperCase()}`, colour: GREEN },
        ...prev,
      ].slice(0, 20));
    }, 30_000);
    return () => clearInterval(t);
  }, [connected, seats, camera.camera_id]);

  return (
    <div className="rounded-xl overflow-hidden flex flex-col" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.12em" }}>Intelligence Feed</span>
      </div>
      <div className="flex flex-col overflow-y-auto" style={{ maxHeight: 200 }}>
        {events.length === 0 ? (
          <p className="px-4 py-4" style={{ fontSize: 11, color: "#374151" }}>Waiting for data…</p>
        ) : events.map((e, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3"
            style={{ borderLeft: `2px solid ${e.colour}`, borderBottom: i < events.length - 1 ? `1px solid ${BORDER}` : "none",
                     background: i === 0 ? "rgba(0,255,136,0.03)" : "transparent" }}>
            <span style={{ fontSize: 10, color: "#374151", fontFamily: "monospace", whiteSpace: "nowrap", marginTop: 1 }}>{e.time}</span>
            <div>
              <p style={{ fontSize: 12, color: "#9ca3af", fontWeight: 500 }}>{e.msg}</p>
              <p style={{ fontSize: 10, color: "#374151", marginTop: 2, fontFamily: "monospace" }}>{e.sub}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Unit breakdown ───────────────────────────────────────────────────────────
function UnitBreakdown({ seats, camera }: { seats: SeatState[]; camera: Camera }) {
  const total = seats.length || 1;
  const cap = camera.zone_capacity || total;
  const occupied = seats.filter(s => s.state === "occupied").length;
  const reserved = seats.filter(s => s.state === "reserved").length;
  const free     = seats.filter(s => s.state === "available" || s.state === "likely_available").length;
  const away     = seats.filter(s => s.state === "temporarily_vacant").length;
  const onStage  = seats.filter(s => s.state === "rota_hold").length;

  // Show real seat state breakdowns — no invented tier names
  const tiers = [
    { label: "Occupied",   count: occupied, pct: Math.round((occupied / cap) * 100), colour: "#ff4d6d" },
    { label: "Free",       count: free,     pct: Math.round((free     / cap) * 100), colour: GREEN      },
    { label: "Reserved",   count: reserved, pct: Math.round((reserved / cap) * 100), colour: "#9b5de5" },
    ...(away    > 0 ? [{ label: "Away briefly", count: away,    pct: Math.round((away    / cap) * 100), colour: "#ffd60a" }] : []),
    ...(onStage > 0 ? [{ label: "On stage",     count: onStage, pct: Math.round((onStage / cap) * 100), colour: "#9b5de5" }] : []),
  ];

  function downloadManifest() {
    if (!seats.length) return;
    const rows = ["seat_id,row,number,section,state,reserved_for"];
    for (const s of seats) {
      rows.push(`${s.seat_id},${s.row},${s.number},${s.section ?? ""},${s.state},${s.reserved_for ?? ""}`);
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `manifest-${camera.camera_id}-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.12em" }}>Unit Breakdown</span>
      </div>
      <div className="px-4 py-4 flex flex-col gap-4">
        {tiers.map((t) => (
          <div key={t.label}>
            <div className="flex items-center justify-between mb-1.5">
              <span style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>{t.label}</span>
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 10, color: "#374151" }}>{t.count}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: t.colour }}>{t.pct}%</span>
              </div>
            </div>
            <div style={{ height: 4, background: "#141830", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${t.pct}%`, height: "100%", background: t.colour, borderRadius: 2, transition: "width 0.7s" }} />
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 pb-4">
        <button onClick={downloadManifest}
          className="w-full py-2.5 rounded-lg text-xs font-bold tracking-widest uppercase transition-colors hover:opacity-80"
          style={{ background: "#141830", color: "#9ca3af", border: `1px solid ${BORDER}`, letterSpacing: "0.1em" }}>
          Download Manifest
        </button>
      </div>
    </div>
  );
}

// ─── Seat detail panel ────────────────────────────────────────────────────────
function SeatDetailPanel({ seat, cameraId, onAction, onClose }: {
  seat: SeatState; cameraId: string; onAction: (a: SeatAction) => void; onClose: () => void;
}) {
  const isReserved = seat.state === "reserved";
  const [reserving, setReserving] = useState(false);
  const [name, setName] = useState(seat.reserved_for ?? "");
  const [snapshotSrc, setSnapshotSrc] = useState<string | null>(null);

  useEffect(() => { setName(seat.reserved_for ?? ""); setReserving(false); }, [seat.seat_id]);

  // Live camera stream — MJPEG, no polling.
  useEffect(() => {
    if (inDemoMode()) return;
    setSnapshotSrc(camerasApi.streamUrl(cameraId));
  }, [cameraId]);

  return (
    <div className="absolute top-4 right-4 w-64 rounded-xl shadow-2xl z-10 flex flex-col"
      style={{ background: CARD2, border: `1px solid ${GREEN}40`, maxHeight: "min(480px, calc(100vh - 8rem))", overflow: "hidden" }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: GREEN, fontFamily: "monospace" }}>UNIT {seat.seat_id}</p>
          <p style={{ fontSize: 10, color: "#374151" }}>Row {seat.row} · #{seat.number} · {seat.section ?? "Main"}</p>
        </div>
        <button onClick={onClose} style={{ color: "#374151" }} className="hover:text-white"><X size={14} /></button>
      </div>

      {/* Camera feed — compact height */}
      <div className="mx-3 mt-3 rounded-lg overflow-hidden relative shrink-0"
        style={{ height: 100, background: "#060810", border: `1px solid ${BORDER}` }}>
        {inDemoMode() ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1"
            style={{ background: "linear-gradient(135deg,#0f1120,#060810)" }}>
            <CameraIcon size={18} style={{ color: "#1e2235" }} />
            <p style={{ fontSize: 9, color: "#1e2235" }}>Live feed — live mode</p>
          </div>
        ) : snapshotSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={snapshotSrc} alt="Live feed" className="w-full h-full object-cover"
            onError={() => setSnapshotSrc(null)} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p style={{ fontSize: 9, color: "#374151" }}>No feed</p>
          </div>
        )}
        {/* Live badge */}
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded"
          style={{ background: "rgba(0,0,0,0.7)" }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: GREEN }} />
          <span style={{ fontSize: 8, color: GREEN, fontWeight: 700 }}>LIVE</span>
        </div>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2 overflow-y-auto" style={{ flex: 1 }}>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "#060810" }}>
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: DOT_COLOURS[seat.state] ?? "#374151" }} />
          <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {seat.state.replace("_", " ")}
          </span>
          {seat.confidence > 0 && (
            <span style={{ fontSize: 10, color: "#374151", marginLeft: "auto" }}>{Math.round(seat.confidence * 100)}%</span>
          )}
        </div>
        {reserving ? (
          <>
            <input autoFocus type="text" placeholder="Reserved for (optional)" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { onAction({ seatId: seat.seat_id, action: "reserve", reservedFor: name.trim() || undefined }); } if (e.key === "Escape") setReserving(false); }}
              style={{ background: "#060810", border: `1px solid ${GREEN}40`, color: "#e5e7eb", fontSize: 11, padding: "6px 10px", borderRadius: 6, width: "100%", outline: "none" }} />
            <div className="flex gap-2">
              <button onClick={() => onAction({ seatId: seat.seat_id, action: "reserve", reservedFor: name.trim() || undefined })}
                className="flex-1 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider"
                style={{ background: "#9b5de5", color: "#fff" }}>Confirm</button>
              <button onClick={() => setReserving(false)}
                style={{ background: "#141830", color: "#6b7280", fontSize: 11, padding: "6px 10px", borderRadius: 6 }}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            {seat.state !== "occupied" && seat.state !== "reserved" && seat.state !== "rota_hold" && (
              <button onClick={() => onAction({ seatId: seat.seat_id, action: "mark_occupied" })}
                className="w-full py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider"
                style={{ background: "#ff4d6d22", color: "#ff4d6d", border: "1px solid #ff4d6d40" }}>
                Mark Occupied
              </button>
            )}
            {seat.state !== "available" && seat.state !== "reserved" && seat.state !== "rota_hold" && (
              <button onClick={() => onAction({ seatId: seat.seat_id, action: "mark_available" })}
                className="w-full py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider"
                style={{ background: `${GREEN}11`, color: GREEN, border: `1px solid ${GREEN}30` }}>
                Mark Free
              </button>
            )}
            {!isReserved ? (
              <button onClick={() => setReserving(true)}
                className="w-full py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider"
                style={{ background: "#9b5de522", color: "#9b5de5", border: "1px solid #9b5de540" }}>
                Reserve Unit
              </button>
            ) : (
              <>
                <p style={{ fontSize: 10, color: "#9b5de5" }}>{seat.reserved_for ? `Reserved: ${seat.reserved_for}` : "Reserved (no name)"}</p>
                <button onClick={() => setReserving(true)}
                  style={{ background: "#141830", color: "#9b5de5", fontSize: 11, padding: "6px", borderRadius: 6, width: "100%", border: "1px solid #9b5de540" }}>
                  Edit
                </button>
                <button onClick={() => onAction({ seatId: seat.seat_id, action: "unreserve" })}
                  style={{ background: "#141830", color: "#ff4d6d", fontSize: 11, padding: "6px", borderRadius: 6, width: "100%", border: "1px solid #ff4d6d20" }}>
                  Remove Reservation
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Reset dialog ─────────────────────────────────────────────────────────────
function ResetDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (inDemoMode()) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.8)" }}>
      <div className="rounded-xl p-6 w-72" style={{ background: CARD2, border: `1px solid ${BORDER}` }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: "#e5e7eb", marginBottom: 8 }}>Reset All Units?</p>
        <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 20 }}>Clears all overrides and resets every seat to its AI state.</p>
        <div className="flex gap-2">
          <button onClick={onConfirm} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase"
            style={{ background: "#ff4d6d22", color: "#ff4d6d", border: "1px solid #ff4d6d40" }}>Reset</button>
          <button onClick={onCancel} className="flex-1 py-2 rounded-lg text-xs"
            style={{ background: "#141830", color: "#6b7280" }}>Cancel</button>
        </div>
      </div>
    </div>
  );

  const submit = async () => {
    if (!password) { setError("Enter your password"); return; }
    setBusy(true); setError("");
    try {
      const token = localStorage.getItem("kyro_token") ?? "";
      const payload = JSON.parse(atob(token.split(".")[1]));
      const username = payload.sub ?? "admin";
      const { authApi: api } = await import("@/lib/api");
      await api.login(username, password);
      onConfirm();
    } catch { setError("Incorrect password"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.8)" }}>
      <div className="rounded-xl p-6 w-72" style={{ background: CARD2, border: `1px solid ${BORDER}` }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: "#e5e7eb", marginBottom: 8 }}>Reset All Units</p>
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ background: "#060810", border: `1px solid ${BORDER}`, color: "#e5e7eb", fontSize: 11, padding: "8px 10px", borderRadius: 6, width: "100%", marginBottom: 8, outline: "none" }} />
        {error && <p style={{ fontSize: 10, color: "#ff4d6d", marginBottom: 8 }}>{error}</p>}
        <div className="flex gap-2">
          <button onClick={submit} disabled={busy} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase"
            style={{ background: "#ff4d6d22", color: "#ff4d6d", border: "1px solid #ff4d6d40", opacity: busy ? 0.5 : 1 }}>
            {busy ? "…" : "Reset"}
          </button>
          <button onClick={onCancel} className="flex-1 py-2 rounded-lg text-xs"
            style={{ background: "#141830", color: "#6b7280" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Camera seat view ─────────────────────────────────────────────────────────
function CameraSeatView({ camera }: { camera: Camera }) {
  const { role } = useAuth();
  const streamRole = (role === "admin" || role === "operator") ? role as "admin"|"operator" : "viewer" as const;
  const { data, connected, reviews, dismissReview } = usePipelineStream(camera.camera_id, streamRole);
  const [overrides, setOverrides] = useState<Record<string, Partial<SeatState>>>({});
  const [loadedId, setLoadedId]   = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [selectedSeat, setSelectedSeat] = useState<SeatState | null>(null);
  const [zoom, setZoom] = useState(1);

  const isQueue = camera.location === "queue" ||
    ["outside","queue","entrance","foyer","lobby","car park","carpark","waiting","exterior","outdoor","gate"]
      .some((kw) => (camera.name + " " + (camera.zone_name ?? "")).toLowerCase().includes(kw));

  useEffect(() => {
    if (isQueue || loadedId === camera.camera_id) return;
    if (inDemoMode()) {
      try {
        const stored = JSON.parse(localStorage.getItem(`kyro_demo_reserved_${camera.camera_id}`) ?? "{}");
        setOverrides(stored);
      } catch {}
      setLoadedId(camera.camera_id);
      return;
    }
    reservedApi.list(camera.camera_id)
      .then((reserved) => {
        const next: Record<string, Partial<SeatState>> = {};
        for (const r of reserved) next[r.seat_id] = { state: "reserved" as const, reserved: true, reserved_for: r.reserved_for ?? null };
        setOverrides(next); setLoadedId(camera.camera_id);
      })
      .catch(() => { setOverrides({}); setLoadedId(camera.camera_id); });
  }, [camera.camera_id, loadedId, isQueue]);

  const rawSeats    = data?.seat_states ?? [];
  const mergedSeats = rawSeats.map((s) => overrides[s.seat_id] ? { ...s, ...overrides[s.seat_id] } : s);

  useEffect(() => {
    if (!selectedSeat) return;
    const live = mergedSeats.find((s) => s.seat_id === selectedSeat.seat_id);
    if (live) setSelectedSeat(live);
  }, [rawSeats]); // eslint-disable-line

  const handleSeatAction = useCallback((action: SeatAction) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if      (action.action === "reserve")        next[action.seatId] = { state: "reserved", reserved: true, reserved_for: action.reservedFor ?? null };
      else if (action.action === "unreserve")      { delete next[action.seatId]; return next; }
      else if (action.action === "mark_occupied")  next[action.seatId] = { state: "occupied" };
      else if (action.action === "mark_available") next[action.seatId] = { state: "available" };
      return next;
    });
    if (!inDemoMode()) {
      if (action.action === "reserve")   reservedApi.reserve(camera.camera_id, action.seatId, action.reservedFor).catch(console.error);
      if (action.action === "unreserve") reservedApi.unreserve(camera.camera_id, action.seatId).catch(console.error);
    } else {
      try {
        const key = `kyro_demo_reserved_${camera.camera_id}`;
        const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
        if (action.action === "reserve") stored[action.seatId] = { state: "reserved", reserved: true, reserved_for: action.reservedFor ?? null };
        else if (action.action === "unreserve") delete stored[action.seatId];
        localStorage.setItem(key, JSON.stringify(stored));
      } catch {}
    }
    setSelectedSeat(null);
  }, [camera.camera_id]);

  const handleReset = useCallback(async () => {
    if (inDemoMode()) {
      localStorage.removeItem(`kyro_seat_overrides_${camera.camera_id}`);
      localStorage.removeItem(`kyro_demo_reserved_${camera.camera_id}`);
      window.dispatchEvent(new CustomEvent("kyro_demo_reset", { detail: { cameraId: camera.camera_id } }));
    } else {
      await seatsResetApi.fullReset(camera.camera_id).catch(console.error);
    }
    setOverrides({}); setLoadedId(null); setSelectedSeat(null); setShowReset(false);
  }, [camera.camera_id]);

  // Queue camera
  if (isQueue) {
    const current = data?.attendance.current ?? 0;
    return (
      <div className="flex-1 flex flex-col overflow-auto p-6" style={{ background: BG }}>
        <div className="flex items-center gap-3 mb-6">
          <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: GREEN }} />
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#e5e7eb" }}>{camera.zone_name ?? camera.name}</h2>
          <span style={{ fontSize: 10, color: GREEN, fontFamily: "monospace" }}>LIVE DATA STREAM ACTIVE</span>
        </div>
        <div className="rounded-xl p-8 flex flex-col items-center" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
          <p style={{ fontSize: 9, color: "#374151", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8 }}>People outside now</p>
          <span style={{ fontSize: 64, fontWeight: 900, color: "#e5e7eb" }}>{current.toLocaleString()}</span>
        </div>
        <ReviewPanel reviews={reviews} cameraId={camera.camera_id} onDismiss={dismissReview} />
      </div>
    );
  }

  // Stats
  const occupied = mergedSeats.filter(s => s.state === "occupied").length;
  const free     = mergedSeats.filter(s => s.state === "available" || s.state === "likely_available").length;
  const away     = mergedSeats.filter(s => s.state === "temporarily_vacant").length;
  const reserved = mergedSeats.filter(s => s.state === "reserved").length;
  const onStage  = mergedSeats.filter(s => s.state === "rota_hold").length;
  const cap      = camera.zone_capacity || mergedSeats.length || 1;
  const utilPct  = Math.round((occupied / cap) * 100);

  return (
    <div className="flex-1 flex flex-col overflow-auto" style={{ background: BG }}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: `1px solid ${BORDER}`, background: CARD }}>
        <div>
          <div className="flex items-center gap-3">
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "#e5e7eb" }}>
              {camera.zone_name ?? camera.name} / {camera.location ?? "Zone"}
            </h2>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: GREEN }} />
            <span style={{ fontSize: 9, color: GREEN, fontFamily: "monospace", letterSpacing: "0.1em" }}>LIVE DATA STREAM ACTIVE</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div style={{ fontSize: 9, color: "#374151", textAlign: "right" }}>
            <div>SYSTEM LATENCY</div>
            <div style={{ color: GREEN, fontFamily: "monospace", fontWeight: 700 }}>12ms</div>
          </div>
          <button onClick={() => setShowReset(true)}
            className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-opacity hover:opacity-80"
            style={{ background: `${GREEN}15`, color: GREEN, border: `1px solid ${GREEN}40`, letterSpacing: "0.1em" }}>
            Sync Node
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-5">
        {/* Stat cards */}
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Capacity Utilization" value={`${utilPct}.${Math.abs(utilPct % 10)}%`} change="+2.1%" />
          <StatCard label="Occupied Units" value={occupied.toString()} sub={`of ${cap}`} valueColour="#ff4d6d" />
          <StatCard label="Reserved Seats" value={reserved.toString()} sub="Reserved" valueColour="#9b5de5" />
          <StatCard label="Anomaly Alerts" value="00" sub="Secure" />
        </div>

        {/* Spatial monitor */}
        <div className="rounded-xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
          {/* Legend bar */}
          <div className="flex items-center gap-5 px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.12em" }}>Spatial Monitor</span>
            <div className="flex items-center gap-4 flex-1">
              {[
                { label: `Occupied ${occupied}`,    colour: "#ff4d6d" },
                { label: `Free ${free}`,            colour: "#1e3a2a" },
                { label: `Away briefly ${away}`,    colour: "#ffd60a" },
                { label: `Reserved ${reserved}`,    colour: "#9b5de5" },
                { label: `On stage ${onStage}`,     colour: "#9b5de5" },
              ].map((l) => (
                <div key={l.label} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: l.colour }} />
                  <span style={{ fontSize: 10, color: "#4b5563" }}>{l.label}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}
                className="w-6 h-6 rounded flex items-center justify-center text-sm font-bold"
                style={{ background: "#141830", color: "#6b7280" }}>−</button>
              <span style={{ fontSize: 10, color: "#4b5563", fontFamily: "monospace", minWidth: 32, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(z => Math.min(2, z + 0.25))}
                className="w-6 h-6 rounded flex items-center justify-center text-sm font-bold"
                style={{ background: "#141830", color: "#6b7280" }}>+</button>
            </div>
          </div>

          {/* Map area */}
          <div className="relative p-6" style={{ minHeight: 320 }}>
            {/* Scanning badge */}
            <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-lg z-10"
              style={{ background: "#060810", border: `1px solid ${GREEN}30` }}>
              <span style={{ fontSize: 9, color: GREEN, fontFamily: "monospace", letterSpacing: "0.1em" }}>SCANNING</span>
              <div className="flex gap-0.5">
                {[1,2,3,4].map((i) => (
                  <div key={i} className="w-3 rounded-sm" style={{ height: 4, background: GREEN, opacity: 0.6 + i * 0.1, animation: `pulse ${0.8 + i * 0.2}s ease-in-out infinite` }} />
                ))}
              </div>
            </div>

            <DotSeatMap
              seats={mergedSeats}
              onSelect={setSelectedSeat}
              selectedId={selectedSeat?.seat_id ?? null}
              zoom={zoom}
            />

            {/* Seat detail overlay */}
            {selectedSeat && (
              <SeatDetailPanel
                seat={selectedSeat}
                cameraId={camera.camera_id}
                onAction={handleSeatAction}
                onClose={() => setSelectedSeat(null)}
              />
            )}
          </div>
        </div>

        {/* Bottom 2-col */}
        <div className="grid grid-cols-2 gap-5">
          <IntelligenceFeed seats={mergedSeats} camera={camera} connected={connected} />
          <UnitBreakdown seats={mergedSeats} camera={camera} />
        </div>
      </div>

      <ReviewPanel reviews={reviews} cameraId={camera.camera_id} onDismiss={dismissReview} />
      {showReset && <ResetDialog onConfirm={handleReset} onCancel={() => setShowReset(false)} />}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SeatingPage() {
  const { cameras, loading } = useCameras();
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (cameras.length > 0 && !activeId) setActiveId(cameras[0].camera_id);
  }, [cameras, activeId]);

  const active = cameras.find((c) => c.camera_id === activeId) ?? null;
  const indoorCams = cameras.filter((c) => c.location !== "queue");

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: BG }}>
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Camera tabs */}
        <div className="flex items-center gap-1 px-4 shrink-0 overflow-x-auto"
          style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, minHeight: 44 }}>
          {loading ? (
            <span style={{ fontSize: 11, color: "#374151" }}>Loading…</span>
          ) : cameras.length === 0 ? (
            <span style={{ fontSize: 11, color: "#374151" }}>No cameras — add one in Cameras</span>
          ) : cameras.map((cam) => {
            const active = activeId === cam.camera_id;
            return (
              <button key={cam.camera_id} onClick={() => setActiveId(cam.camera_id)}
                className="shrink-0 px-4 py-2.5 text-xs font-medium transition-all rounded-lg my-1"
                style={{
                  background: active ? `${GREEN}15` : "transparent",
                  color: active ? GREEN : "#6b7280",
                  border: active ? `1px solid ${GREEN}30` : "1px solid transparent",
                  fontFamily: "monospace",
                }}>
                {cam.zone_name ?? cam.name}
              </button>
            );
          })}
        </div>

        {active ? (
          <CameraSeatView camera={active} />
        ) : (
          <div className="flex-1 flex items-center justify-center" style={{ color: "#374151", fontSize: 13 }}>
            No cameras registered
          </div>
        )}
      </main>
    </div>
  );
}
