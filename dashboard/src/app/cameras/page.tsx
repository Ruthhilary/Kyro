"use client";

import { FormEvent, useState, useEffect } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { useCameras } from "@/hooks/useCameras";
import { DEMO_MODE } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";
import { ErrorMessage } from "@/components/ui/ErrorMessage";
import {
  Camera, Wifi, Monitor, HelpCircle,
  ChevronDown, ChevronUp, Plus, Pencil, Check, X, Terminal,
  Users, MapPin, AlertCircle, Trash2,
} from "lucide-react";
import type { Camera as CameraType } from "@/types";

// ─── Queue camera detection ───────────────────────────────────────────────────

const QUEUE_KEYWORDS = ["outside", "queue", "entrance", "foyer", "lobby", "car park",
  "carpark", "waiting", "exterior", "outdoor", "outside area", "front door", "gate"];

function looksLikeQueue(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return QUEUE_KEYWORDS.some((kw) => lower.includes(kw));
}

function isQueueCamera(cam: CameraType): boolean {
  return cam.location === "queue" || looksLikeQueue(cam.name) || looksLikeQueue(cam.zone_name ?? "");
}

// ─── Camera type options ──────────────────────────────────────────────────────

const CAMERA_TYPES = [
  {
    id: "ip",
    label: "IP / Network Camera",
    description: "Security camera on WiFi or ethernet",
    icon: Wifi,
    urlTemplate: "rtsp://admin:password@192.168.1.XX/stream",
    urlHint: "Found in your camera's app or web interface under Settings → Network",
    urlPlaceholder: "rtsp://192.168.1.100/stream",
  },
  {
    id: "webcam",
    label: "USB Webcam",
    description: "Webcam plugged into this computer",
    icon: Camera,
    urlTemplate: "0",
    urlHint: "Use 0 for the first webcam, 1 for a second",
    urlPlaceholder: "0",
  },
  {
    id: "other",
    label: "Other",
    description: "Any RTSP, MJPEG, or custom URL",
    icon: Monitor,
    urlTemplate: "",
    urlHint: "Enter the full stream URL",
    urlPlaceholder: "rtsp://...",
  },
] as const;

// ─── Registered camera card ───────────────────────────────────────────────────

