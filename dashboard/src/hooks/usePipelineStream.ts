"use client";

/**
 * usePipelineStream
 *
 * Subscribes to the Kyro backend WebSocket for a given camera_id.
 * Returns live PipelineUpdate data, connection status, and error state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineUpdate } from "@/types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";
const RECONNECT_DELAY_MS = 3000;

interface UsePipelineStreamResult {
  data: PipelineUpdate | null;
  connected: boolean;
  error: string | null;
}

export function usePipelineStream(cameraId: string): UsePipelineStreamResult {
  const [data, setData] = useState<PipelineUpdate | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const ws = new WebSocket(`${WS_URL}/ws/${cameraId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (event) => {
      try {
        const update: PipelineUpdate = JSON.parse(event.data);
        setData(update);
      } catch {
        // Malformed frame — skip silently
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (mountedRef.current) {
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
      ws.close();
    };
  }, [cameraId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { data, connected, error };
}
