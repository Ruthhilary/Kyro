"use client";

/**
 * SeatMap
 *
 * Renders an interactive floor plan of seats.
 * Each seat is coloured by its occupancy state.
 * Clicking a seat shows its details (for usher use).
 */

import { useState } from "react";
import type { SeatState, OccupancyState } from "@/types";

const STATE_COLOURS: Record<OccupancyState, string> = {
  occupied: "#ef4444",          // red
  temporarily_vacant: "#f59e0b", // amber
  likely_available: "#84cc16",  // lime
  available: "#22c55e",         // green
  unknown: "#6b7280",           // gray
};

const STATE_LABELS: Record<OccupancyState, string> = {
  occupied: "Occupied",
  temporarily_vacant: "Temp. Vacant",
  likely_available: "Likely Available",
  available: "Available",
  unknown: "Unknown",
};

interface SeatMapProps {
  seats: SeatState[];
  frameWidth?: number;
  frameHeight?: number;
}

export function SeatMap({ seats, frameWidth = 1280, frameHeight = 720 }: SeatMapProps) {
  const [selected, setSelected] = useState<SeatState | null>(null);

  // Scale seats to SVG viewport
  const vw = 800;
  const vh = 450;
  const scaleX = vw / frameWidth;
  const scaleY = vh / frameHeight;

  return (
    <div className="relative bg-gray-950 rounded-xl border border-gray-800 overflow-hidden">
      <svg viewBox={`0 0 ${vw} ${vh}`} className="w-full h-auto">
        {/* Floor background */}
        <rect width={vw} height={vh} fill="#111827" />

        {seats.map((seat) => {
          const [x1, y1, x2, y2] = seat.bbox;
          const sx = x1 * scaleX;
          const sy = y1 * scaleY;
          const sw = (x2 - x1) * scaleX;
          const sh = (y2 - y1) * scaleY;
          const colour = STATE_COLOURS[seat.state];
          const isSelected = selected?.seat_id === seat.seat_id;

          return (
            <g
              key={seat.seat_id}
              onClick={() => setSelected(seat)}
              style={{ cursor: "pointer" }}
            >
              <rect
                x={sx}
                y={sy}
                width={sw}
                height={sh}
                rx={3}
                fill={colour}
                fillOpacity={0.8}
                stroke={isSelected ? "#fff" : "transparent"}
                strokeWidth={2}
              />
              <text
                x={sx + sw / 2}
                y={sy + sh / 2 + 4}
                textAnchor="middle"
                fontSize={9}
                fill="#fff"
                fontFamily="Inter, sans-serif"
              >
                {seat.seat_id}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 p-3 border-t border-gray-800">
        {Object.entries(STATE_LABELS).map(([state, label]) => (
          <div key={state} className="flex items-center gap-1.5 text-xs text-gray-400">
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: STATE_COLOURS[state as OccupancyState] }}
            />
            {label}
          </div>
        ))}
      </div>

      {/* Seat detail tooltip */}
      {selected && (
        <div className="absolute top-3 right-3 bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs text-gray-200 min-w-[160px]">
          <div className="font-semibold text-white mb-1">{selected.seat_id}</div>
          <div>Section: {selected.section}</div>
          <div>State: {STATE_LABELS[selected.state]}</div>
          <div>Confidence: {(selected.confidence * 100).toFixed(0)}%</div>
          {selected.occupying_track_id && (
            <div>Track: #{selected.occupying_track_id}</div>
          )}
          <button
            onClick={() => setSelected(null)}
            className="mt-2 text-gray-400 hover:text-white"
          >
            ✕ close
          </button>
        </div>
      )}
    </div>
  );
}
