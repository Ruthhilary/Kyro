"use client";

import { useRef, useState, type ReactNode, type WheelEvent, type PointerEvent } from "react";

/**
 * ZoomableImage
 *
 * Scroll-to-zoom, drag-to-pan image viewer with +/- controls. Used for any
 * evidence photo the person needs to inspect closely — flagged review
 * areas, seat-available alerts, etc. Purely a viewer: takes a `src` and
 * renders it; fetching/refreshing that src is the caller's job.
 */
export function ZoomableImage({
  src,
  alt,
  maxHeight = 160,
  badge,
}: {
  src: string;
  alt: string;
  maxHeight?: number;
  /** Optional small label shown top-left, e.g. "Live" or a timestamp. */
  badge?: ReactNode;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clampZoom = (z: number) => Math.min(4, Math.max(1, z));

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      const next = clampZoom(z - e.deltaY * 0.0025);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const onPointerDown = (e: PointerEvent) => {
    if (zoom <= 1) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setPan({ x: dragState.current.panX + dx, y: dragState.current.panY + dy });
  };
  const onPointerUp = () => { dragState.current = null; setDragging(false); };

  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  return (
    <div
      className="relative w-full rounded-lg overflow-hidden select-none"
      style={{ border: "1px solid #2d3148", cursor: zoom > 1 ? "grab" : "default", touchAction: "none" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="w-full h-auto"
        style={{
          maxHeight,
          objectFit: "cover",
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "center center",
          transition: dragging ? "none" : "transform 0.08s ease-out",
        }}
        draggable={false}
      />
      {badge && (
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs"
          style={{ background: "rgba(13,15,26,0.85)", color: "#a5b4fc" }}>
          {badge}
        </div>
      )}
      {/* Zoom controls */}
      <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
        {zoom > 1 && (
          <button
            onClick={resetZoom}
            className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: "rgba(13,15,26,0.85)", color: "#a5b4fc" }}
            title="Reset zoom"
          >⟲</button>
        )}
        <button
          onClick={() => setZoom((z) => clampZoom(z - 0.5))}
          className="w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold"
          style={{ background: "rgba(13,15,26,0.85)", color: "#a5b4fc" }}
          title="Zoom out"
        >−</button>
        <button
          onClick={() => setZoom((z) => clampZoom(z + 0.5))}
          className="w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold"
          style={{ background: "rgba(13,15,26,0.85)", color: "#a5b4fc" }}
          title="Zoom in"
        >+</button>
      </div>
    </div>
  );
}
