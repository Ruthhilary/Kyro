"use client";

/**
 * Seat Layout Editor
 *
 * Two modes:
 *
 * 1. GRID (default) — Draw a rectangle over a seating block, enter
 *    rows × seats per row, and Kyro generates all boxes automatically.
 *    Handles 10,000+ seats with no manual drawing.
 *
 * 2. MANUAL — Draw individual boxes over each seat.
 *    Useful for irregular layouts or accessibility spots.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Trash2, Grid, PenLine, MapPin, RefreshCw } from "lucide-react";
import type { SeatDefinition } from "@/types";
import { seatsApi, zonesApi, camerasApi, type ZoneDef, type ZoneType } from "@/lib/api";

// Presets shown in the "Mark zones" panel. Picking one sets BOTH the
// display label and the zone_type that actually controls behavior — so
// "Toilet / break area" is guaranteed to behave as an ignore-zone, not
// just be a stage/altar zone with a different name on it.
const ZONE_PRESETS: Record<string, { display: string; label: string; zone_type: ZoneType; hint: string }> = {
  stage:  { display: "Stage",              label: "Stage",  zone_type: "hold_seats", hint: "Overlapping seats stay held while anyone is here." },
  altar:  { display: "Altar",              label: "Altar",  zone_type: "hold_seats", hint: "Overlapping seats stay held while anyone is here." },
  choir:  { display: "Choir",              label: "Choir",  zone_type: "hold_seats", hint: "Overlapping seats stay held while anyone is here." },
  exit:   { display: "Entrance / Exit",    label: "Entrance / Exit", zone_type: "ignore", hint: "Never holds a seat — purely informational." },
  toilet: { display: "Toilet / break area", label: "Toilet / break area", zone_type: "ignore", hint: "Never holds a seat — purely informational." },
  custom: { display: "Custom…",            label: "Zone",   zone_type: "hold_seats", hint: "Choose the behavior below." },
};

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

// ── Grid generator ────────────────────────────────────────────────────────────

interface GridBlock {
  x1: number; y1: number; x2: number; y2: number;
  rows: number; seatsPerRow: number; section: string;
}

function generateGridSeats(blocks: GridBlock[], startIndex: number): SeatDefinition[] {
  const seats: SeatDefinition[] = [];
  let idx = startIndex;
  blocks.forEach((block) => {
    const bw = block.x2 - block.x1;
    const bh = block.y2 - block.y1;
    const cellW = bw / block.seatsPerRow;
    const cellH = bh / block.rows;
    for (let r = 0; r < block.rows; r++) {
      const rowLetter = String.fromCharCode(65 + (idx % 26) + r);
      for (let s = 0; s < block.seatsPerRow; s++) {
        const x1 = block.x1 + s * cellW;
        const y1 = block.y1 + r * cellH;
        seats.push({
          seat_id: `${rowLetter}-${s + 1}`,
          row: rowLetter,
          number: s + 1,
          section: block.section,
          bbox: [x1, y1, x1 + cellW * 0.92, y1 + cellH * 0.88],
        });
      }
    }
    idx += block.rows;
  });
  return seats;
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
  // Mode: grid (auto-generate), manual (draw each seat), or zone (mark stage/exclusion areas)
  const [mode, setMode] = useState<"grid" | "manual" | "zone">("grid");
  // Grid mode: blocks + current draft block being drawn
  const [gridBlocks, setGridBlocks] = useState<GridBlock[]>([]);
  const [gridDraft, setGridDraft] = useState<DraftBox | null>(null);
  const [gridDrawing, setGridDrawing] = useState(false);
  const [gridRows, setGridRows] = useState("20");
  const [gridSeatsPerRow, setGridSeatsPerRow] = useState("30");
  const [gridSection, setGridSection] = useState("Main Floor");

  // Zones (stage/altar/entrance/exclusion areas) — separate from seats,
  // always visible on the canvas regardless of mode, saved directly to
  // the backend (hot-applied to the running pipeline immediately).
  const [zones, setZones] = useState<ZoneDef[]>([]);
  const [zoneDraft, setZoneDraft] = useState<DraftBox | null>(null);
  const [zoneDrawing, setZoneDrawing] = useState(false);
  // What the zone is FOR (a preset) drives both its label and its actual
  // behavior (zone_type) — typing "Toilet" into a free-text box never did
  // that on its own, so the editor no longer offers a free-text-only field
  // for the presets that matter.
  const [zonePreset, setZonePreset] = useState<keyof typeof ZONE_PRESETS>("stage");
  const [zoneLabel, setZoneLabel] = useState(ZONE_PRESETS.stage.label);
  const [zoneType, setZoneType] = useState<ZoneType>(ZONE_PRESETS.stage.zone_type);
  const [savingZone, setSavingZone] = useState(false);

  // Background: auto-loaded from the live camera the moment this opens,
  // so the venue is already there instead of requiring a manual
  // screenshot upload every time.
  const [loadingBg, setLoadingBg] = useState(true);
  const [bgError, setBgError] = useState(false);

  const loadBackgroundFromCamera = useCallback(async () => {
    setLoadingBg(true);
    setBgError(false);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("kyro_token") ?? "" : "";
      const res = await fetch(camerasApi.snapshotUrl(cameraId), {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      if (!res.ok || res.status === 204) { setBgError(true); return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => setBgImage(img);
      img.onerror = () => setBgError(true);
      img.src = url;
    } catch {
      setBgError(true);
    } finally {
      setLoadingBg(false);
    }
  }, [cameraId]);

  useEffect(() => { loadBackgroundFromCamera(); }, [loadBackgroundFromCamera]);

  useEffect(() => {
    zonesApi.list(cameraId).then(setZones).catch(() => setZones([]));
  }, [cameraId]);

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
      ctx.fillText(
        loadingBg ? "Loading venue snapshot from camera…"
          : bgError ? "No camera snapshot available — upload one, or check the camera is running"
          : "Upload a camera screenshot to begin",
        canvas.width / 2, canvas.height / 2,
      );
    }

    // Zones (stage/altar/exclusion) — always visible regardless of mode,
    // so you can see "this is the stage" while placing seats around it.
    zones.forEach((zone) => {
      const [x1, y1, x2, y2] = zone.bbox;
      ctx.strokeStyle = "#a855f7";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(168,85,247,0.12)";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = "#e9d5ff";
      ctx.font = "bold 12px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(zone.label, (x1 + x2) / 2, y1 + 16);
    });
    if (mode === "zone" && zoneDraft) {
      ctx.strokeStyle = "#a855f7";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      const { start, end } = zoneDraft;
      ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      ctx.setLineDash([]);
    }

    // In grid mode: draw grid block outlines + preview
    if (mode === "grid") {
      gridBlocks.forEach((block, bi) => {
        const generatedCount = block.rows * block.seatsPerRow;
        ctx.strokeStyle = "#6366f1";
        ctx.lineWidth = 2;
        ctx.strokeRect(block.x1, block.y1, block.x2 - block.x1, block.y2 - block.y1);
        ctx.fillStyle = "rgba(99,102,241,0.15)";
        ctx.fillRect(block.x1, block.y1, block.x2 - block.x1, block.y2 - block.y1);
        // Label
        ctx.fillStyle = "#a5b4fc";
        ctx.font = "bold 12px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          `${block.section} · ${block.rows}×${block.seatsPerRow} = ${generatedCount} seats`,
          (block.x1 + block.x2) / 2,
          (block.y1 + block.y2) / 2,
        );
      });
      if (gridDraft) {
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        const { start, end } = gridDraft;
        ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
        ctx.setLineDash([]);
      }
      return; // don't draw individual seats in grid mode preview
    }

    // Manual mode: draw individual seats
    seats.forEach((seat, i) => {
      const [x1, y1, x2, y2] = seat.bbox;
      const isSelected = i === selectedIdx;
      ctx.strokeStyle = isSelected ? "#f59e0b" : "#22c55e";
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = isSelected ? "rgba(245,158,11,0.15)" : "rgba(34,197,94,0.12)";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = "#fff";
      ctx.font = "9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(seat.seat_id, (x1 + x2) / 2, (y1 + y2) / 2 + 3);
    });

    if (draft) {
      const { start, end } = draft;
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      ctx.setLineDash([]);
    }
  }, [bgImage, seats, draft, selectedIdx, mode, gridBlocks, gridDraft, zones, zoneDraft, loadingBg, bgError]);

  useEffect(() => { render(); }, [render]);

  // ── mouse events ───────────────────────────────────────────────────────

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const pt = ptToCanvas(e.clientX, e.clientY, canvas);
    if (mode === "grid") {
      setGridDrawing(true);
      setGridDraft({ start: pt, end: pt });
    } else if (mode === "zone") {
      setZoneDrawing(true);
      setZoneDraft({ start: pt, end: pt });
    } else {
      setDrawing(true);
      setDraft({ start: pt, end: pt });
      setSelectedIdx(null);
    }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const pt = ptToCanvas(e.clientX, e.clientY, canvas);
    if (mode === "grid" && gridDrawing && gridDraft) {
      setGridDraft({ start: gridDraft.start, end: pt });
    } else if (mode === "zone" && zoneDrawing && zoneDraft) {
      setZoneDraft({ start: zoneDraft.start, end: pt });
    } else if (mode === "manual" && drawing && draft) {
      setDraft({ start: draft.start, end: pt });
    }
  }

  async function onMouseUp() {
    if (mode === "zone" && zoneDrawing && zoneDraft) {
      setZoneDrawing(false);
      const w = Math.abs(zoneDraft.end.x - zoneDraft.start.x);
      const h = Math.abs(zoneDraft.end.y - zoneDraft.start.y);
      if (w > 15 && h > 15) {
        const bbox = [
          Math.min(zoneDraft.start.x, zoneDraft.end.x),
          Math.min(zoneDraft.start.y, zoneDraft.end.y),
          Math.max(zoneDraft.start.x, zoneDraft.end.x),
          Math.max(zoneDraft.start.y, zoneDraft.end.y),
        ];
        setSavingZone(true);
        try {
          const created = await zonesApi.create(cameraId, { label: zoneLabel || "Zone", zone_type: zoneType, bbox });
          setZones((prev) => [...prev, created]);
          const behavior = created.zone_type === "ignore" ? "won't hold seats" : "will hold seats";
          setStatus(`"${created.label}" zone saved (${behavior}) — applied to the live pipeline immediately`);
        } catch (e: any) {
          setStatus(`Zone save failed: ${e.message}`);
        } finally {
          setSavingZone(false);
        }
      }
      setZoneDraft(null);
      return;
    }
    if (mode === "grid" && gridDrawing && gridDraft) {
      setGridDrawing(false);
      const w = Math.abs(gridDraft.end.x - gridDraft.start.x);
      const h = Math.abs(gridDraft.end.y - gridDraft.start.y);
      if (w > 20 && h > 20) {
        const block: GridBlock = {
          x1: Math.min(gridDraft.start.x, gridDraft.end.x),
          y1: Math.min(gridDraft.start.y, gridDraft.end.y),
          x2: Math.max(gridDraft.start.x, gridDraft.end.x),
          y2: Math.max(gridDraft.start.y, gridDraft.end.y),
          rows: parseInt(gridRows, 10) || 10,
          seatsPerRow: parseInt(gridSeatsPerRow, 10) || 20,
          section: gridSection,
        };
        setGridBlocks((prev) => [...prev, block]);
      }
      setGridDraft(null);
      return;
    }
    if (!drawing || !draft) return;
    setDrawing(false);
    const w = Math.abs(draft.end.x - draft.start.x);
    const h = Math.abs(draft.end.y - draft.start.y);
    if (w < 8 || h < 8) {
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

  async function deleteZone(zoneId: string) {
    try {
      await zonesApi.delete(cameraId, zoneId);
      setZones((prev) => prev.filter((z) => z.zone_id !== zoneId));
    } catch (e: any) {
      setStatus(`Zone delete failed: ${e.message}`);
    }
  }

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
    // In grid mode: generate seats from blocks first
    const finalSeats = mode === "grid"
      ? generateGridSeats(gridBlocks, 0)
      : seats;
    if (finalSeats.length === 0) { setStatus("Add at least one seating block or seat first"); return; }
    setSaving(true);
    setStatus(null);
    try {
      const layout = await seatsApi.createLayout(cameraId, { name: layoutName, seats: finalSeats });
      setStatus(`Saved "${layout.name}" — ${layout.seat_count} seats (ID: ${layout.id})`);
      onSaved?.(layout.id);
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const gridSeatCount = gridBlocks.reduce((s, b) => s + b.rows * b.seatsPerRow, 0);

  return (
    <div className="flex flex-col gap-4">

      {/* Mode toggle */}
      <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1 w-fit">
        <button onClick={() => setMode("grid")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            mode === "grid" ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-white"
          }`}>
          <Grid size={13} /> Grid (auto-generate)
        </button>
        <button onClick={() => setMode("manual")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            mode === "manual" ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-white"
          }`}>
          <PenLine size={13} /> Manual draw
        </button>
        <button onClick={() => setMode("zone")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            mode === "zone" ? "bg-purple-600 text-white" : "text-gray-400 hover:text-white"
          }`}>
          <MapPin size={13} /> Mark zones (stage, etc.)
        </button>
      </div>

      {/* Zone mode controls */}
      {mode === "zone" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
          <p className="text-xs text-gray-400 leading-relaxed">
            Pick what this zone is for, then draw a rectangle over it. The choice below — not the
            name — decides what Kyro actually does: <strong className="text-purple-300">Stage / Altar /
            Choir</strong> zones hold overlapping seats while someone's in them; <strong className="text-purple-300">
            Entrance/Exit / Toilet</strong> zones are purely informational and never hold a seat.
            Saved zones apply to the live pipeline immediately.
          </p>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Zone is for…</label>
              <select
                value={zonePreset}
                onChange={(e) => {
                  const key = e.target.value;
                  setZonePreset(key);
                  const preset = ZONE_PRESETS[key];
                  setZoneLabel(preset.label);
                  setZoneType(preset.zone_type);
                }}
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500 w-44"
              >
                {Object.entries(ZONE_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>{preset.display}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Zone label (shown on map)</label>
              <input value={zoneLabel} onChange={(e) => setZoneLabel(e.target.value)}
                placeholder="Stage"
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500 w-44" />
            </div>
            {zonePreset === "custom" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Behavior</label>
                <select
                  value={zoneType}
                  onChange={(e) => setZoneType(e.target.value as ZoneType)}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500 w-40"
                >
                  <option value="hold_seats">Hold seats while active</option>
                  <option value="ignore">Ignore (never holds seats)</option>
                </select>
              </div>
            )}
            {savingZone && <span className="text-xs text-purple-300">Saving…</span>}
          </div>
          <p className="text-xs text-gray-500">{ZONE_PRESETS[zonePreset]?.hint}</p>
          {zones.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-gray-400">Zones on this camera:</p>
              {zones.map((z) => (
                <div key={z.zone_id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2 text-xs">
                  <span className="text-purple-300">
                    {z.label}
                    <span className={`ml-2 text-[10px] uppercase tracking-wide ${z.zone_type === "ignore" ? "text-gray-500" : "text-amber-400"}`}>
                      {z.zone_type === "ignore" ? "ignore" : "holds seats"}
                    </span>
                  </span>
                  <button onClick={() => deleteZone(z.zone_id)}
                    className="text-red-400 hover:text-red-300 ml-2"><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Grid mode controls */}
      {mode === "grid" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
          <p className="text-xs text-gray-400 leading-relaxed">
            Draw a rectangle over your seating area on the canvas below, then click <strong className="text-white">Add block</strong>.
            Kyro will automatically divide it into a grid of seats. Add multiple blocks for different sections.
          </p>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Section name</label>
              <input value={gridSection} onChange={(e) => setGridSection(e.target.value)}
                placeholder="Main Floor"
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-36" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Rows</label>
              <input value={gridRows} onChange={(e) => setGridRows(e.target.value)}
                type="number" min="1" max="200"
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-20" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Seats per row</label>
              <input value={gridSeatsPerRow} onChange={(e) => setGridSeatsPerRow(e.target.value)}
                type="number" min="1" max="500"
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-24" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">= seats</label>
              <div className="text-lg font-bold text-indigo-300 px-1">
                {(parseInt(gridRows, 10) || 0) * (parseInt(gridSeatsPerRow, 10) || 0)}
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-600">
            Draw a rectangle on the canvas, then the block is added automatically with these settings.
          </p>
          {gridBlocks.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-gray-400">Blocks added ({gridSeatCount} seats total):</p>
              {gridBlocks.map((b, i) => (
                <div key={i} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2 text-xs">
                  <span className="text-white">{b.section}</span>
                  <span className="text-gray-400">{b.rows} rows × {b.seatsPerRow} seats = <strong className="text-indigo-300">{b.rows * b.seatsPerRow}</strong></span>
                  <button onClick={() => setGridBlocks((prev) => prev.filter((_, j) => j !== i))}
                    className="text-red-400 hover:text-red-300 ml-2"><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual mode controls */}
      {mode === "manual" && (
        <div className="flex flex-wrap items-center gap-3">
          <input value={section} onChange={(e) => setSection(e.target.value)}
            placeholder="Section name"
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 w-36 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <span className="text-xs text-gray-500">{seats.length} seat{seats.length !== 1 ? "s" : ""}</span>
          {selectedIdx !== null && (
            <button onClick={deleteSelected}
              className="text-xs bg-red-900/40 border border-red-700 text-red-300 rounded-lg px-3 py-1.5 hover:bg-red-800/50 flex items-center gap-1.5">
              <Trash2 size={12} /> Delete selected
            </button>
          )}
        </div>
      )}

      {/* Shared toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={loadBackgroundFromCamera} disabled={loadingBg}
          className="text-xs text-gray-400 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-gray-700 flex items-center gap-1.5 disabled:opacity-50">
          <RefreshCw size={13} className={loadingBg ? "animate-spin" : ""} /> Refresh from camera
        </button>
        <label className="text-xs text-gray-400 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-gray-700 flex items-center gap-1.5">
          <Upload size={13} /> Upload camera frame
          <input type="file" accept="image/*" className="hidden" onChange={onImageUpload} />
        </label>
        <input value={layoutName} onChange={(e) => setLayoutName(e.target.value)}
          placeholder="Layout name"
          className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 w-40 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <button onClick={saveLayout} disabled={saving}
          className="ml-auto bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-1.5 font-medium">
          {saving ? "Saving…" : `Save layout${mode === "grid" && gridSeatCount > 0 ? ` (${gridSeatCount} seats)` : ""}`}
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
        style={{ touchAction: "none", maxHeight: "55vh", objectFit: "contain" }}
      />

      <p className="text-xs text-gray-500">
        {mode === "grid"
          ? "Draw a rectangle over your seating area → Kyro fills in all the seat boxes automatically"
          : mode === "zone"
          ? "Draw a rectangle over the stage/altar/entrance area — saved automatically as you draw"
          : "Click and drag to draw a seat box · Click an existing box to select it"}
      </p>

      {status && (
        <p className="text-xs text-indigo-300 bg-indigo-900/20 border border-indigo-800 rounded-lg px-3 py-2">
          {status}
        </p>
      )}

      {/* Seat list (manual only) */}
      {mode === "manual" && seats.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-xl border border-gray-800 bg-gray-900">
          <table className="w-full text-xs text-gray-300">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                <th className="text-left px-3 py-2">ID</th>
                <th className="text-left px-3 py-2">Row</th>
                <th className="text-left px-3 py-2">№</th>
                <th className="text-left px-3 py-2">Section</th>
              </tr>
            </thead>
            <tbody>
              {seats.map((s, i) => (
                <tr key={s.seat_id} onClick={() => setSelectedIdx(i)}
                  className={`border-t border-gray-800 cursor-pointer ${i === selectedIdx ? "bg-amber-900/20" : "hover:bg-gray-800"}`}>
                  <td className="px-3 py-1.5 font-mono">{s.seat_id}</td>
                  <td className="px-3 py-1.5">{s.row}</td>
                  <td className="px-3 py-1.5">{s.number}</td>
                  <td className="px-3 py-1.5">{s.section}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
