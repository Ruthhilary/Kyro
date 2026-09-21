"use client";

/**
 * usePipelineStream
 *
 * Subscribes to the Kyro backend WebSocket for a given camera_id.
 * Returns live PipelineUpdate data, connection status, and error state.
 *
 * Reconnects automatically on disconnect.
 * Throttles React state updates to ~4 fps so the UI stays smooth —
 * the animated number hook fills the gap between frames.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineUpdate, ReviewRequest } from "@/types";
import { DEMO_MODE, DemoFeed, DEMO_REVIEWS, getNextDemoReviews, registerDemoFeed, resetDemoFeed } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

// Try to get the global review context — safe to call even if provider isn't mounted
function tryAddToGlobalReview(r: ReviewRequest) {
  try {
    // Dispatch a custom event that the ReviewContext listens for
    window.dispatchEvent(new CustomEvent("kyro_new_review", { detail: r }));
  } catch {}
}

// Same pattern for seat-available alerts — dispatched to SeatAlertContext.
function tryAddToGlobalSeatAlert(alert: { camera_id: string; seat_id: string; timestamp: number }) {
  try {
    window.dispatchEvent(new CustomEvent("kyro_seat_alert", { detail: alert }));
  } catch {}
}

// Derive WS URL at runtime from the current page origin when not explicitly set.
// This means it works on any domain — ngrok, Railway, custom domain — without a rebuild.
function getWsBase(): string {
  const envUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (envUrl) return envUrl;
  if (typeof window === "undefined") return "ws://localhost:8000";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

const RECONNECT_DELAY_MS = 3_000;
const THROTTLE_MS = 250;

interface UsePipelineStreamResult {
  data: PipelineUpdate | null;
  connected: boolean;
  error: string | null;
  reviews: ReviewRequest[];         // only populated for admin role
  dismissReview: (reviewId: string) => void;
}

export function usePipelineStream(
  cameraId: string,
  role: "admin" | "operator" | "viewer" = "viewer",
): UsePipelineStreamResult {
  const [data, setData]           = useState<PipelineUpdate | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [reviews, setReviews]     = useState<ReviewRequest[]>([]);

  const wsRef            = useRef<WebSocket | null>(null);
  const retryRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef       = useRef(true);
  const lastUpdateRef    = useRef<number>(0);
  const cameraIdRef      = useRef(cameraId);
  // Full seat state cache — updated by snapshots and patched by deltas
  const seatCacheRef     = useRef<Map<string, import("@/types").SeatState>>(new Map());
  cameraIdRef.current    = cameraId;

  const dismissReview = useCallback((reviewId: string) => {
    setReviews((prev) => prev.filter((r) => r.review_id !== reviewId));
    // Remove from shared store so sidebar badge updates
    try {
      const stored: string[] = JSON.parse(localStorage.getItem("kyro_pending_reviews") ?? "[]");
      const updated = stored.filter((id) => id !== reviewId);
      localStorage.setItem("kyro_pending_reviews", JSON.stringify(updated));
      window.dispatchEvent(new Event("kyro_reviews_changed"));
    } catch {}
  }, []);

  // ── Demo mode — simulated feed, no WebSocket needed ──────────────────
  useEffect(() => {
    if (!inDemoMode() || isLiveMode()) return; // skip if live mode is active

    const INITIAL: Record<string, number> = {
      "demo-main":     72,   // ~80% of 91
      "demo-balcony":  45,   // ~75% of 60
      "demo-overflow": 38,   // ~76% of 50
      "demo-stadium":  7500,
      "demo-outside":  83,   // people waiting outside
    };

    // For custom-added cameras, derive initial count from stored layout size
    let initialCount = INITIAL[cameraId];
    if (initialCount === undefined) {
      try {
        const storedLayouts = JSON.parse(localStorage.getItem("kyro_demo_layouts") ?? "{}");
        const layout = storedLayouts[cameraId];
        if (layout?.seat_count > 0) {
          // Start at ~75% occupied
          initialCount = Math.round(layout.seat_count * 0.75);
        }
      } catch {}
      initialCount = initialCount ?? 100;
    }

    const feed = new DemoFeed(cameraId, initialCount);
    registerDemoFeed(cameraId, feed);
    setConnected(true);
    setData(feed.tick() as PipelineUpdate);

    const frameId = setInterval(() => {
      setData(feed.tick() as PipelineUpdate);
    }, 1200);

    // Handle reset — reset the feed itself so counts and seat states clear
    function onReset(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.cameraId === cameraId) {
        feed.reset();
        setData(feed.tick() as PipelineUpdate);
      }
    }
    window.addEventListener("kyro_demo_reset", onReset);

    // Fire initial review questions after 8s, then new ones every 5 minutes
    let reviewTimer: ReturnType<typeof setTimeout> | null = null;
    let reviewInterval: ReturnType<typeof setInterval> | null = null;

    if (cameraId === "demo-main" && (role === "admin" || role === "operator")) {
      reviewTimer = setTimeout(() => {
        const batch = getNextDemoReviews(role as "admin" | "operator");
        setReviews(batch as ReviewRequest[]);
        // Push to global context so they show on any page
        batch.forEach((r) => tryAddToGlobalReview(r as ReviewRequest));
        try {
          const ids = batch.map((r) => r.review_id);
          localStorage.setItem("kyro_pending_reviews", JSON.stringify(ids));
          window.dispatchEvent(new Event("kyro_reviews_changed"));
        } catch {}

        reviewInterval = setInterval(() => {
          const next = getNextDemoReviews(role as "admin" | "operator");
          setReviews((prev) => {
            const fresh = [...prev, ...next.map((r) => r as ReviewRequest)];
            const capped = fresh.slice(-5);
            try {
              localStorage.setItem("kyro_pending_reviews", JSON.stringify(capped.map((r) => r.review_id)));
              window.dispatchEvent(new Event("kyro_reviews_changed"));
            } catch {}
            return capped;
          });
          next.forEach((r) => tryAddToGlobalReview(r as ReviewRequest));
        }, 5 * 60 * 1000);
      }, 8_000);
    }

    return () => {
      clearInterval(frameId);
      window.removeEventListener("kyro_demo_reset", onReset);
      if (reviewTimer) clearTimeout(reviewTimer);
      if (reviewInterval) clearInterval(reviewInterval);
    };
  }, [cameraId, role]);

  useEffect(() => {
    if (inDemoMode() && !isLiveMode()) return; // skip WebSocket in demo mode
    mountedRef.current = true;

    function connect() {
      if (!mountedRef.current) return;

      if (wsRef.current) {
        wsRef.current.onopen    = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose   = null;
        wsRef.current.onerror   = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      const token =
        typeof window !== "undefined"
          ? (localStorage.getItem("kyro_token") ?? "")
          : "";

      const url = `${getWsBase()}/ws/${cameraIdRef.current}?token=${encodeURIComponent(token)}`;
      const ws  = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data as string);

          // Route by message type
          if (msg.type === "review_request") {
            const req = msg as ReviewRequest;
            const isAdminType  = req.review_type === "stage_question" || req.review_type === "zone_proposal";
            const isPeopleType = req.review_type === "absence_question" || req.review_type === "front_rush_question" || req.review_type === "altar_call_question";
            const show = (isAdminType && role === "admin") || (isPeopleType && (role === "operator" || role === "admin"));
            if (show) {
              setReviews((prev) => {
                if (prev.find((r) => r.review_id === req.review_id)) return prev;
                const next = [...prev, req];
                try {
                  localStorage.setItem("kyro_pending_reviews", JSON.stringify(next.map((r) => r.review_id)));
                  window.dispatchEvent(new Event("kyro_reviews_changed"));
                } catch {}
                return next;
              });
              // Push to global overlay — visible on any page
              tryAddToGlobalReview(req);
            }
            return;
          }

          if (msg.type === "zone_auto_created" || msg.type === "zone_proposals") {
            if (role === "admin") console.info("[Kyro] Zone learned:", msg);
            return;
          }

          if (msg.type === "seat_available_alert") {
            tryAddToGlobalSeatAlert({
              camera_id: msg.camera_id,
              seat_id: msg.seat_id,
              timestamp: msg.timestamp,
            });
            return;
          }

          // ── Snapshot: replace full seat cache ─────────────────────
          if (msg.type === "snapshot") {
            const cache = new Map<string, import("@/types").SeatState>();
            for (const s of (msg.seat_states ?? [])) cache.set(s.seat_id, s);
            seatCacheRef.current = cache;
          }

          // ── Delta: patch only changed seats into cache ─────────────
          if (msg.type === "delta") {
            for (const s of (msg.seat_states ?? [])) {
              const existing = seatCacheRef.current.get(s.seat_id);
              seatCacheRef.current.set(s.seat_id, existing ? { ...existing, ...s } : s);
            }
          }

          // Legacy frames with no type field — treat as snapshot
          if (!msg.type || msg.type === "frame") {
            const cache = new Map<string, import("@/types").SeatState>();
            for (const s of (msg.seat_states ?? [])) cache.set(s.seat_id, s);
            seatCacheRef.current = cache;
          }

          // Throttle React re-renders to ~4fps regardless of how fast frames arrive
          const now = Date.now();
          if (now - lastUpdateRef.current >= THROTTLE_MS) {
            lastUpdateRef.current = now;
            setData({
              ...msg,
              seat_states: Array.from(seatCacheRef.current.values()),
            } as PipelineUpdate);
          }
        } catch {
          // malformed — skip
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        retryRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        setError("WebSocket connection failed");
        ws.close();
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (retryRef.current) clearTimeout(retryRef.current);
      if (wsRef.current) {
        wsRef.current.onopen    = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose   = null;
        wsRef.current.onerror   = null;
        wsRef.current.close();
      }
    };
  }, [cameraId]);

  return { data, connected, error, reviews, dismissReview };
}
