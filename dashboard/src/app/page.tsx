"use client";

import { usePipelineStream } from "@/hooks/usePipelineStream";
import { StatCard } from "@/components/ui/StatCard";
import { SeatMap } from "@/components/ui/SeatMap";

const CAMERA_ID = process.env.NEXT_PUBLIC_CAMERA_ID ?? "cam-01";

export default function DashboardPage() {
  const { data, connected, error } = usePipelineStream(CAMERA_ID);

  const att = data?.attendance;
  const seats = data?.seat_states ?? [];

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Kyro</h1>
          <p className="text-sm text-gray-400">Live Attendance Intelligence · {CAMERA_ID}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-red-500"}`}
          />
          <span className="text-sm text-gray-400">{connected ? "Live" : "Disconnected"}</span>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/30 border border-red-700 text-red-300 text-sm px-4 py-3">
          {error}
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <StatCard label="Current Attendance" value={att?.current ?? "—"} highlight />
        <StatCard label="Peak Attendance" value={att?.peak ?? "—"} />
        <StatCard label="Total Entries" value={att?.entries ?? "—"} />
        <StatCard label="Total Exits" value={att?.exits ?? "—"} />
        <StatCard label="Occupancy" value={att ? `${att.occupancy_pct}%` : "—"} />
      </div>

      {/* Seat map */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Seat Occupancy
        </h2>
        <SeatMap seats={seats} />
      </div>

      {/* Performance footer */}
      {data?.perf && (
        <p className="text-xs text-gray-600 text-right">
          Inference {data.perf.inference_ms}ms · Total {data.perf.total_ms}ms · Frame #{data.frame_number}
        </p>
      )}
    </main>
  );
}
