"use client";

import { useEffect, useState } from "react";
import { analyticsApi } from "@/lib/api";
import { AttendanceChart } from "@/components/ui/AttendanceChart";
import { Heatmap } from "@/components/ui/Heatmap";
import { StatCard } from "@/components/ui/StatCard";
import { Sidebar } from "@/components/layout/Sidebar";
import { CameraSwitcher } from "@/components/layout/CameraSwitcher";
import type {
  AttendancePoint,
  HeatmapData,
  AnalyticsSummary,
  HourlyBucket,
} from "@/types";

const DEFAULT_CAMERA = process.env.NEXT_PUBLIC_CAMERA_ID ?? "cam-01";

export default function AnalyticsPage() {
  const [cameraId, setCameraId] = useState(DEFAULT_CAMERA);
  const [history, setHistory] = useState<AttendancePoint[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapData | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [arrival, setArrival] = useState<HourlyBucket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      analyticsApi.history(cameraId, 30),
      analyticsApi.heatmap(cameraId, 30),
      analyticsApi.summary(cameraId),
      analyticsApi.arrival(cameraId, 30),
    ])
      .then(([h, hm, s, arr]) => {
        setHistory(h);
        setHeatmap(hm);
        setSummary(s);
        setArrival(arr);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [cameraId]);

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <Sidebar />
      <main className="flex-1 p-6 overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Analytics</h1>
            <p className="text-sm text-gray-400">Historical attendance & seat utilisation</p>
          </div>
          <CameraSwitcher activeCameraId={cameraId} onChange={setCameraId} />
        </div>

        {loading && (
          <div className="text-gray-500 text-sm py-12 text-center">Loading analytics…</div>
        )}

        {!loading && (
          <>
            {/* Summary stats */}
            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <StatCard label="Total Sessions"   value={summary.total_sessions} />
                <StatCard label="All-Time Peak"    value={summary.all_time_peak} highlight />
                <StatCard label="Avg Attendance"   value={summary.avg_attendance} />
                <StatCard label="Avg Occupancy"    value={`${summary.avg_occupancy_pct}%`} />
              </div>
            )}

            {/* Attendance history chart */}
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Attendance History (30 days)
              </h2>
              <AttendanceChart data={history} height={220} />
            </div>

            {/* Seat heatmap + Arrival pattern side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  Seat Utilisation Heatmap
                </h2>
                {heatmap && <Heatmap data={heatmap} />}
              </div>

              <div>
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  Arrival Pattern (by hour)
                </h2>
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                  <div className="flex items-end gap-1 h-32">
                    {arrival.map((b) => {
                      const maxCount = Math.max(...arrival.map((a) => a.count), 1);
                      const pct = (b.count / maxCount) * 100;
                      return (
                        <div
                          key={b.hour}
                          className="flex-1 flex flex-col items-center gap-1"
                          title={`${b.hour}:00 — ${b.count} arrivals`}
                        >
                          <div
                            className="w-full bg-indigo-500 rounded-t-sm"
                            style={{ height: `${pct}%`, minHeight: pct > 0 ? 2 : 0 }}
                          />
                          {b.hour % 6 === 0 && (
                            <span className="text-gray-600 text-[8px]">{b.hour}h</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
