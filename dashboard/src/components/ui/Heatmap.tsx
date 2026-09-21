"use client";

import type { HeatmapData } from "@/types";

interface HeatmapProps {
  data: HeatmapData;
}

function lerp(a: string, b: string, t: number): string {
  // Simple hex colour lerp for heatmap colouring
  const ah = parseInt(a.slice(1), 16);
  const bh = parseInt(b.slice(1), 16);
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

export function Heatmap({ data }: HeatmapProps) {
  if (!data.grid.length) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-600 text-sm rounded-xl border border-gray-800 bg-gray-900">
        No heatmap data yet
      </div>
    );
  }

  const cellSize = Math.max(16, Math.floor(320 / data.cols));

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 overflow-auto">
      <p className="text-xs text-gray-500 mb-3">Seat utilisation (green = low, red = high)</p>
      <div
        className="inline-grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${data.cols}, ${cellSize}px)` }}
      >
        {data.grid.flat().map((value, idx) => (
          <div
            key={idx}
            title={`${(value * 100).toFixed(0)}%`}
            className="rounded-sm"
            style={{
              width: cellSize,
              height: cellSize,
              background: lerp("#22c55e", "#ef4444", value),
              opacity: 0.7 + value * 0.3,
            }}
          />
        ))}
      </div>
    </div>
  );
}
