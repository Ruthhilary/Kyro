"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { attendanceApi } from "@/lib/api";
import { useCameras } from "@/hooks/useCameras";
import { usePipelineStream } from "@/hooks/usePipelineStream";
import { useAuth } from "@/hooks/useAuth";
import { DEMO_MODE, DEMO_SESSIONS } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";
import { Play, Square, Download, Radio, WifiOff, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import type { SessionResponse, Camera } from "@/types";

const BG     = "#0d0f1a";
const CARD   = "#13152a";
const BORDER = "#1e2235";

const DEMO_SESSIONS_KEY = "kyro_demo_sessions";

function loadDemoSessions(): SessionResponse[] {
  if (typeof window === "undefined") return DEMO_SESSIONS as SessionResponse[];
  try {
    const saved = localStorage.getItem(DEMO_SESSIONS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as SessionResponse[];
      // Validate it's an array — guards against corrupted data
      if (Array.isArray(parsed)) return parsed;
    }
    // First visit — seed with defaults
    const defaults = DEMO_SESSIONS as SessionResponse[];
    localStorage.setItem(DEMO_SESSIONS_KEY, JSON.stringify(defaults));
    return defaults;
  } catch {
    return DEMO_SESSIONS as SessionResponse[];
  }
}

function saveDemoSessions(sessions: SessionResponse[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DEMO_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {}
}

function addDemoSession(session: SessionResponse): SessionResponse[] {
  const existing = loadDemoSessions();
  // Prevent duplicates
  const deduped = existing.filter((s) => s.session_id !== session.session_id);
  const all = [session, ...deduped];
  saveDemoSessions(all);
  return all;
}

function updateDemoSession(sessionId: string, patch: Partial<SessionResponse>): SessionResponse[] {
  const all = loadDemoSessions().map((s) =>
    s.session_id === sessionId ? { ...s, ...patch } : s
  );
  saveDemoSessions(all);
  return all;
}

// ─── Suggest a session name from the current day/time ────────────────────────
// Returns empty string — user names it themselves, or it shows as "Unnamed session"
function suggestSessionName(): string {
  return "";
}

function formatDuration(start: string, end: string | null): string {
  const ms  = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const min = Math.floor(ms / 60000);
  const h   = Math.floor(min / 60);
  const m   = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Live camera card — shows live count + one-tap session start ──────────────
function LiveCameraCard({
  camera,
  existingSession,
  onStart,
  onEnd,
  starting,
  ending,
}: {
  camera: Camera;
  existingSession: SessionResponse | null;
  onStart: (camera: Camera) => void;
  onEnd: (sessionId: string) => void;
  starting: string | null;
  ending: string | null;
}) {
  const { role } = useAuth();
  const streamRole = (role === "admin" || role === "operator") ? role : "viewer" as const;
  const { data, connected } = usePipelineStream(camera.camera_id, streamRole);
  const current  = data?.attendance.current ?? 0;
  const peak     = data?.attendance.peak    ?? 0;
  const entries  = data?.attendance.entries ?? 0;
  const isQueue  = camera.location === "queue";
  const isLive   = inDemoMode() || (connected && !!data);

  if (isQueue) return null; // Queue cameras don't have sessions

  const hasActive = !!existingSession && !existingSession.ended_at;

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${hasActive ? "#4338ca" : BORDER}` }}>
      {/* Header */}
      <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${isLive ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />
          <p className="text-sm font-semibold text-white truncate">{camera.zone_name ?? camera.name}</p>
          {hasActive && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: "rgba(99,102,241,0.2)", color: "#a5b4fc" }}>
              ● Session live · {formatDuration(existingSession.started_at, null)}
            </span>
          )}
        </div>
        {!isLive && <WifiOff size={14} className="text-gray-600 shrink-0" />}
      </div>

      <div className="px-5 py-4 flex items-center gap-6">
        {/* Live stats */}
        <div className="flex items-center gap-5 flex-1">
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Now</p>
            <p className="text-2xl font-bold text-white tabular-nums">{current.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Peak</p>
            <p className="text-2xl font-bold tabular-nums" style={{ color: "#818cf8" }}>{peak.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Entries</p>
            <p className="text-2xl font-bold text-green-400 tabular-nums">{entries.toLocaleString()}</p>
          </div>
          {camera.zone_capacity > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Capacity</p>
              <p className="text-lg font-semibold text-gray-400 tabular-nums">{camera.zone_capacity.toLocaleString()}</p>
            </div>
          )}
        </div>

        {/* Action button */}
        {hasActive ? (
          <button
            onClick={() => onEnd(existingSession.session_id)}
            disabled={ending === existingSession.session_id}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-50 shrink-0"
            style={{ background: "#dc2626" }}>
            <Square size={13} />
            {ending === existingSession.session_id ? "Ending…" : "End session"}
          </button>
        ) : (
          <button
            onClick={() => onStart(camera)}
            disabled={starting === camera.camera_id || !isLive}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-50 shrink-0"
            style={{ background: isLive ? "#4f46e5" : "#1f2937" }}
            title={!isLive ? "Camera not live — start a worker first" : undefined}>
            <Play size={13} />
            {starting === camera.camera_id ? "Starting…" : "Start session"}
          </button>
        )}
      </div>

      {/* Active session detail */}
      {hasActive && (
        <div className="px-5 py-3 flex items-center gap-4" style={{ borderTop: `1px solid ${BORDER}`, background: "rgba(99,102,241,0.04)" }}>
          <p className="text-xs text-gray-400 flex-1 truncate">{existingSession.name || "Unnamed session"}</p>
          <p className="text-xs text-gray-500">started {new Date(existingSession.started_at).toLocaleTimeString()}</p>
          <Link href={`/seating`}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors shrink-0">
            Seat map →
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Manual start form (collapsed by default) ────────────────────────────────
function ManualStartForm({ cameras, onCreated }: {
  cameras: Camera[];
  onCreated: (s: SessionResponse) => void;
}) {
  const [open, setOpen]           = useState(false);
  const [name, setName]           = useState("");
  const [cameraId, setCameraId]   = useState(cameras[0]?.camera_id ?? "");
  const [capacity, setCapacity]   = useState("");
  const [creating, setCreating]   = useState(false);
  const [err, setErr]             = useState<string | null>(null);

  // Auto-fill capacity from selected camera
  useEffect(() => {
    const cam = cameras.find((c) => c.camera_id === cameraId);
    if (cam && cam.zone_capacity > 0) setCapacity(String(cam.zone_capacity));
  }, [cameraId, cameras]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true); setErr(null);
    if (inDemoMode()) {
      const newSess: SessionResponse = {
        session_id: `sess-demo-${Date.now()}`,
        camera_id: cameraId, name,
        started_at: new Date().toISOString(), ended_at: null,
        venue_capacity: parseInt(capacity, 10) || 0,
        peak_attendance: 0, total_entries: 0, total_exits: 0,
      };
      const all = addDemoSession(newSess);
      onCreated(newSess);
      setOpen(false); setCreating(false);
      return;
    }
    try {
      const s = await attendanceApi.createSession({ camera_id: cameraId, name, venue_capacity: parseInt(capacity, 10) || 0 });
      onCreated(s);
      setOpen(false);
    } catch (e: any) { setErr(e.message); }
    finally { setCreating(false); }
  }

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
      <button onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-2 px-5 py-4 text-sm text-gray-400 hover:text-white transition-colors">
        <Plus size={15} className="text-indigo-400" />
        <span className="font-medium">Start a session manually</span>
        <ChevronRight size={14} className={`ml-auto transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <form onSubmit={submit} className="px-5 pb-5 flex flex-wrap gap-3 items-end" style={{ borderTop: `1px solid ${BORDER}` }}>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 mt-3">Session name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required
              className="bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-52" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 mt-3">Camera</label>
            <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}
              className="bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              {cameras.filter((c) => c.location !== "queue").map((c) => (
                <option key={c.camera_id} value={c.camera_id}>{c.zone_name ?? c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 mt-3">Capacity</label>
            <input type="number" min="0" value={capacity} onChange={(e) => setCapacity(e.target.value)}
              placeholder="auto-filled"
              className="bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-28" />
          </div>
          {err && <p className="w-full text-xs text-red-400">{err}</p>}
          <button type="submit" disabled={creating}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "#4f46e5" }}>
            <Play size={13} />
            {creating ? "Starting…" : "Start"}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Past sessions list ───────────────────────────────────────────────────────
function SessionHistory({ sessions, onDownload, onRename, onDelete }: {
  sessions: SessionResponse[];
  onDownload: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [editName, setEditName]     = useState("");

  const ended = sessions.filter((s) => !!s.ended_at).sort((a, b) =>
    new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );
  if (ended.length === 0) return null;

  function startEdit(s: SessionResponse) {
    setEditingId(s.session_id);
    setEditName(s.name);
  }

  function confirmRename(id: string) {
    if (editName.trim()) onRename(id, editName.trim());
    setEditingId(null);
  }

  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Past sessions</p>
      <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
        {ended.map((s, i) => (
          <div key={s.session_id} className="flex items-center gap-3 px-5 py-4"
            style={i > 0 ? { borderTop: `1px solid ${BORDER}` } : {}}>
            <div className="flex-1 min-w-0">
              {editingId === s.session_id ? (
                <div className="flex items-center gap-2 mb-1">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmRename(s.session_id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    autoFocus
                    className="bg-gray-900 border border-indigo-600 text-white text-sm rounded-lg px-3 py-1 focus:outline-none w-56"
                  />
                  <button onClick={() => confirmRename(s.session_id)}
                    className="text-xs px-2 py-1 rounded-lg text-white"
                    style={{ background: "#4f46e5" }}>Save</button>
                  <button onClick={() => setEditingId(null)}
                    className="text-xs text-gray-500 hover:text-white">Cancel</button>
                </div>
              ) : (
                <div className="flex items-center gap-2 mb-0.5">
                  {s.name ? (
                    <p className="text-sm font-medium text-white">{s.name}</p>
                  ) : (
                    <p className="text-sm font-medium italic" style={{ color: "#6b7280" }}>Unnamed session</p>
                  )}
                  <button onClick={() => startEdit(s)}
                    className="text-xs text-gray-600 hover:text-gray-300 transition-colors">✎ rename</button>
                </div>
              )}
              <p className="text-xs" style={{ color: "#6b7280" }}>
                {new Date(s.started_at).toLocaleString()} · {formatDuration(s.started_at, s.ended_at)} ·{" "}
                Peak {s.peak_attendance} · {s.total_entries} entries
                {s.venue_capacity > 0 && ` · Cap ${s.venue_capacity}`}
                {" · "}<span className="font-mono">{s.camera_id}</span>
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button onClick={() => onDownload(s.session_id)}
                className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                <Download size={11} /> Export CSV
              </button>
              <button onClick={() => onDelete(s.session_id)}
                className="text-xs text-red-600 hover:text-red-400 transition-colors">
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SessionsPage() {
  const { cameras, loading: camsLoading } = useCameras();
  const [sessions, setSessions]   = useState<SessionResponse[]>([]);
  const [loading, setLoading]     = useState(true);
  const [starting, setStarting]   = useState<string | null>(null);
  const [ending, setEnding]       = useState<string | null>(null);
  const [status, setStatus]       = useState<{ ok: boolean; msg: string } | null>(null);
  const { canViewAttendance, isAuthenticated, role } = useAuth();
  const router = useRouter();
  const [hydrated, setHydrated]   = useState(false);
  useEffect(() => { setHydrated(true); }, []);

  useEffect(() => {
    if (!hydrated || inDemoMode()) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (!canViewAttendance) router.replace("/seating");
  }, [hydrated, isAuthenticated, canViewAttendance, router]);

  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    if (inDemoMode()) {
      setSessions(loadDemoSessions());
      setLoading(false);
      return;
    }
    try {
      const result = await attendanceApi.listSessions();
      setSessions(result);
      setLoadError(null);
    } catch (e: any) {
      // Previously this silently cleared the list on ANY failure
      // (expired token, brief network hiccup, backend restart) — making a
      // genuinely still-running session indistinguishable from "no
      // sessions at all". If you start a session, navigate away, and come
      // back to find it apparently gone, check here first: a visible
      // error means the fetch failed (the session is very likely still
      // running on the backend), not that it was actually ended.
      setLoadError(e?.message || "Failed to load sessions");
    }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // One-tap session start — pre-fills name from day/time, capacity from camera
  async function handleQuickStart(camera: Camera) {
    setStarting(camera.camera_id);
    setStatus(null);
    const name = ""; // User will name it — shown as "Unnamed session" until renamed
    const cap  = camera.zone_capacity ?? 0;
    if (inDemoMode()) {
      const s: SessionResponse = {
        session_id: `sess-demo-${Date.now()}`,
        camera_id: camera.camera_id, name,
        started_at: new Date().toISOString(), ended_at: null,
        venue_capacity: cap, peak_attendance: 0, total_entries: 0, total_exits: 0,
      };
      const all = addDemoSession(s);
      setSessions(all);
      setStatus({ ok: true, msg: `Session started — "${name}"` });
      setStarting(null);
      return;
    }
    try {
      const s = await attendanceApi.createSession({ camera_id: camera.camera_id, name, venue_capacity: cap });
      setSessions((prev) => [s, ...prev]);
      setStatus({ ok: true, msg: `Session started — "${name}"` });
    } catch (e: any) { setStatus({ ok: false, msg: e.message }); }
    finally { setStarting(null); }
  }

  async function handleEnd(sessionId: string) {
    setEnding(sessionId);
    setStatus(null);
    if (inDemoMode()) {
      const updated = updateDemoSession(sessionId, { ended_at: new Date().toISOString() });
      setSessions(updated);
      setStatus({ ok: true, msg: "Session ended — metrics saved" });
      setEnding(null);
      return;
    }
    try {
      await attendanceApi.endSession(sessionId);
      setStatus({ ok: true, msg: "Session ended — metrics saved" });
      await loadSessions();
    } catch (e: any) { setStatus({ ok: false, msg: e.message }); }
    finally { setEnding(null); }
  }

  async function handleRename(sessionId: string, newName: string) {
    if (inDemoMode()) {
      const updated = updateDemoSession(sessionId, { name: newName });
      setSessions(updated);
    } else {
      try {
        await attendanceApi.renameSession(sessionId, newName);
        setSessions((prev) => prev.map((s) => s.session_id === sessionId ? { ...s, name: newName } : s));
      } catch (e: any) { setStatus({ ok: false, msg: e.message }); }
    }
  }

  async function handleDelete(sessionId: string) {
    if (!confirm("Delete this session? This can't be undone.")) return;
    if (inDemoMode()) {
      const updated = loadDemoSessions().filter((s) => s.session_id !== sessionId);
      saveDemoSessions(updated);
      setSessions(updated);
    } else {
      try {
        await attendanceApi.deleteSession(sessionId);
        setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
        setStatus({ ok: true, msg: "Session deleted" });
      } catch (e: any) { setStatus({ ok: false, msg: e.message }); }
    }
  }

  function downloadCsv(sessionId: string) {
    if (inDemoMode()) {
      const session = loadDemoSessions().find((s) => s.session_id === sessionId);
      if (!session) return;
      const start    = new Date(session.started_at).getTime();
      const end      = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
      const cap      = session.venue_capacity || 250;
      const peakEst  = session.peak_attendance > 0 ? session.peak_attendance : Math.round(cap * 0.8);
      const rows     = ["recorded_at,current_attendance,total_entries,total_exits,occupancy_percent"];
      let entries    = 0;
      let exits      = 0;
      const duration = end - start;
      for (let t = start; t <= end; t += 10 * 60_000) {
        const progress = (t - start) / Math.max(duration, 1);
        // Realistic ramp-up, plateau, ramp-down curve
        const curve    = progress < 0.4 ? progress / 0.4 : progress < 0.75 ? 1 : (1 - progress) / 0.25;
        const current  = Math.max(0, Math.round(peakEst * curve * (0.9 + Math.random() * 0.1)));
        const delta    = current - (entries - exits);
        if (delta > 0) entries += delta;
        else exits += Math.abs(delta);
        const occ = cap > 0 ? ((current / cap) * 100).toFixed(1) : "0.0";
        rows.push(`${new Date(t).toISOString()},${current},${entries},${exits},${occ}`);
      }
      const blob = new Blob([rows.join("\n")], { type: "text/csv" });
      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = `kyro-${session.name.replace(/\s+/g, "-").toLowerCase()}-${sessionId}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
      return;
    }
    const token = localStorage.getItem("kyro_token") ?? "";
    fetch(attendanceApi.exportSessionCsv(sessionId), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.blob() : Promise.reject(r))
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `kyro-session-${sessionId}.csv`;
        a.click(); URL.revokeObjectURL(a.href);
      })
      .catch(() => setStatus({ ok: false, msg: "CSV export failed" }));
  }

  const indoorCameras = cameras.filter((c) => c.location !== "queue");

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: BG }}>
      <Sidebar />
      <main className="flex-1 p-6 overflow-auto max-w-3xl flex flex-col gap-6">

        <div>
          <h1 className="text-xl font-bold text-white">Sessions</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Live cameras below — tap "Start session" to begin recording attendance
          </p>
        </div>

        {status && (
          <div className={`text-sm px-4 py-3 rounded-xl border ${status.ok ? "border-green-800 text-green-300" : "border-red-800 text-red-300"}`}
            style={{ background: status.ok ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)" }}>
            {status.msg}
          </div>
        )}

        {loadError && !inDemoMode() && (
          <div className="text-sm px-4 py-3 rounded-xl border border-amber-800 text-amber-300 flex items-center justify-between gap-3"
            style={{ background: "rgba(245,158,11,0.08)" }}>
            <span>Couldn't load sessions ({loadError}) — if you started one, it's very likely still running; this list just failed to refresh.</span>
            <button onClick={loadSessions} className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-amber-900/40 hover:bg-amber-900/60 border border-amber-700">
              Retry
            </button>
          </div>
        )}

        {/* Live camera cards — one per indoor camera */}
        {camsLoading || loading ? (
          <p className="text-sm text-gray-500 text-center py-8">Loading…</p>
        ) : indoorCameras.length === 0 ? (
          <div className="rounded-2xl p-8 text-center" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
            <Radio size={28} className="mx-auto mb-3 text-gray-700" />
            <p className="text-sm text-gray-500">No cameras registered — add cameras first to start sessions</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {indoorCameras.map((cam) => {
              const activeSession = sessions.find((s) => s.camera_id === cam.camera_id && !s.ended_at) ?? null;
              return (
                <LiveCameraCard
                  key={cam.camera_id}
                  camera={cam}
                  existingSession={activeSession}
                  onStart={handleQuickStart}
                  onEnd={handleEnd}
                  starting={starting}
                  ending={ending}
                />
              );
            })}
          </div>
        )}

        {/* Manual start — collapsed, for custom names */}
        {!camsLoading && indoorCameras.length > 0 && (
          <ManualStartForm
            cameras={indoorCameras}
            onCreated={(s) => {
              // Re-read from localStorage to get the full saved list
              setSessions(inDemoMode() ? loadDemoSessions() : (prev) => [s, ...prev]);
              setStatus({ ok: true, msg: `Session started — "${s.name}"` });
            }}
          />
        )}

        {/* Past sessions */}
        <SessionHistory sessions={sessions} onDownload={downloadCsv} onRename={handleRename} onDelete={handleDelete} />

      </main>
    </div>
  );
}
