"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { SeatState } from "@/types";

const COLOURS: Record<string, string> = {
  occupied:           "#ef4444",
  temporarily_vacant: "#f59e0b",
  likely_available:   "#374151",
  available:          "#374151",
  reserved:           "#7c3aed",
  rota_hold:          "#2563eb",
  unknown:            "#1f2937",
};

const LABELS: Record<string, string> = {
  occupied:           "Occupied",
  temporarily_vacant: "Away briefly",
  likely_available:   "Free",
  available:          "Free",
  reserved:           "Reserved",
  rota_hold:          "On stage",
  unknown:            "Unknown",
};

const CANVAS_THRESHOLD = 500;

export interface SeatAction {
  seatId: string;
  action: "reserve" | "unreserve" | "mark_available" | "mark_occupied";
  reservedFor?: string;
}

interface SeatMapProps {
  seats: SeatState[];
  onSeatAction?: (action: SeatAction) => void;
  interactive?: boolean;
  externalOverrides?: Record<string, Partial<SeatState>>;
  onSeatSelect?: (seat: SeatState) => void;
  selectedSeatId?: string;
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend({ hint }: { hint?: string }) {
  return (
    <div style={{ borderTop: "1px solid #1e2235", background: "#0d0f1c" }}>
      <div className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3">
        {(["occupied","temporarily_vacant","available","reserved","rota_hold"] as const).map((s) => (
          <div key={s} className="flex items-center gap-1.5 shrink-0">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: COLOURS[s] }} />
            <span className="text-xs whitespace-nowrap" style={{ color: "#9ca3af" }}>{LABELS[s]}</span>
          </div>
        ))}
      </div>
      {hint && <p className="text-xs px-4 pb-3" style={{ color: "#4b5563" }}>{hint}</p>}
    </div>
  );
}

// ─── Action menu ──────────────────────────────────────────────────────────────

