"use client";

import { useState } from "react";
import { usePipelineStream } from "@/hooks/usePipelineStream";
import { StatCard } from "@/components/ui/StatCard";
import { SeatMap } from "@/components/ui/SeatMap";
import { Sidebar } from "@/components/layout/Sidebar";
import { CameraSwitcher } from "@/components/layout/CameraSwitcher";

const DEFAULT_CAMERA = process.env.NEXT_PUBLIC_CAMERA_ID ?? "cam-01";

export default function DashboardPage() {
  const [cameraId, setCameraId] = useState(DEFAULT_CAMERA);
  const { data, connected, error } = usePipelineStream(cameraId);

  const att  = data?.attendance;
  const seats = data?.seat_states ?? [];

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <Sidebar />

      <main className="flex-1 p-6 overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Live View</h1>
            <p className="text-sm text-gray-400">Real-time attendance & seat occupancy</p>
          </div>

          <div className="flex items-center gap-4">
            <CameraSwitcher activeCameraId={cameraId} onChange={setCameraId} />
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  connected ? "bg-green-500 animate-pulse" : "bg-red-500"
                }`}
              />
              <span className="text-xs text-gray-400">
                {connected ? "Live" : "Disconnected"}
              </span>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/30 border border-red-700 text-red-300 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <StatCard label="Current Attendance" value={att?.current ?? "—"} highlight />
          <StatCard label="Peak Attendance"    value={att?.peak ?? "—"} />
          <StatCard label="Total Entries"      value={att?.entries ?? "—"} />
          <StatCard label="Total Exits"        value={att?.exits ?? "—"} />
          <StatCard label="Occupancy"          value={att ? `${att.occupancy_pct}%` : "—"} />
        </div>

        {/* Seat map */}
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Seat Occupancy — {cameraId}
          </h2>
          <SeatMap seats={seats} />
        </div>

        {/* Perf footer */}
        {data?.perf && (
          <p className="text-xs text-gray-600 text-right">
            Inference {data.perf.inference_ms}ms · Total {data.perf.total_ms}ms · Frame #{data.frame_number}
          </p>
        )}
      </main>
    </div>
  );
}
