"use client";

/**
 * AttendanceChart — SVG line chart for attendance history.
 * No external chart lib required. Pure SVG with viewBox scaling.
 */

import type { AttendancePoint } from "@/types";

interface AttendanceChartProps {
  data: AttendancePoint[];
  height?: number;
}

export function AttendanceChart({ data, height = 200 }: AttendanceChartProps) {
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-gray-600 text-sm rounded-xl border border-gray-800 bg-gray-900"
        style={{ height }}
      >
        Not enough data
      </div>
    );
  }

  const W = 800;
  const H = height;
  const PAD = { top: 16, right: 16, bottom: 32, left: 40 };

  const values = data.map((d) => d.attendance);
  const maxVal = Math.max(...values, 1);
  const minVal = 0;

  const xStep = (W - PAD.left - PAD.right) / (data.length - 1);
  const yScale = (v: number) =>
    PAD.top + (1 - (v - minVal) / (maxVal - minVal)) * (H - PAD.top - PAD.bottom);

  const points = data.map((d, i) => ({
    x: PAD.left + i * xStep,
    y: yScale(d.attendance),
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  const areaD =
    `M ${points[0].x.toFixed(1)} ${H - PAD.bottom} ` +
    pathD.slice(1) +
    ` L ${points[points.length - 1].x.toFixed(1)} ${H - PAD.bottom} Z`;

  // Y axis tick labels
  const ticks = [0, Math.round(maxVal * 0.5), maxVal];

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}>
        {/* Grid lines */}
        {ticks.map((t) => (
          <line
            key={t}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yScale(t)}
            y2={yScale(t)}
            stroke="#1f2937"
            strokeWidth={1}
          />
        ))}

        {/* Area fill */}
        <path d={areaD} fill="#6366f1" fillOpacity={0.12} />

        {/* Line */}
        <path d={pathD} fill="none" stroke="#6366f1" strokeWidth={2} />

        {/* Y axis labels */}
        {ticks.map((t) => (
          <text
            key={t}
            x={PAD.left - 6}
            y={yScale(t) + 4}
            textAnchor="end"
            fontSize={10}
            fill="#6b7280"
          >
            {t}
          </text>
        ))}

        {/* X axis: first and last timestamp */}
        {[0, data.length - 1].map((i) => (
          <text
            key={i}
            x={PAD.left + i * xStep}
            y={H - 8}
            textAnchor={i === 0 ? "start" : "end"}
            fontSize={9}
            fill="#6b7280"
          >
            {new Date(data[i].timestamp).toLocaleDateString()}
          </text>
        ))}
      </svg>
    </div>
  );
}