function ActionMenu({ seat, x, y, onAction, onClose }: {
  seat: SeatState; x: number; y: number;
  onAction: (a: SeatAction) => void; onClose: () => void;
}) {
  const [reserving, setReserving] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const isReserved = seat.state === "reserved";

  useEffect(() => {
    if (!ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth  - width  - 8),
      y: y + height > window.innerHeight ? Math.max(8, y - height - 8) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="fixed z-[9999] rounded-xl shadow-2xl text-xs"
      style={{ left: pos.x, top: pos.y, background: "#1a1c2e", border: "1px solid #2d3148", minWidth: 190 }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="px-3 py-2.5 border-b" style={{ borderColor: "#2d3148" }}>
        <span className="font-semibold text-white">Seat {seat.seat_id}</span>
        <span className="ml-2 text-gray-500">Row {seat.row} · #{seat.number}</span>
      </div>
      <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: "1px solid #2d3148" }}>
        <span className="w-2.5 h-2.5 rounded-sm" style={{ background: COLOURS[seat.state] ?? "#374151" }} />
        <span className="text-gray-400">{LABELS[seat.state] ?? seat.state}</span>
      </div>
      {reserving ? (
        <div className="px-3 py-2.5 flex flex-col gap-2">
          <input autoFocus type="text" placeholder="Reserved for (optional)"
            value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-purple-500"
            style={{ background: "#0d0f1a", border: "1px solid #374151" }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAction({ seatId: seat.seat_id, action: "reserve", reservedFor: name || undefined });
              if (e.key === "Escape") { setReserving(false); setName(""); }
            }} />
          <div className="flex gap-2">
            <button onClick={() => onAction({ seatId: seat.seat_id, action: "reserve", reservedFor: name || undefined })}
              className="flex-1 py-1.5 rounded-lg text-white font-medium" style={{ background: "#7c3aed" }}>Confirm</button>
            <button onClick={() => { setReserving(false); setName(""); }}
              className="px-3 py-1.5 rounded-lg text-gray-400 hover:text-white" style={{ background: "#2d3148" }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="py-1.5">
          {!isReserved && (
            <button onClick={() => setReserving(true)} className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-white/5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#7c3aed" }} />
              <span className="text-gray-200">Mark as Reserved</span>
            </button>
          )}
          {isReserved && (
            <button onClick={() => onAction({ seatId: seat.seat_id, action: "unreserve" })}
              className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-white/5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#374151" }} />
              <span className="text-gray-200">Remove Reservation</span>
            </button>
          )}
          {(seat.state === "temporarily_vacant" || seat.state === "likely_available") && (
            <button onClick={() => onAction({ seatId: seat.seat_id, action: "mark_occupied" })}
              className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-white/5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#ef4444" }} />
              <span className="text-gray-200">Person is still here</span>
            </button>
          )}
          {seat.state === "occupied" && (
            <button onClick={() => onAction({ seatId: seat.seat_id, action: "mark_available" })}
              className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-white/5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#374151" }} />
              <span className="text-gray-200">Seat is now free</span>
            </button>
          )}
          <button onClick={onClose} className="w-full px-3 py-2 text-left text-gray-500 hover:text-gray-300 hover:bg-white/5">
            Close
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}

// ─── Canvas renderer (large layouts) ─────────────────────────────────────────

function CanvasSeatMap({ seats, interactive, onSeatAction, externalOverrides, onSeatSelect, selectedSeatId }: SeatMapProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scaleRef     = useRef(1);
  const offsetRef    = useRef({ x: 0, y: 0 });
  const dragRef      = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const didDragRef   = useRef(false);
  const [zoom, setZoom]       = useState(1);
  const [selected, setSelected] = useState<SeatState | null>(null);
  const [menuPos,  setMenuPos]  = useState<{ x: number; y: number } | null>(null);

  const { rows, maxCols } = useMemo(() => {
    const map = new Map<string, SeatState[]>();
    for (const s of seats) {
      if (!map.has(s.row)) map.set(s.row, []);
      map.get(s.row)!.push(s);
    }
    const rows    = Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    const maxCols = Math.max(...rows.map(([, s]) => s.length), 1);
    return { rows, maxCols };
  }, [seats]);

  const SW = 12, SH = 9, GX = 2, GY = 3, PAD = 20, LW = 28;
  const layoutW = PAD * 2 + LW + maxCols * (SW + GX);
  const layoutH = PAD * 2 + rows.length * (SH + GY);

  const fitView = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const s = Math.min(c.clientWidth / layoutW, c.clientHeight / layoutH) * 0.92;
    scaleRef.current  = s;
    offsetRef.current = { x: (c.clientWidth - layoutW * s) / 2, y: (c.clientHeight - layoutH * s) / 2 };
    setZoom(s);
  }, [layoutW, layoutH]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0a0c18";
    ctx.fillRect(0, 0, W, H);
    const sc = scaleRef.current, ox = offsetRef.current.x, oy = offsetRef.current.y;

    // Viewport bounds in layout space — only draw what's visible
    const vpLeft   = -ox / sc;
    const vpTop    = -oy / sc;
    const vpRight  = (W - ox) / sc;
    const vpBottom = (H - oy) / sc;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(sc, sc);

    rows.forEach(([label, rowSeats], ri) => {
      const y = PAD + ri * (SH + GY);
      // Cull entire rows outside viewport
      if (y + SH < vpTop || y > vpBottom) return;

      const sorted = [...rowSeats].sort((a, b) => a.number - b.number);
      const rw     = sorted.length * (SW + GX) - GX;
      const startX = PAD + LW + (maxCols * (SW + GX) - GX - rw) / 2;

      if (sc > 0.5) {
        ctx.fillStyle = "#6b7280";
        ctx.font = `${Math.round(8 / sc)}px Inter,sans-serif`;
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        ctx.fillText(label, PAD + LW - 4, y + SH / 2);
      }

      // Binary-search first visible seat in row
      const firstVisible = Math.max(0, Math.floor((vpLeft - startX) / (SW + GX)));
      const lastVisible  = Math.min(sorted.length - 1, Math.ceil((vpRight - startX) / (SW + GX)));

      for (let ci = firstVisible; ci <= lastVisible; ci++) {
        const seat = sorted[ci];
        if (!seat) continue;
        const x      = startX + ci * (SW + GX);
        const ov     = externalOverrides?.[seat.seat_id];
        const state  = (ov?.state ?? seat.state) as string;
        ctx.globalAlpha = state === "available" ? 0.4 : 0.88;
        ctx.fillStyle   = COLOURS[state] ?? "#1f2937";
        ctx.beginPath(); ctx.roundRect(x, y, SW, SH, 2); ctx.fill();
        ctx.globalAlpha = 1;
        if (selectedSeatId === seat.seat_id) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth   = 1.5 / sc;
          ctx.beginPath(); ctx.roundRect(x, y, SW, SH, 2); ctx.stroke();
        }
        if (sc > 2 && state === "reserved") {
          ctx.fillStyle = "#e9d5ff"; ctx.font = `${SH * 0.75}px sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText("★", x + SW / 2, y + SH / 2);
        }
      }
    });
    ctx.restore();
  }, [seats, externalOverrides, rows, maxCols, SW, SH, GX, GY, PAD, LW, selectedSeatId]);

  useEffect(() => { fitView(); }, [fitView]);
  useEffect(() => { draw(); }, [draw, zoom]);
  useEffect(() => {
    const c = containerRef.current; if (!c) return;
    const ro = new ResizeObserver(() => fitView()); ro.observe(c);
    return () => ro.disconnect();
  }, [fitView]);

  const clamp  = (s: number) => Math.max(0.05, Math.min(12, s));
  const pivot  = () => ({ x: (containerRef.current?.clientWidth ?? 600) / 2, y: (containerRef.current?.clientHeight ?? 380) / 2 });

  const applyZoom = useCallback((factor: number, px: number, py: number) => {
    const old = scaleRef.current, nxt = clamp(old * factor);
    offsetRef.current = { x: px - (px - offsetRef.current.x) * (nxt / old), y: py - (py - offsetRef.current.y) * (nxt / old) };
    scaleRef.current = nxt; setZoom(nxt);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const r = canvasRef.current!.getBoundingClientRect();
    applyZoom(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - r.left, e.clientY - r.top);
  }, [applyZoom]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y };
    didDragRef.current = false;
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.sx, dy = e.clientY - dragRef.current.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true;
    offsetRef.current = { x: dragRef.current.ox + dx, y: dragRef.current.oy + dy };
    draw();
  }, [draw]);

  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);

  const onClick = useCallback((e: React.MouseEvent) => {
    if (!interactive || didDragRef.current) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const cx = (e.clientX - r.left - offsetRef.current.x) / scaleRef.current;
    const cy = (e.clientY - r.top  - offsetRef.current.y) / scaleRef.current;
    for (let ri = 0; ri < rows.length; ri++) {
      const [, rowSeats] = rows[ri];
      const sorted = [...rowSeats].sort((a, b) => a.number - b.number);
      const rw     = sorted.length * (SW + GX) - GX;
      const startX = PAD + LW + (maxCols * (SW + GX) - GX - rw) / 2;
      const y      = PAD + ri * (SH + GY);
      if (cy < y || cy > y + SH) continue;
      for (let ci = 0; ci < sorted.length; ci++) {
        const x = startX + ci * (SW + GX);
        if (cx >= x && cx <= x + SW) {
          const seat = sorted[ci], ov = externalOverrides?.[seat.seat_id];
          const merged = ov ? { ...seat, ...ov } : seat;
          if (onSeatSelect) {
            onSeatSelect(merged);
          } else {
            setSelected(merged);
            setMenuPos({ x: e.clientX + 8, y: e.clientY + 8 });
          }
          return;
        }
      }
    }
    setSelected(null); setMenuPos(null);
  }, [interactive, rows, maxCols, SW, SH, GX, GY, PAD, LW, externalOverrides, onSeatSelect]);

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "#0a0c18", border: "1px solid #1e2235" }}>
      <div className="flex items-center gap-3 px-4 py-2" style={{ borderBottom: "1px solid #1e2235", background: "#0d0f1c" }}>
        <span className="text-xs font-medium" style={{ color: "#6b7280" }}>{seats.length.toLocaleString()} seats</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => { const p = pivot(); applyZoom(1.25, p.x, p.y); }}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold text-gray-300 hover:text-white"
            style={{ background: "#1e2235" }}>+</button>
          <span className="text-xs tabular-nums text-center" style={{ color: "#9ca3af", minWidth: 40 }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => { const p = pivot(); applyZoom(0.8, p.x, p.y); }}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold text-gray-300 hover:text-white"
            style={{ background: "#1e2235" }}>−</button>
          <button onClick={fitView}
            className="px-3 h-7 rounded-lg text-xs font-medium text-gray-300 hover:text-white ml-1"
            style={{ background: "#1e2235" }}>Fit all</button>
        </div>
      </div>
      <div ref={containerRef} style={{ height: 380, position: "relative" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }}
          onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={onMouseUp} onMouseLeave={onMouseUp} onClick={onClick} />
        {zoom < 0.3 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs px-3 py-1.5 rounded-full pointer-events-none"
            style={{ background: "rgba(30,34,53,0.9)", color: "#9ca3af", border: "1px solid #2d3148" }}>
            Scroll to zoom · Drag to pan
          </div>
        )}
      </div>
      <Legend hint={interactive ? "Click a seat to manage" : undefined} />
      {interactive && selected && menuPos && (
        <ActionMenu seat={selected} x={menuPos.x} y={menuPos.y}
          onAction={(a) => { onSeatAction?.(a); setSelected(null); setMenuPos(null); }}
          onClose={() => { setSelected(null); setMenuPos(null); }} />
      )}
    </div>
  );
}

// ─── SVG renderer (small layouts) ────────────────────────────────────────────

function SvgSeatMap({ seats: rawSeats, onSeatAction, interactive = true, externalOverrides, onSeatSelect, selectedSeatId }: SeatMapProps) {
  const [intOverrides, setIntOverrides] = useState<Record<string, Partial<SeatState>>>({});
  const [selected, setSelected] = useState<SeatState | null>(null);
  const [menuPos,  setMenuPos]  = useState<{ x: number; y: number } | null>(null);

  const overrides = externalOverrides ?? intOverrides;
  const seats = rawSeats.map((s) => overrides[s.seat_id] ? { ...s, ...overrides[s.seat_id] } : s);

  const rowMap = new Map<string, SeatState[]>();
  for (const s of seats) {
    if (!rowMap.has(s.row)) rowMap.set(s.row, []);
    rowMap.get(s.row)!.push(s);
  }
  const rows    = Array.from(rowMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const SW = 20, SH = 17, SG = 4, RG = 5, LW = 18, PAD = 12, STH = 28, STG = 16;
  const maxSeats = Math.max(...rows.map(([, s]) => s.length), 1);
  const totalW   = PAD * 2 + LW + maxSeats * (SW + SG);
  const totalH   = PAD + STH + STG + rows.length * (SH + RG) + PAD;

  const handleAction = useCallback((action: SeatAction) => {
    if (!externalOverrides) {
      setIntOverrides((prev) => {
        const next = { ...prev };
        if      (action.action === "reserve")       next[action.seatId] = { state: "reserved"  as const, reserved: true,  reserved_for: action.reservedFor ?? null };
        else if (action.action === "unreserve")     next[action.seatId] = { state: "available" as const, reserved: false, reserved_for: null };
        else if (action.action === "mark_occupied") next[action.seatId] = { state: "occupied"  as const };
        else if (action.action === "mark_available") next[action.seatId] = { state: "available" as const };
        return next;
      });
    }
    onSeatAction?.(action);
    setSelected(null); setMenuPos(null);
  }, [externalOverrides, onSeatAction]);

  return (
    <div className="rounded-xl select-none" style={{ background: "#0a0c18", border: "1px solid #1e2235" }}
      onClick={() => { setSelected(null); setMenuPos(null); }}>
      <svg viewBox={`0 0 ${totalW} ${totalH}`} className="w-full h-auto" style={{ maxHeight: 340 }}>
        <rect x={PAD + LW} y={PAD} width={maxSeats * (SW + SG) - SG} height={STH}
          rx={6} fill="#1a1c2e" stroke="#2d3148" strokeWidth={1} />
        <text x={PAD + LW + (maxSeats * (SW + SG) - SG) / 2} y={PAD + STH / 2 + 4}
          textAnchor="middle" fontSize={10} fill="#4b5563" fontFamily="Inter,sans-serif" letterSpacing="3" fontWeight="600">
          STAGE
        </text>
        {rows.map(([label, rowSeats], ri) => {
          const sorted = [...rowSeats].sort((a, b) => a.number - b.number);
          const rowY   = PAD + STH + STG + ri * (SH + RG);
          const rw     = sorted.length * (SW + SG) - SG;
          const startX = PAD + LW + (maxSeats * (SW + SG) - rw) / 2;
          return (
            <g key={label}>
              <text x={PAD + LW - 8} y={rowY + SH / 2 + 3} textAnchor="end" fontSize={9}
                fill="#4b5563" fontFamily="Inter,sans-serif" fontWeight="600">{label}</text>
              {sorted.map((seat, ci) => {
                const x = startX + ci * (SW + SG);
                return (
                  <g key={seat.seat_id} style={{ cursor: interactive ? "pointer" : "default" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const svg  = (e.currentTarget as SVGElement).closest("svg") as SVGSVGElement;
                      const rect = svg.getBoundingClientRect();
                      const vx   = rect.left + ((x + SW / 2) / totalW) * rect.width;
                      const vy   = rect.top  + ((rowY + SH)  / totalH) * rect.height;
                      if (onSeatSelect) {
                        onSeatSelect(seat);
                        return;
                      }
                      if (selected?.seat_id === seat.seat_id) { setSelected(null); setMenuPos(null); return; }
                      setSelected(seat);
                      setMenuPos({ x: Math.min(vx, window.innerWidth - 210), y: vy + 4 });
                    }}>
                    <rect x={x} y={rowY} width={SW} height={SH} rx={4}
                      fill={COLOURS[seat.state] ?? "#1f2937"}
                      fillOpacity={seat.state === "available" ? 0.55 : 0.85}
                      stroke={selected?.seat_id === seat.seat_id ? "#fff" : "transparent"} strokeWidth={1.5} />
                    {seat.state === "reserved" && (
                      <text x={x + SW / 2} y={rowY + SH / 2 + 3.5} textAnchor="middle"
                        fontSize={8} fill="#e9d5ff" fontFamily="Inter,sans-serif">★</text>
                    )}
                    {seat.state === "rota_hold" && (
                      <text x={x + SW / 2} y={rowY + SH / 2 + 3.5} textAnchor="middle"
                        fontSize={7} fill="#bfdbfe" fontFamily="Inter,sans-serif">↑</text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <Legend hint={interactive ? "Click a seat to manage" : undefined} />
      {interactive && selected && menuPos && (
        <ActionMenu seat={selected} x={menuPos.x} y={menuPos.y}
          onAction={handleAction} onClose={() => { setSelected(null); setMenuPos(null); }} />
      )}
    </div>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function SeatMap(props: SeatMapProps) {
  return props.seats.length > CANVAS_THRESHOLD
    ? <CanvasSeatMap {...props} />
    : <SvgSeatMap {...props} />;
}
