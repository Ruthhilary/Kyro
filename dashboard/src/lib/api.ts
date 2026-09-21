/**
 * Kyro API Client
 *
 * Thin wrapper around fetch. Reads JWT from localStorage.
 * All requests include Authorization: Bearer <token>.
 *
 * In demo mode the stored token is a fake demo token. We auto-fetch
 * a real token from the backend so write operations (save layout, etc.)
 * work correctly. The real token is cached under kyro_real_token.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO === "true";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

// Cache a real backend token when running in demo mode
let _realTokenPromise: Promise<string | null> | null = null;

async function getRealToken(): Promise<string | null> {
  if (!_realTokenPromise) {
    _realTokenPromise = (async () => {
      try {
        const cached = localStorage.getItem("kyro_real_token");
        if (cached) return cached;
        const res = await fetch(`${API_URL}/api/v1/auth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: process.env.NEXT_PUBLIC_DEMO_USER ?? "kharis-tech",
            password: process.env.NEXT_PUBLIC_DEMO_PASS ?? "Kharis2024!",
          }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const token = data.access_token as string;
        localStorage.setItem("kyro_real_token", token);
        return token;
      } catch {
        return null;
      }
    })();
  }
  return _realTokenPromise;
}

async function getAuthHeader(): Promise<Record<string, string>> {
  if (typeof window === "undefined") return {};

  const stored = localStorage.getItem("kyro_token");

  // If we have a real signed token, use it
  if (stored && !stored.includes("demo_signature_not_verified")) {
    return { Authorization: `Bearer ${stored}` };
  }

  // In demo mode, fetch a real token from the backend for API writes
  if (inDemoMode()) {
    const real = await getRealToken();
    if (real) return { Authorization: `Bearer ${real}` };
  }

  return {};
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const authHeaders = await getAuthHeader();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
    ...authHeaders,
  };

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    // If real token expired in demo mode, clear cache and retry once
    if (res.status === 401 && inDemoMode()) {
      localStorage.removeItem("kyro_real_token");
      _realTokenPromise = null;
      const freshAuth = await getAuthHeader();
      const retryHeaders = { "Content-Type": "application/json", ...(options.headers as Record<string, string>), ...freshAuth };
      const retry = await fetch(`${API_URL}${path}`, { ...options, headers: retryHeaders });
      if (!retry.ok) {
        const body = await retry.json().catch(() => ({}));
        throw new ApiError(retry.status, body.detail ?? retry.statusText);
      }
      if (retry.status === 204 || retry.headers.get("content-length") === "0") return undefined as T;
      return retry.json();
    }
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail ?? res.statusText);
  }
  // 204 No Content — nothing to parse
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  return res.json();
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (username: string, password: string) =>
    request<{ access_token: string; token_type: string; expires_in: number }>(
      "/api/v1/auth/token",
      { method: "POST", body: JSON.stringify({ username, password }) }
    ),
  me: () => request<import("@/types").MeResponse>("/api/v1/auth/me"),
};

// ─── Cameras ─────────────────────────────────────────────────────────────────

export const camerasApi = {
  list: () => request<import("@/types").Camera[]>("/api/v1/cameras"),
  create: (body: {
    name: string; stream_url: string; location?: string;
    zone_name?: string; zone_capacity?: number; zone_order?: number;
  }) =>
    request<import("@/types").Camera>("/api/v1/cameras", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: {
    name?: string; stream_url?: string; location?: string;
    zone_name?: string; zone_capacity?: number; zone_order?: number;
  }) =>
    request<import("@/types").Camera>(`/api/v1/cameras/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    request<void>(`/api/v1/cameras/${id}`, { method: "DELETE" }),
  status: (id: string) =>
    request<import("@/types").CameraStatus>(`/api/v1/cameras/${id}/status`),
  /** Returns the snapshot URL — caller adds ?token= for auth (fallback still image) */
  snapshotUrl: (cameraId: string) => `${API_URL}/api/v1/cameras/${cameraId}/snapshot`,
  /** Live MJPEG stream URL — an <img> tag can point straight at this, no polling. */
  streamUrl: (cameraId: string) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("kyro_token") : null;
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${API_URL}/api/v1/cameras/${cameraId}/stream${qs}`;
  },
  venueTotal: () =>
    request<import("@/types").VenueTotal>("/api/v1/venue/total"),
};

// ─── Reserved seats ───────────────────────────────────────────────────────────

export const reservedApi = {
  list: (cameraId: string) =>
    request<{ seat_id: string; reserved_for: string | null; note: string | null }[]>(
      `/api/v1/reserved/${cameraId}`
    ),
  reserve: (cameraId: string, seatId: string, reservedFor?: string) =>
    request<{ seat_id: string; reserved_for: string | null; note: string | null }>(
      `/api/v1/reserved/${cameraId}`,
      { method: "POST", body: JSON.stringify({ seat_id: seatId, reserved_for: reservedFor ?? null }) }
    ),
  unreserve: (cameraId: string, seatId: string) =>
    request<void>(`/api/v1/reserved/${cameraId}/${seatId}`, { method: "DELETE" }),
  clearAll: (cameraId: string) =>
    request<void>(`/api/v1/reserved/${cameraId}`, { method: "DELETE" }),
};

export const seatsResetApi = {
  fullReset: (cameraId: string) =>
    request<{ reset: boolean; reservations_cleared: number }>(
      `/api/v1/seats/${cameraId}/full-reset`,
      { method: "POST" }
    ),
};

// ─── Seats ───────────────────────────────────────────────────────────────────

// What a zone actually DOES — never inferred from its label text.
//   hold_seats — stage/altar/choir: overlapping seats stay held while active
//   ignore     — exit/toilet/walkway: purely informational, never holds a seat
export type ZoneType = "hold_seats" | "ignore";

export interface ZoneDef {
  zone_id: string;
  label: string;
  zone_type: ZoneType;
  bbox: [number, number, number, number];
  hold_seats_in_rows: string[];
  is_active: boolean;
}

export const zonesApi = {
  list: (cameraId: string) =>
    request<ZoneDef[]>(`/api/v1/zones/${cameraId}`),
  create: (cameraId: string, body: { label: string; zone_type: ZoneType; bbox: number[]; hold_seats_in_rows?: string[] }) =>
    request<ZoneDef>(`/api/v1/zones/${cameraId}`, { method: "POST", body: JSON.stringify(body) }),
  update: (cameraId: string, zoneId: string, body: { label: string; zone_type: ZoneType; bbox: number[]; hold_seats_in_rows?: string[] }) =>
    request<ZoneDef>(`/api/v1/zones/${cameraId}/${zoneId}`, { method: "PUT", body: JSON.stringify(body) }),
  delete: (cameraId: string, zoneId: string) =>
    request<void>(`/api/v1/zones/${cameraId}/${zoneId}`, { method: "DELETE" }),
};

export const seatsApi = {
  /** Evidence photo URL for a seat-available alert — token as query param
   *  since this is used directly in an <img> src (can't set headers). */
  availableSnapshotUrl: (cameraId: string, seatId: string) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("kyro_token") : null;
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${API_URL}/api/v1/seats/${cameraId}/${seatId}/available-snapshot${qs}`;
  },
  listLayouts: (cameraId: string) =>
    request<import("@/types").SeatLayout[]>(
      `/api/v1/seats/${cameraId}/layouts`
    ),
  createLayout: (
    cameraId: string,
    body: { name: string; seats: import("@/types").SeatDefinition[] }
  ) =>
    request<import("@/types").SeatLayout>(
      `/api/v1/seats/${cameraId}/layouts`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  activateLayout: (cameraId: string, layoutId: number) =>
    request<{ activated: boolean; seat_count: number }>(
      `/api/v1/seats/${cameraId}/layouts/${layoutId}/activate`,
      { method: "POST" }
    ),
  deleteLayout: (cameraId: string, layoutId: number) =>
    request<void>(`/api/v1/seats/${cameraId}/layouts/${layoutId}`, { method: "DELETE" }),

  /** Auto-generate and activate a layout from the camera's capacity. Called when a camera is first registered. */
  autoGenerateLayout: async (cameraId: string, cameraName: string, capacity: number) => {
    if (capacity <= 0) return null;
    const { generateSeatsFromCapacity } = await import("@/lib/seatGenerator");
    const seats = generateSeatsFromCapacity(capacity);
    const layout = await request<import("@/types").SeatLayout>(
      `/api/v1/seats/${cameraId}/layouts`,
      { method: "POST", body: JSON.stringify({ name: `${cameraName} — auto`, seats }) }
    );
    await request<{ activated: boolean; seat_count: number }>(
      `/api/v1/seats/${cameraId}/layouts/${layout.id}/activate`,
      { method: "POST" }
    );
    return layout;
  },
};

