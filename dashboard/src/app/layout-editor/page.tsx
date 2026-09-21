"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { CameraSwitcher } from "@/components/layout/CameraSwitcher";
import { SeatLayoutEditor } from "@/components/ui/SeatLayoutEditor";
import { seatsApi } from "@/lib/api";
import type { SeatLayout } from "@/types";
import { Trash2, Play, Info, X } from "lucide-react";

const DEFAULT_CAMERA = process.env.NEXT_PUBLIC_CAMERA_ID ?? "cam-01";

export default function LayoutEditorPage() {
  const [cameraId, setCameraId]         = useState(DEFAULT_CAMERA);
  const [layouts, setLayouts]           = useState<SeatLayout[]>([]);
  const [activating, setActivating]     = useState<number | null>(null);
  const [deleting, setDeleting]         = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [status, setStatus]             = useState<{ msg: string; ok: boolean } | null>(null);

  async function loadLayouts() {
    try { setLayouts(await seatsApi.listLayouts(cameraId)); }
    catch { setLayouts([]); }
  }

  useEffect(() => { loadLayouts(); }, [cameraId]);

  async function activate(layoutId: number) {
    setActivating(layoutId);
    setStatus(null);
    try {
      const res = await seatsApi.activateLayout(cameraId, layoutId);
      setStatus({ ok: true, msg: `Activated — ${res.seat_count} seats loaded into pipeline` });
      await loadLayouts();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message });
    } finally {
      setActivating(null);
    }
  }

  async function deleteLayout(layoutId: number) {
    setDeleting(layoutId);
    setStatus(null);
    try {
      await seatsApi.deleteLayout(cameraId, layoutId);
      setConfirmDelete(null);
      await loadLayouts();
    } catch (e: any) {
      setStatus({ ok: false, msg: `Delete failed: ${e.message}` });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <Sidebar />
      <main className="flex-1 p-6 overflow-auto min-w-0">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Seat Layout Editor</h1>
            <p className="text-sm text-gray-400">
              Venue snapshot loads automatically — draw seats and mark zones (stage, altar, entrance) right on it
            </p>
          </div>
          <CameraSwitcher activeCameraId={cameraId} onChange={setCameraId} />
        </div>

        {/* Editor */}
        <div className="mb-8">
          <SeatLayoutEditor cameraId={cameraId} onSaved={() => loadLayouts()} />
        </div>

        {/* Saved layouts */}
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Saved Layouts
          </h2>

          {/* Activate info banner */}
          <div className="flex items-start gap-2.5 rounded-xl px-4 py-3 mb-4"
            style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)" }}>
            <Info size={14} className="text-indigo-400 shrink-0 mt-0.5" />
            <p className="text-xs text-gray-400 leading-relaxed">
              <span className="text-white font-medium">Activate</span> loads a saved layout into the live AI pipeline.
              This requires a real camera connected and the vision worker running
              (<span className="font-mono text-indigo-300">python -m ai.worker --camera-id {cameraId} --stream &lt;rtsp-url&gt;</span>).
              Layouts are saved regardless and will be ready when you connect a camera.
            </p>
          </div>

          {status && (
            <div className={`text-xs mb-3 rounded-lg px-3 py-2 border flex items-center justify-between gap-3 ${
              status.ok
                ? "text-green-300 bg-green-900/20 border-green-800"
                : "text-red-300 bg-red-900/20 border-red-800"
            }`}>
              <span>{status.msg}</span>
              <button onClick={() => setStatus(null)} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
                <X size={13} />
              </button>
            </div>
          )}

          {layouts.length === 0 ? (
            <p className="text-gray-600 text-sm">No layouts saved yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {layouts.map((lay) => (
                <div key={lay.id}
                  className={`rounded-xl border px-4 py-3 ${
                    lay.is_active
                      ? "border-indigo-600 bg-indigo-900/20"
                      : "border-gray-800 bg-gray-900"
                  }`}
                >
                  {/* Confirm delete overlay */}
                  {confirmDelete === lay.id ? (
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm text-white">
                        Delete <span className="font-semibold">{lay.name}</span>? This cannot be undone.
                      </p>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => deleteLayout(lay.id)}
                          disabled={deleting === lay.id}
                          className="text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium disabled:opacity-50"
                        >
                          {deleting === lay.id ? "Deleting…" : "Yes, delete"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white">
                          {lay.name}
                          {lay.is_active && (
                            <span className="ml-2 text-xs text-indigo-400">(active)</span>
                          )}
                        </p>
                        <p className="text-xs text-gray-500">
                          {lay.seat_count} seats · saved {new Date(lay.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {/* Delete */}
                        <button
                          onClick={() => setConfirmDelete(lay.id)}
                          className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                          aria-label="Delete layout"
                        >
                          <Trash2 size={14} />
                        </button>
                        {/* Activate */}
                        <button
                          disabled={lay.is_active || activating === lay.id}
                          onClick={() => activate(lay.id)}
                          className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg px-3 py-1.5 font-medium"
                        >
                          <Play size={11} />
                          {activating === lay.id ? "Activating…" : lay.is_active ? "Active" : "Activate"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
