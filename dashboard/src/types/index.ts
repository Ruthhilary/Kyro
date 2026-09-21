// Kyro Dashboard — Shared Types

// ─── Occupancy ──────────────────────────────────────────────────────────────

export type OccupancyState =
  | "occupied"
  | "temporarily_vacant"
  | "likely_available"
  | "available"
  | "reserved"
  | "rota_hold"
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
  reserved?: boolean;
  reserved_for?: string | null;
  in_exclusion_zone?: boolean;
  vacancy_seconds?: number;   // how long seat has been vacant — shown as live timer in UI
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

// ─── Live review ─────────────────────────────────────────────────────────────

export interface ReviewRequest {
  type: "review_request";
  review_id: string;
  camera_id: string;
  review_type: "stage_question" | "front_rush_question" | "absence_question" | "zone_proposal" | "altar_call_question";
  /** Which role should see this question — "admin" for spatial, "operator" for people */
  target_role: "admin" | "operator";
  question: string;
  track_id: number;
  seat_id: string | null;
  position: [number, number];
  bbox_hint: number[] | null;
  confidence: number;
  best_guess: string | null;
  options: string[];
  created_at: number;
}

export interface ZoneProposal {
  type: "zone_proposals";
  camera_id: string;
  proposals: { cx: number; cy: number; confirmations: number }[];
}

// ─── Camera management ───────────────────────────────────────────────────────

export interface Camera {
  camera_id: string;
  name: string;
  stream_url: string;
  location: string | null;
  zone_name: string | null;
  zone_capacity: number;
  zone_order: number;
  is_active: boolean;
  created_at: string;
}

export interface ZoneLive {
  camera_id: string;
  zone_name: string;
  camera_name: string;
  current: number;
  peak: number;
  entries: number;
  exits: number;
  capacity: number;
  occupancy_pct: number;
  is_running: boolean;
  /** "online" | "offline" | "error" — error means frames are flowing but
   *  look blank/frozen (camera physically failed without being detected
   *  as disconnected). */
  status: string;
  error_reason: string | null;
}

export interface VenueTotal {
  total_current: number;
  total_peak: number;
  total_entries: number;
  total_exits: number;
  total_capacity: number;
  venue_occupancy_pct: number;
  zones: ZoneLive[];
  cameras_running: number;
  cameras_total: number;
}

export interface CameraStatus {
  camera_id: string;
  is_running: boolean;
  status: string;
  error_reason: string | null;
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

export interface MeResponse {
  username: string;
  display_name: string;
  role: string;
  authenticated_at: string;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export interface UserResponse {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
}

// ─── Attendance sessions ──────────────────────────────────────────────────────

export interface LiveMetrics {
  camera_id: string;
  current_attendance: number;
  peak_attendance: number;
  total_entries: number;
  total_exits: number;
  occupancy_percent: number;
  timestamp: number;
}

export interface AlertResponse {
  camera_id: string;
  alert: boolean;
  message: string;
  current_attendance: number;
  venue_capacity: number;
  occupancy_percent: number;
}

export interface SessionResponse {
  session_id: string;
  camera_id: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  venue_capacity: number;
  peak_attendance: number;
  total_entries: number;
  total_exits: number;
}