function CameraCard({ cam, onUpdated, onUpdate, onDelete }: {
  cam: CameraType;
  onUpdated: () => void;
  onUpdate: (id: string, fields: Partial<CameraType>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing]       = useState(false);
  const [draft, setDraft]           = useState({
    name:          cam.name,
    zone_name:     cam.zone_name ?? cam.name,
    stream_url:    cam.stream_url,
    zone_capacity: cam.zone_capacity ?? 0,
    location:      cam.location ?? "",
  });
  const [showCmd, setShowCmd]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]     = useState(false);

  const isQueue  = isQueueCamera(cam);
  const isWebcam = cam.stream_url === "0" || /^\d$/.test(cam.stream_url);

  async function save() {
    setSaving(true); setErr(null);
    try {
      await onUpdate(cam.camera_id, {
        name:          draft.name.trim()      || cam.name,
        zone_name:     draft.zone_name.trim() || cam.name,
        stream_url:    draft.stream_url.trim(),
        zone_capacity: draft.location === "queue" ? 0 : (Number(draft.zone_capacity) || 0),
        location:      draft.location || undefined,
      });
      setEditing(false);
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete(cam.camera_id);
    } catch (e: any) {
      setErr(e.message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className={`bg-gray-900 rounded-xl overflow-hidden border ${
      isQueue ? "border-amber-900/40" : "border-gray-800"
    }`}>
      {/* Queue badge */}
      {isQueue && !editing && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs font-medium"
          style={{ background: "rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.2)" }}>
          <Users size={12} className="text-amber-400" />
          <span className="text-amber-300">Queue / outdoor camera</span>
          <span className="text-gray-500 ml-auto">counts people waiting — not seats</span>
        </div>
      )}

      <div className="px-4 py-4">
        {editing ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Camera name</label>
                <input value={draft.name} onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Zone name</label>
                <input value={draft.zone_name} onChange={(e) => setDraft((p) => ({ ...p, zone_name: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Stream URL</label>
                <input value={draft.stream_url} onChange={(e) => setDraft((p) => ({ ...p, stream_url: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Camera type</label>
                <select value={draft.location} onChange={(e) => setDraft((p) => ({ ...p, location: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Indoor (has seats)</option>
                  <option value="queue">Outdoor / queue (no seats)</option>
                </select>
              </div>
            </div>
            {draft.location !== "queue" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Seat capacity</label>
                <input type="number" min="0" value={draft.zone_capacity}
                  onChange={(e) => setDraft((p) => ({ ...p, zone_capacity: Number(e.target.value) }))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-40" />
              </div>
            )}
            {err && <p className="text-red-400 text-xs">{err}</p>}
            <div className="flex gap-2">
              <button onClick={save} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50">
                <Check size={13} /> {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => { setEditing(false); setErr(null); }}
                className="px-4 py-2 rounded-lg text-xs text-gray-400 hover:text-white bg-gray-800">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-semibold text-white">{cam.name}</p>
              <button onClick={() => setEditing(true)} className="text-gray-600 hover:text-gray-300 transition-colors">
                <Pencil size={12} />
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="ml-auto text-gray-600 hover:text-red-400 transition-colors"
                title="Delete camera"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {/* Delete confirmation */}
            {confirmDelete && (
              <div className="mb-3 rounded-xl px-4 py-3 flex flex-col gap-2"
                style={{ background: "rgba(185,28,28,0.1)", border: "1px solid rgba(185,28,28,0.4)" }}>
                <p className="text-sm font-semibold text-white">Delete "{cam.name}"?</p>
                <p className="text-xs text-gray-400">This will permanently remove the camera. This can't be undone.</p>
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-700 hover:bg-red-600 disabled:opacity-50"
                  >
                    <Trash2 size={11} />
                    {deleting ? "Deleting…" : "Yes, delete it"}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-gray-500">Zone:</span>
              <span className="text-xs font-medium text-indigo-400">
                {cam.zone_name || <span className="text-gray-600 italic">not set</span>}
              </span>
              <button onClick={() => setEditing(true)} className="text-gray-600 hover:text-gray-300 transition-colors">
                <Pencil size={11} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-gray-600">
                {isWebcam ? <Camera size={12} /> : <Wifi size={12} />}
                <span className="font-mono truncate max-w-[200px]">{cam.stream_url}</span>
                {!isQueue && cam.zone_capacity > 0 && (
                  <span>· {cam.zone_capacity.toLocaleString()} seats</span>
                )}
                {isQueue && <span className="text-amber-600">· queue counter</span>}
              </div>
              <button onClick={() => setShowCmd((p) => !p)}
                className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-900 rounded-lg px-2.5 py-1">
                <Terminal size={11} />
                {showCmd ? "Hide command" : "Start worker"}
              </button>
            </div>
          </>
        )}
      </div>

      {showCmd && !editing && (
        <div className="border-t border-gray-800 bg-gray-950 px-4 py-3">
          <p className="text-xs text-gray-500 mb-2">Run on the machine where Kyro is installed:</p>
          <pre className="text-xs text-indigo-300 font-mono bg-gray-900 rounded-lg px-3 py-2 overflow-x-auto">
            python -m ai.worker --camera-id {cam.camera_id} --stream {cam.stream_url}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Add camera form ──────────────────────────────────────────────────────────

function AddCameraForm({ onAdded, cameraCount }: { onAdded: () => void; cameraCount: number }) {
  const { addCamera } = useCameras();
  const [open, setOpen]         = useState(cameraCount === 0);
  const [type, setType]         = useState<typeof CAMERA_TYPES[number] | null>(null);
  const [name, setName]         = useState("");
  const [url, setUrl]           = useState("");
  const [zone, setZone]         = useState("");
  const [cap, setCap]           = useState("");
  const [adding, setAdding]     = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  // Smart detection state
  const [queuePrompt, setQueuePrompt]   = useState<"idle" | "asking" | "confirmed" | "dismissed">("idle");
  const [isQueueCam, setIsQueueCam]     = useState(false);

  function handleNameChange(val: string) {
    setName(val);
    if (looksLikeQueue(val) && queuePrompt === "idle" && !isQueueCam) {
      setQueuePrompt("asking");
    } else if (!looksLikeQueue(val) && queuePrompt === "asking") {
      setQueuePrompt("idle");
    }
  }

  function confirmQueue(yes: boolean) {
    setIsQueueCam(yes);
    setQueuePrompt(yes ? "confirmed" : "dismissed");
    if (yes) {
      setCap("0"); // no seats for queue cameras
      if (!zone) setZone("Outside Queue");
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true); setErr(null);
    try {
      await addCamera({
        name,
        stream_url:    url,
        zone_name:     zone || name,
        zone_capacity: isQueueCam ? 0 : (parseInt(cap, 10) || 0),
        zone_order:    cameraCount,
        location:      isQueueCam ? "queue" : undefined,
      });
      setName(""); setUrl(""); setZone(""); setCap("");
      setType(null); setIsQueueCam(false); setQueuePrompt("idle");
      setOpen(false);
      onAdded();
    } catch (e: any) { setErr(e.message); }
    finally { setAdding(false); }
  }

  return (
    <div className="border border-gray-800 rounded-xl overflow-hidden">
      <button onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-colors">
        <div className="flex items-center gap-2">
          <Plus size={15} className="text-indigo-400" />
          <span className="text-sm font-medium text-white">Add a camera</span>
        </div>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {open && (
        <div className="bg-gray-900 border-t border-gray-800 p-4 flex flex-col gap-4">

          {/* Camera type */}
          <div>
            <p className="text-xs text-gray-400 mb-2">What type of camera?</p>
            <div className="grid grid-cols-3 gap-2">
              {CAMERA_TYPES.map((t) => {
                const Icon = t.icon;
                const active = type?.id === t.id;
                return (
                  <button key={t.id} onClick={() => { setType(t); setUrl(t.urlTemplate); }}
                    className={`text-left rounded-lg border p-3 transition-colors ${
                      active ? "border-indigo-600 bg-indigo-900/20" : "border-gray-700 hover:border-gray-600"
                    }`}>
                    <Icon size={15} className={active ? "text-indigo-400" : "text-gray-500"} />
                    <p className={`text-xs font-medium mt-1.5 ${active ? "text-white" : "text-gray-400"}`}>{t.label}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {type && (
            <form onSubmit={handleAdd} className="flex flex-col gap-3">

              {/* Name + zone */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-400">Camera name</label>
                  <input value={name} onChange={(e) => handleNameChange(e.target.value)} required
                    placeholder="e.g. Main Auditorium"
                    className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-400">Zone / area name</label>
                  <input value={zone} onChange={(e) => setZone(e.target.value)}
                    placeholder="e.g. Main Floor, Balcony"
                    className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>

              {/* Smart queue detection prompt */}
              {queuePrompt === "asking" && (
                <div className="rounded-xl p-4 flex flex-col gap-3"
                  style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)" }}>
                  <div className="flex items-start gap-2.5">
                    <AlertCircle size={16} className="text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-white mb-0.5">Is this an outdoor or queue camera?</p>
                      <p className="text-xs text-gray-400 leading-relaxed">
                        It looks like this camera might be watching an outside area or entrance queue —
                        not a seated room. Outdoor cameras don't have seats — they count
                        how many people are waiting outside to come in, which feeds the
                        "Outside queue" estimator on the Live Cameras page.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => confirmQueue(true)}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
                      style={{ background: "rgba(245,158,11,0.7)" }}>
                      <Users size={14} /> Yes, it's an outdoor/queue camera
                    </button>
                    <button type="button" onClick={() => confirmQueue(false)}
                      className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white bg-gray-800">
                      No, it has seats
                    </button>
                  </div>
                </div>
              )}

              {/* Queue camera confirmed */}
              {(queuePrompt === "confirmed" || isQueueCam) && (
                <div className="rounded-xl px-4 py-3 flex items-center gap-2.5"
                  style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
                  <Users size={14} className="text-amber-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-xs font-medium text-amber-300">Outdoor / queue camera</p>
                    <p className="text-xs text-gray-500">
                      This camera will count people waiting outside. Its count feeds directly into the
                      Outside Queue on the Live Cameras page. No seat capacity needed.
                    </p>
                  </div>
                  <button type="button" onClick={() => { setIsQueueCam(false); setQueuePrompt("dismissed"); }}
                    className="text-gray-600 hover:text-gray-400 shrink-0">
                    <X size={13} />
                  </button>
                </div>
              )}

              {/* URL + capacity */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-400">Stream address</label>
                  <input value={url} onChange={(e) => setUrl(e.target.value)} required
                    placeholder={type.urlPlaceholder}
                    className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                  <p className="text-xs text-gray-600">{type.urlHint}</p>
                </div>
                {!isQueueCam && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-400">Seat capacity (optional)</label>
                    <input value={cap} onChange={(e) => setCap(e.target.value)}
                      type="number" min="0" placeholder="e.g. 250"
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                )}
              </div>

              {err && <p className="text-red-400 text-xs">{err}</p>}

              <button type="submit" disabled={adding}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 font-medium self-start">
                {adding ? "Adding…" : "Add camera"}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function HelpPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
      <button onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-400 hover:text-white">
        <div className="flex items-center gap-2">
          <HelpCircle size={14} />
          <span>How do I find my camera's stream address?</span>
        </div>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-gray-800 pt-3 text-xs text-gray-400 flex flex-col gap-3">
          <div>
            <p className="text-white font-medium mb-1">IP cameras (Hikvision, Reolink, TP-Link, Dahua…)</p>
            <p>Open the camera's app or web interface → Settings → Network → copy the RTSP URL. Looks like: <span className="font-mono text-indigo-300">rtsp://admin:password@192.168.1.100:554/stream</span></p>
          </div>
          <div>
            <p className="text-white font-medium mb-1">USB webcam</p>
            <p>Enter <span className="font-mono text-indigo-300">0</span> for the first webcam, <span className="font-mono text-indigo-300">1</span> for a second one.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CamerasPage() {
  const { cameras, loading, error, refresh, updateCamera, deleteCamera } = useCameras();

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <Sidebar />
      <main className="flex-1 p-6 max-w-2xl">

        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Cameras</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Add cameras and rename zones any time
          </p>
        </div>

        {inDemoMode() && (
          <div className="mb-4 text-xs rounded-xl px-4 py-3" style={{ color: "#a5b4fc", background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.25)" }}>
            Demo mode — cameras added here are saved locally and will appear across all pages.
          </div>
        )}

        {error && (
          <ErrorMessage message={error} onRetry={refresh} />
        )}

        {!error && loading && (
          <p className="text-sm text-gray-500 py-8 text-center">Loading cameras…</p>
        )}

        {!error && !loading && cameras.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Registered ({cameras.length})
            </p>
            <div className="flex flex-col gap-3">
              {cameras.map((cam) => (
                <CameraCard key={cam.camera_id} cam={cam} onUpdated={refresh} onUpdate={updateCamera} onDelete={deleteCamera} />
              ))}
            </div>
          </div>
        )}

        {!error && !loading && <AddCameraForm onAdded={refresh} cameraCount={cameras.length} />}

        <div className="mt-4">
          <HelpPanel />
        </div>

      </main>
    </div>
  );
}
