// Kyro Dashboard — Shared Types

export type OccupancyState =
  | "occupied"
  | "temporarily_vacant"
  | "likely_available"
  | "available"
  | "unknown";

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

export interface CameraHealth {
  camera_id: string;
  connected: boolean;
  fps: number;
  last_frame_ms: number;
}
