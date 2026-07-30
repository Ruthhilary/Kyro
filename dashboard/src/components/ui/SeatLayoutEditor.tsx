"use client";

/**
 * Seat Layout Editor
 *
 * Canvas-based tool for defining seat positions on a camera frame.
 *
 * How it works:
 * 1. User uploads a screenshot / still frame from the camera.
 * 2. User draws bounding boxes over each seat by clicking and dragging.
 * 3. Each box gets a seat ID (auto-generated or custom).
 * 4. User assigns row, number, and section metadata.
 * 5. Save → POST to /api/v1/seats/{camera_id}/layouts
 * 6. Activate → PUT /activate makes the pipeline use this layout immediately.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SeatDefinition } from "@/types";
import { seatsApi } from "@/lib/api";

interface Point { x: number; y: number }

interface DraftBox {
  start: Point;
  end: Point;
}

interface SeatLayoutEditorProps {
  cameraId: string;
  onSaved?: (layoutId: number) => void;
}

// ── helper ──────────────────────────────────────────────────────────────────

function ptToCanvas(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement
): Point {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top)  * scaleY,
  };
}

function boxToSeatDef(
  box: { start: Point; end: Point },
  index: number,
  section: string,
): SeatDefinition {
  const x1 = Math.min(box.start.x, box.end.x);
  const y1 = Math.min(box.start.y, box.end.y);
  const x2 = Math.max(box.start.x, box.end.x);
  const y2 = Math.max(box.start.y, box.end.y);
  const row = String.fromCharCode(65 + Math.floor(index / 20));   // A, B, C…
  const num = (index % 20) + 1;
  return {
    seat_id: `${row}-${num}`,
    row,
    number: num,
    section,
    bbox: [x1, y1, x2, y2],
  };
}

// ── component ────────────────────────────────────────────────────────────────

export function SeatLayoutEditor({ cameraId, onSaved }: SeatLayoutEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [seats, setSeats] = useState<SeatDefinition[]>([]);
  const [draft, setDraft] = useState<DraftBox | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [section, setSection] = useState("Main Floor");
  const [layoutName, setLayoutName] = useState("New Layout");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // ── render ─────────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background image
    if (bgImage) {
      ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#6b7280";
      ctx.font = "14px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Upload a camera screenshot to begin", canvas.width / 2, canvas.height / 2);
    }

    // Saved seats
    seats.forEach((seat, i) => {
      const [x1, y1, x2, y2] = seat.bbox;
      const isSelected = i === selectedIdx;
      ctx.strokeStyle = isSelected ? "#f59e0b" : "#22c55e";
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = isSelected ? "rgba(245,158,11,0.15)" : "rgba(34,197,94,0.12)";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

      // Label
      ctx.fillStyle = "#fff";
      ctx.font = "9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(seat.seat_id, (x1 + x2) / 2, (y1 + y2) / 2 + 3);
    });

    // Draft box
    if (draft) {
      const { start, end } = draft;
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      ctx.setLineDash([]);
    }
  }, [bgImage, seats, draft, selectedIdx]);

  useEffect(() => { render(); }, [render]);

  // ── mouse events ───────────────────────────────────────────────────────

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const pt = ptToCanvas(e.clientX, e.clientY, canvas);
    setDrawing(true);
    setDraft({ start: pt, end: pt });
    setSelectedIdx(null);
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drawing || !draft) return;
    const canvas = canvasRef.current!;
    const pt = ptToCanvas(e.clientX, e.clientY, canvas);
    setDraft({ start: draft.start, end: pt });
  }

  function onMouseUp() {
    if (!drawing || !draft) return;
    setDrawing(false);

    const w = Math.abs(draft.end.x - draft.start.x);
    const h = Math.abs(draft.end.y - draft.start.y);
    if (w < 8 || h < 8) {
      // Too small — check if it's a click on an existing seat
      const canvas = canvasRef.current!;
      const x = (draft.start.x + draft.end.x) / 2;
      const y = (draft.start.y + draft.end.y) / 2;
      const idx = seats.findIndex(
        (s) => x >= s.bbox[0] && x <= s.bbox[2] && y >= s.bbox[1] && y <= s.bbox[3]
      );
      setSelectedIdx(idx >= 0 ? idx : null);
      setDraft(null);
      return;
    }

    const newSeat = boxToSeatDef(draft, seats.length, section);
    setSeats((prev) => [...prev, newSeat]);
    setDraft(null);
  }

  // ── image upload ───────────────────────────────────────────────────────

  function onImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setBgImage(img);
    img.src = url;
  }

  // ── delete selected ───────────────────────────────────────────────────

  function deleteSelected() {
    if (selectedIdx === null) return;
    setSeats((prev) => {
      const updated = prev.filter((_, i) => i !== selectedIdx);
      // Re-assign seat IDs
      return updated.map((s, i) => boxToSeatDef(
        { start: { x: s.bbox[0], y: s.bbox[1] }, end: { x: s.bbox[2], y: s.bbox[3] } },
        i,
        s.section,
      ));
    });
    setSelectedIdx(null);
  }

  // ── save ──────────────────────────────────────────────────────────────

  async function saveLayout() {
    if (seats.length === 0) { setStatus("Add at least one seat first"); return; }
    setSaving(true);
    setStatus(null);
    try {
      const layout = await seatsApi.createLayout(cameraId, {
        name: layoutName,
        seats,
      });
      setStatus(`Saved "${layout.name}" — ${layout.seat_count} seats (ID: ${layout.id})`);
      onSaved?.(layout.id);
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-gray-400 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-gray-700">
          📷 Upload Frame
          <input type="file" accept="image/*" className="hidden" onChange={onImageUpload} />
        </label>

        <input
          value={layoutName}
          onChange={(e) => setLayoutName(e.target.value)}
          placeholder="Layout name"
          className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 w-40 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        <input
          value={section}
          onChange={(e) => setSection(e.target.value)}
          placeholder="Section name"
          className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 w-36 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        <span className="text-xs text-gray-500">{seats.length} seat{seats.length !== 1 ? "s" : ""}</span>

        {selectedIdx !== null && (
          <button
            onClick={deleteSelected}
            className="text-xs bg-red-900/40 border border-red-700 text-red-300 rounded-lg px-3 py-1.5 hover:bg-red-800/50"
          >
            🗑 Delete selected
          </button>
        )}

        <button
          onClick={saveLayout}
          disabled={saving}
          className="ml-auto bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-1.5 font-medium"
        >
          {saving ? "Saving…" : "💾 Save Layout"}
        </button>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        className="w-full rounded-xl border border-gray-800 cursor-crosshair"
        style={{ touchAction: "none" }}
      />

      {/* Hint */}
      <p className="text-xs text-gray-500">
        Click and drag to draw a seat box · Click an existing box to select it · Upload a camera frame to use as background
      </p>

      {status && (
        <p className="text-xs text-indigo-300 bg-indigo-900/20 border border-indigo-800 rounded-lg px-3 py-2">
          {status}
        </p>
      )}

      {/* Seat list */}
      {seats.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-xl border border-gray-800 bg-gray-900">
          <table className="w-full text-xs text-gray-300">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                <th className="text-left px-3 py-2">ID</th>
                <th className="text-left px-3 py-2">Row</th>
                <th className="text-left px-3 py-2">№</th>
                <th className="text-left px-3 py-2">Section</th>
                <th className="text-left px-3 py-2">BBox</th>
              </tr>
            </thead>
            <tbody>
              {seats.map((s, i) => (
                <tr
                  key={s.seat_id}
                  onClick={() => setSelectedIdx(i)}
                  className={`border-t border-gray-800 cursor-pointer ${
                    i === selectedIdx ? "bg-amber-900/20" : "hover:bg-gray-800"
                  }`}
                >
                  <td className="px-3 py-1.5 font-mono">{s.seat_id}</td>
                  <td className="px-3 py-1.5">{s.row}</td>
                  <td className="px-3 py-1.5">{s.number}</td>
                  <td className="px-3 py-1.5">{s.section}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-500">
                    [{s.bbox.map((v) => Math.round(v)).join(", ")}]
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
