"use client";

/**
 * SeatAlertContext
 *
 * Holds "this seat just became available" alerts across all cameras, so
 * any page can see them — not just the one that opened the stream.
 * Mirrors ReviewContext's pattern (custom-event bridge from
 * usePipelineStream, since the websocket hook is mounted per-page but
 * alerts need to be visible everywhere).
 */

import { createContext, useContext, useState, useCallback, ReactNode, useEffect } from "react";

export interface SeatAlert {
  camera_id: string;
  seat_id: string;
  timestamp: number;
  /** Client-generated, used as React key / dismiss target — a seat can
   *  become available more than once in a session, each is its own alert. */
  alert_id: string;
}

interface SeatAlertContextValue {
  alerts: SeatAlert[];
  dismissAlert: (alertId: string) => void;
  dismissAll: () => void;
}

const SeatAlertContext = createContext<SeatAlertContextValue | null>(null);

export function SeatAlertProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<SeatAlert[]>([]);

  useEffect(() => {
    function onAlert(e: Event) {
      const detail = (e as CustomEvent).detail as { camera_id: string; seat_id: string; timestamp: number };
      if (!detail?.seat_id) return;
      const alert_id = `${detail.camera_id}:${detail.seat_id}:${detail.timestamp}`;
      setAlerts((prev) => {
        if (prev.find((a) => a.alert_id === alert_id)) return prev;
        // Cap at 10 visible alerts — this is a live "go seat someone"
        // prompt, not a log; old ones that were never acted on should
        // fall off rather than accumulate forever.
        return [...prev, { ...detail, alert_id }].slice(-10);
      });
    }
    window.addEventListener("kyro_seat_alert", onAlert);
    return () => window.removeEventListener("kyro_seat_alert", onAlert);
  }, []);

  const dismissAlert = useCallback((alertId: string) => {
    setAlerts((prev) => prev.filter((a) => a.alert_id !== alertId));
  }, []);

  const dismissAll = useCallback(() => setAlerts([]), []);

  return (
    <SeatAlertContext.Provider value={{ alerts, dismissAlert, dismissAll }}>
      {children}
    </SeatAlertContext.Provider>
  );
}

export function useSeatAlertContext() {
  const ctx = useContext(SeatAlertContext);
  if (!ctx) throw new Error("useSeatAlertContext must be inside SeatAlertProvider");
  return ctx;
}
