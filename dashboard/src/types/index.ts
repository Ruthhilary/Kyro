// Kyro Dashboard — Shared Types

// ─── Occupancy ──────────────────────────────────────────────────────────────

export type OccupancyState =
  | "occupied"
  | "temporarily_vacant"
  | "likely_available"
  | "available"
  | "unknown";

// ─── Live pipeline ───────────────────────────────────────────────────────────

export interface AttendanceMetrics {
  current: number;
  peak: number;
  entries: number;
  exits: number;
  occupancy_pct: number;
}

export interface SeatState {
  seat_id: string;
  row: string;
  number: number;
  section: string;
  state: OccupancyState;
  confidence: number;
  occupying_track_id: number | null;
  bbox: [number, number, number, number];
}

export interface PipelineUpdate {
  camera_id: string;
  frame_number: number;
  timestamp: number;
  attendance: AttendanceMetrics;
  seat_states: SeatState[];
  perf: {
    inference_ms: number;
    total_ms: number;
  };
}

// ─── Camera management ───────────────────────────────────────────────────────

export interface Camera {
  camera_id: string;
  name: string;
  stream_url: string;
  location: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CameraStatus {
  camera_id: string;
  is_running: boolean;
  last_frame_timestamp: number | null;
  fps_actual: number | null;
  inference_ms: number | null;
  total_connections: number;
}

// ─── Seat layouts ────────────────────────────────────────────────────────────

export interface SeatDefinition {
  seat_id: string;
  row: string;
  number: number;
  section: string;
  bbox: [number, number, number, number];
}

export interface SeatLayout {
  id: number;
  camera_id: string;
  name: string;
  is_active: boolean;
  seat_count: number;
  created_at: string;
  seats: SeatDefinition[];
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface AttendancePoint {
  timestamp: string;
  attendance: number;
  occupancy_pct: number;
}

export interface WeeklyBucket {
  week_start: string;
  avg_attendance: number;
  peak_attendance: number;
  total_sessions: number;
}

export interface HeatmapData {
  camera_id: string;
  grid: number[][];
  rows: number;
  cols: number;
}

export interface HourlyBucket {
  hour: number;
  count: number;
  avg_count: number;
}

export interface AnalyticsSummary {
  camera_id: string;
  total_sessions: number;
  all_time_peak: number;
  avg_attendance: number;
  avg_occupancy_pct: number;
  first_session: string | null;
  last_session: string | null;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}
