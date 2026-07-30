"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { CameraSwitcher } from "@/components/layout/CameraSwitcher";
import { SeatLayoutEditor } from "@/components/ui/SeatLayoutEditor";
import { seatsApi } from "@/lib/api";
import type { SeatLayout } from "@/types";

const DEFAULT_CAMERA = process.env.NEXT_PUBLIC_CAMERA_ID ?? "cam-01";

export default function LayoutEditorPage() {
  const [cameraId, setCameraId] = useState(DEFAULT_CAMERA);
  const [layouts, setLayouts] = useState<SeatLayout[]>([]);
  const [activating, setActivating] = useState<number | null>(null);
  const [activateStatus, setActivateStatus] = useState<string | null>(null);

  async function loadLayouts() {
    try {
      setLayouts(await seatsApi.listLayouts(cameraId));
    } catch {
      setLayouts([]);
    }
  }

  useEffect(() => { loadLayouts(); }, [cameraId]);

  async function activate(layoutId: number) {
    setActivating(layoutId);
    setActivateStatus(null);
    try {
      const res = await seatsApi.activateLayout(cameraId, layoutId);
      setActivateStatus(`✅ Activated — ${res.seat_count} seats loaded into pipeline`);
      await loadLayouts();
    } catch (e: any) {
      setActivateStatus(`❌ ${e.message}`);
    } finally {
      setActivating(null);
    }
  }

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <Sidebar />
      <main className="flex-1 p-6 overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Seat Layout Editor</h1>
            <p className="text-sm text-gray-400">
              Draw seat positions on a camera frame, save, then activate
            </p>
          </div>
          <CameraSwitcher activeCameraId={cameraId} onChange={setCameraId} />
        </div>

        {/* Editor */}
        <div className="mb-8">
          <SeatLayoutEditor
            cameraId={cameraId}
            onSaved={() => loadLayouts()}
          />
        </div>

        {/* Saved layouts */}
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Saved Layouts
          </h2>

          {activateStatus && (
            <p className="text-xs mb-3 text-indigo-300 bg-indigo-900/20 border border-indigo-800 rounded-lg px-3 py-2">
              {activateStatus}
            </p>
          )}

          {layouts.length === 0 ? (
            <p className="text-gray-600 text-sm">No layouts saved yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {layouts.map((lay) => (
                <div
                  key={lay.id}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                    lay.is_active
                      ? "border-indigo-600 bg-indigo-900/20"
                      : "border-gray-800 bg-gray-900"
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-white">
                      {lay.name}
                      {lay.is_active && (
                        <span className="ml-2 text-xs text-indigo-400">(active)</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      {lay.seat_count} seats · saved{" "}
                      {new Date(lay.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    disabled={lay.is_active || activating === lay.id}
                    onClick={() => activate(lay.id)}
                    className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg px-3 py-1.5 font-medium"
                  >
                    {activating === lay.id ? "Activating…" : lay.is_active ? "Active" : "Activate"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