// ─── Attendance & Sessions ────────────────────────────────────────────────────

export const attendanceApi = {
  live: (cameraId: string) =>
    request<import("@/types").LiveMetrics>(`/api/v1/attendance/live/${cameraId}`),
  alerts: (cameraId: string, threshold = 0.9) =>
    request<import("@/types").AlertResponse>(
      `/api/v1/attendance/alerts/${cameraId}?threshold=${threshold}`
    ),
  listSessions: () =>
    request<import("@/types").SessionResponse[]>("/api/v1/attendance/sessions"),
  createSession: (body: { camera_id: string; name: string; venue_capacity?: number }) =>
    request<import("@/types").SessionResponse>("/api/v1/attendance/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getSession: (id: string) =>
    request<import("@/types").SessionResponse>(`/api/v1/attendance/sessions/${id}`),
  endSession: (id: string) =>
    request<import("@/types").SessionResponse>(`/api/v1/attendance/sessions/${id}/end`, {
      method: "PUT",
    }),
  renameSession: (id: string, name: string) =>
    request<import("@/types").SessionResponse>(`/api/v1/attendance/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteSession: (id: string) =>
    request<void>(`/api/v1/attendance/sessions/${id}`, { method: "DELETE" }),
  exportSessionCsv: (id: string) => `${API_URL}/api/v1/attendance/sessions/${id}/export`,
};

// ─── Users ────────────────────────────────────────────────────────────────────

export const usersApi = {
  list: () => request<import("@/types").UserResponse[]>("/api/v1/users"),
  create: (body: { username: string; password: string; role?: string; display_name?: string }) =>
    request<import("@/types").UserResponse>("/api/v1/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: number, body: { display_name?: string; role?: string; is_active?: boolean }) =>
    request<import("@/types").UserResponse>(`/api/v1/users/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deactivate: (id: number) =>
    request<void>(`/api/v1/users/${id}`, { method: "DELETE" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: boolean }>("/api/v1/users/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
};

export const analyticsApi = {
  history: (cameraId: string, days = 7) =>
    request<import("@/types").AttendancePoint[]>(
      `/api/v1/analytics/${cameraId}/history?days=${days}`
    ),
  weekly: (cameraId: string, weeks = 12) =>
    request<import("@/types").WeeklyBucket[]>(
      `/api/v1/analytics/${cameraId}/weekly?weeks=${weeks}`
    ),
  heatmap: (cameraId: string, days = 30) =>
    request<import("@/types").HeatmapData>(
      `/api/v1/analytics/${cameraId}/heatmap?days=${days}`
    ),
  arrival: (cameraId: string, days = 30) =>
    request<import("@/types").HourlyBucket[]>(
      `/api/v1/analytics/${cameraId}/arrival?days=${days}`
    ),
  summary: (cameraId: string) =>
    request<import("@/types").AnalyticsSummary>(
      `/api/v1/analytics/${cameraId}/summary`
    ),
};
