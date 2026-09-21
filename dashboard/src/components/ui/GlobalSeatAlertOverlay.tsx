"use client";

import { useState } from "react";
import { MapPin, X } from "lucide-react";
import { useSeatAlertContext, type SeatAlert } from "@/lib/SeatAlertContext";
import { ZoomableImage } from "@/components/ui/ZoomableImage";
import { seatsApi } from "@/lib/api";
import { inDemoMode } from "@/lib/liveMode";

/**
 * Mounted once in the root layout, alongside GlobalReviewOverlay.
 * Shows a stack of compact "Seat X available" cards with a thumbnail —
 * click one to open the full evidence photo with zoom/pan.
 */
export function GlobalSeatAlertOverlay() {
  const { alerts, dismissAlert } = useSeatAlertContext();
  const [expanded, setExpanded] = useState<SeatAlert | null>(null);

  if (inDemoMode()) return null; // no real seat-alert data in demo mode
  if (alerts.length === 0) return null;

  return (
    <>
      <div className="fixed bottom-4 left-4 z-40 flex flex-col gap-2 max-w-xs">
        {alerts.map((alert) => (
          <div
            key={alert.alert_id}
            className="rounded-xl overflow-hidden cursor-pointer shadow-lg"
            style={{ background: "#0d0f1a", border: "1px solid #2d3148" }}
            onClick={() => setExpanded(alert)}
          >
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={seatsApi.availableSnapshotUrl(alert.camera_id, alert.seat_id)}
                alt={`Seat ${alert.seat_id} available`}
                className="w-full object-cover"
                style={{ height: 90 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <button
                onClick={(e) => { e.stopPropagation(); dismissAlert(alert.alert_id); }}
                className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: "rgba(13,15,26,0.85)", color: "#9ca3af" }}
              >
                <X size={11} />
              </button>
            </div>
            <div className="px-3 py-2 flex items-center gap-2">
              <MapPin size={13} style={{ color: "#4ade80" }} />
              <span className="text-sm text-white font-medium">Seat {alert.seat_id} available</span>
            </div>
          </div>
        ))}
      </div>

      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: "rgba(0,0,0,0.75)" }}
          onClick={() => setExpanded(null)}
        >
          <div
            className="w-full max-w-lg rounded-xl overflow-hidden"
            style={{ background: "#0d0f1a", border: "1px solid #2d3148" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #2d3148" }}>
              <span className="text-sm font-semibold text-white">Seat {expanded.seat_id} — available</span>
              <button onClick={() => setExpanded(null)} className="text-gray-400 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="p-3">
              <ZoomableImage
                src={seatsApi.availableSnapshotUrl(expanded.camera_id, expanded.seat_id)}
                alt={`Seat ${expanded.seat_id} available`}
                maxHeight={420}
                badge={<><MapPin size={9} /> Seat {expanded.seat_id}</>}
              />
              <p className="text-xs mt-2" style={{ color: "#6b7280" }}>
                Scroll or pinch to zoom, drag to pan. Photo captured the moment this seat became available.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
