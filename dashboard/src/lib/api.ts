/**
 * Kyro API Client
 *
 * Thin wrapper around fetch. Reads JWT from localStorage.
 * All requests include Authorization: Bearer <token>.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("kyro_token") : null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail ?? res.statusText);
  }
  return res.json();
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (username: string, password: string) =>
    request<{ access_token: string; token_type: string; expires_in: number }>(
      "/api/v1/auth/token",
      { method: "POST", body: JSON.stringify({ username, password }) }
    ),
};

// ─── Cameras ─────────────────────────────────────────────────────────────────

export const camerasApi = {
  list: () => request<import("@/types").Camera[]>("/api/v1/cameras"),
  create: (body: { name: string; stream_url: string; location?: string }) =>
    request<import("@/types").Camera>("/api/v1/cameras", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  status: (id: string) =>
    request<import("@/types").CameraStatus>(`/api/v1/cameras/${id}/status`),
};

// ─── Seats ───────────────────────────────────────────────────────────────────

export const seatsApi = {
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
};

// ─── Analytics ───────────────────────────────────────────────────────────────

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
