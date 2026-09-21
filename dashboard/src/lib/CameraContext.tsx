"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { camerasApi, seatsApi, ApiError } from "@/lib/api";
import { DEMO_MODE, DEMO_CAMERAS } from "@/lib/demo";
import type { Camera } from "@/types";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

const DEMO_OVERRIDES_KEY = "kyro_demo_camera_overrides";
const DEMO_ADDED_KEY     = "kyro_demo_cameras_added";
const DEMO_DELETED_KEY   = "kyro_demo_cameras_deleted";

// ─── Demo helpers ─────────────────────────────────────────────────────────────

function loadDemoCameras(): Camera[] {
  const base = DEMO_CAMERAS as Camera[];
  try {
    const overrides: Record<string, Partial<Camera>> = JSON.parse(localStorage.getItem(DEMO_OVERRIDES_KEY) ?? "{}");
    const extra: Camera[]    = JSON.parse(localStorage.getItem(DEMO_ADDED_KEY)   ?? "[]");
    const deletedIds: string[] = JSON.parse(localStorage.getItem(DEMO_DELETED_KEY) ?? "[]");
    const merged = base
      .filter((c) => !deletedIds.includes(c.camera_id))
      .map((c) => overrides[c.camera_id] ? { ...c, ...overrides[c.camera_id] } : c);
    return [...merged, ...extra.filter((c) => !deletedIds.includes(c.camera_id))];
  } catch { return base; }
}

function saveDemoOverride(cameraId: string, fields: Partial<Camera>) {
  try {
    const overrides: Record<string, Partial<Camera>> = JSON.parse(localStorage.getItem(DEMO_OVERRIDES_KEY) ?? "{}");
    overrides[cameraId] = { ...(overrides[cameraId] ?? {}), ...fields };
    localStorage.setItem(DEMO_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {}
}

// ─── Context shape ────────────────────────────────────────────────────────────

interface CameraContextValue {
  cameras:      Camera[];
  loading:      boolean;
  error:        string | null;
  refresh:      () => Promise<void>;
  updateCamera: (id: string, fields: Partial<Camera>) => Promise<void>;
  addCamera:    (fields: { name: string; stream_url: string; location?: string; zone_name?: string; zone_capacity?: number; zone_order?: number }) => Promise<void>;
  deleteCamera: (id: string) => Promise<void>;
}

const CameraContext = createContext<CameraContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CameraProvider({ children }: { children: ReactNode }) {
  // Start with empty list — populated after mount so SSR and client always agree
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (inDemoMode()) {
      setCameras(loadDemoCameras());
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setCameras(await camerasApi.list());
    } catch (e: any) {
      // 401 = token expired or missing — let the auth hook handle redirect
      if (e instanceof ApiError && e.status === 401) {
        setError("Session expired. Please log in again.");
      } else {
        setError(e.message ?? "Could not load cameras");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Hydrate on client mount — avoids SSR/client mismatch
  useEffect(() => { refresh(); }, [refresh]);

  const updateCamera = useCallback(async (cameraId: string, fields: Partial<Camera>) => {
    setCameras((prev) => prev.map((c) => c.camera_id === cameraId ? { ...c, ...fields } : c));
    if (inDemoMode()) { saveDemoOverride(cameraId, fields); return; }
    await camerasApi.update(cameraId, {
      name:          fields.name          ?? undefined,
      zone_name:     fields.zone_name     ?? undefined,
      stream_url:    fields.stream_url    ?? undefined,
      zone_capacity: fields.zone_capacity ?? undefined,
    });
  }, []);

  const addCamera = useCallback(async (
    fields: { name: string; stream_url: string; location?: string; zone_name?: string; zone_capacity?: number; zone_order?: number }
  ) => {
    const isQueue = fields.location === "queue";
    const capacity = fields.zone_capacity ?? 0;

    if (inDemoMode()) {
      const newCam: Camera = {
        camera_id:     `demo-custom-${Date.now()}`,
        name:          fields.name,
        stream_url:    fields.stream_url,
        location:      fields.location ?? null,
        zone_name:     fields.zone_name ?? fields.name,
        zone_capacity: capacity,
        zone_order:    fields.zone_order ?? 99,
        is_active:     true,
        created_at:    new Date().toISOString(),
      };
      setCameras((prev) => [...prev, newCam]);
      try {
        const saved: Camera[] = JSON.parse(localStorage.getItem(DEMO_ADDED_KEY) ?? "[]");
        saved.push(newCam);
        localStorage.setItem(DEMO_ADDED_KEY, JSON.stringify(saved));
      } catch {}

      // Auto-generate a demo seat layout for indoor cameras with capacity
      if (!isQueue && capacity > 0) {
        try {
          const DEMO_LAYOUTS_KEY = "kyro_demo_layouts";
          const { generateSeatsFromCapacity } = await import("@/lib/seatGenerator");
          const seats = generateSeatsFromCapacity(capacity);
          const layouts = JSON.parse(localStorage.getItem(DEMO_LAYOUTS_KEY) ?? "{}");
          layouts[newCam.camera_id] = {
            id: Date.now(), camera_id: newCam.camera_id,
            name: `${fields.name} — auto`, is_active: true,
            seat_count: seats.length, created_at: new Date().toISOString(), seats,
          };
          localStorage.setItem(DEMO_LAYOUTS_KEY, JSON.stringify(layouts));
        } catch {}
      }
      return;
    }

    const created = await camerasApi.create(fields);
    setCameras((prev) => [...prev, created]);

    // Auto-generate and activate a layout for indoor cameras with capacity
    if (!isQueue && capacity > 0) {
      seatsApi.autoGenerateLayout(created.camera_id, created.name, capacity)
        .catch(() => {}); // non-fatal — user can draw manually if this fails
    }
  }, []);

  const deleteCamera = useCallback(async (cameraId: string) => {
    setCameras((prev) => prev.filter((c) => c.camera_id !== cameraId));
    if (inDemoMode()) {
      try {
        const deleted: string[] = JSON.parse(localStorage.getItem(DEMO_DELETED_KEY) ?? "[]");
        if (!deleted.includes(cameraId)) deleted.push(cameraId);
        localStorage.setItem(DEMO_DELETED_KEY, JSON.stringify(deleted));
        const added: Camera[] = JSON.parse(localStorage.getItem(DEMO_ADDED_KEY) ?? "[]");
        localStorage.setItem(DEMO_ADDED_KEY, JSON.stringify(added.filter((c) => c.camera_id !== cameraId)));
      } catch {}
      return;
    }
    await camerasApi.delete(cameraId);
  }, []);

  return (
    <CameraContext.Provider value={{ cameras, loading, error, refresh, updateCamera, addCamera, deleteCamera }}>
      {children}
    </CameraContext.Provider>
  );
}

export function useCameraContext() {
  const ctx = useContext(CameraContext);
  if (!ctx) throw new Error("useCameraContext must be used inside CameraProvider");
  return ctx;
}
