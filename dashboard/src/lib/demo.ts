/**
 * Kyro Demo Mode
 *
 * Set NEXT_PUBLIC_DEMO=true in .env.local to enable.
 * When active:
 * - Login is bypassed (fake admin token injected)
 * - All API calls are intercepted and return fake data
 * - WebSocket is replaced with a simulated live feed
 * - A fake review question fires after 8 seconds
 */

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO === "true";

/** 
 * Returns true if the user is currently in live mode.
 * ONLY call this inside useEffect or event handlers — not during render.
 */
export function isLiveMode(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("kyro_mode") === "live";
}

/** Call when user picks Live mode on login screen */
export function setLiveMode() {
  if (typeof window !== "undefined") {
    localStorage.setItem("kyro_mode", "live");
    sessionStorage.setItem("kyro_live_mode", "1");
  }
}

/** Call when user picks Demo mode on login screen */
export function setDemoMode() {
  if (typeof window !== "undefined") {
    localStorage.setItem("kyro_mode", "demo");
    sessionStorage.removeItem("kyro_live_mode");
  }
}

// ---------------------------------------------------------------------------
// Fake JWT — decodes to { sub: "admin", role: "admin" }
// ---------------------------------------------------------------------------
// Header: {"alg":"HS256","typ":"JWT"}
// Payload: {"sub":"admin","role":"admin","iat":1700000000,"exp":9999999999}
export const DEMO_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjo5OTk5OTk5OTk5fQ." +
  "demo_signature_not_verified";

// ---------------------------------------------------------------------------
// Fake seat layout — 7 rows tapering like a real auditorium
// ---------------------------------------------------------------------------
export const ROW_CONFIG = [
  { row: "A", count: 10 },
  { row: "B", count: 13 },
  { row: "C", count: 13 },
  { row: "D", count: 14 },
  { row: "E", count: 14 },
  { row: "F", count: 13 },
  { row: "G", count: 14 },
];

export type DemoSeatState = {
  seat_id: string;
  row: string;
  number: number;
  section: string;
  state: "occupied" | "available" | "temporarily_vacant" | "reserved" | "rota_hold";
  confidence: number;
  occupying_track_id: number | null;
  bbox: [number, number, number, number];
  reserved: boolean;
  reserved_for: string | null;
  in_exclusion_zone: boolean;
};

function makeDemoSeats(
  occupiedCount: number,
  reservedIds: string[] = ["D7"],
  rotaRows: string[] = [],
  totalSeats?: number,
): DemoSeatState[] {
  // Large venue mode — flat bowl layout, no section grouping
  if (totalSeats && totalSeats > 200) {
    // Cap rendered seats at 500k — beyond that the browser can't hold the objects.
    // The attendance COUNT still reflects the real capacity, only the visual is capped.
    const renderSeats = Math.min(totalSeats, 500_000);
    const seatsPerRow = Math.min(200, Math.ceil(Math.sqrt(renderSeats * 3)));
    const numRows     = Math.ceil(renderSeats / seatsPerRow);

    // Generate row labels: A-Z, then AA-AZ, BA-BZ etc.
    const rowLabels: string[] = [];
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; rowLabels.length < numRows; i++) {
      if (i < 26) {
        rowLabels.push(alpha[i]);
      } else {
        const prefix = alpha[Math.floor(i / 26) - 1];
        rowLabels.push(prefix + alpha[i % 26]);
      }
    }

    const seats: DemoSeatState[] = [];
    let remaining     = Math.min(occupiedCount, renderSeats);
    let totalReserved = Math.round(renderSeats * 0.04);

    for (let ri = 0; ri < numRows && seats.length < totalSeats; ri++) {
      const row = rowLabels[ri];
      // Taper the ends slightly — fewer seats on first and last few rows
      const taper  = ri < 3 ? 0.6 + ri * 0.13 : ri > numRows - 4 ? 0.6 + (numRows - 1 - ri) * 0.13 : 1;
      const count  = Math.min(Math.round(seatsPerRow * taper), totalSeats - seats.length);

      for (let n = 1; n <= count; n++) {
        const id    = `${row}${n}`;
        const isRsv = totalReserved > 0 && Math.random() < 0.04;
        if (isRsv) totalReserved--;

        let state: DemoSeatState["state"] = "available";
        if (isRsv) state = "reserved";
        else if (remaining > 0) { state = "occupied"; remaining--; }

        seats.push({
          seat_id: id, row, number: n, section: "Main Bowl",
          state, confidence: 0.9,
          occupying_track_id: state === "occupied" ? n : null,
          bbox: [0,0,0,0], reserved: isRsv,
          reserved_for: isRsv ? "VIP" : null, in_exclusion_zone: false,
        });
      }
    }
    return seats;
  }

  let remaining = occupiedCount;
  const seats: DemoSeatState[] = [];

  for (const { row, count } of ROW_CONFIG) {
    for (let n = 1; n <= count; n++) {
      const id       = `${row}${n}`;
      const isRsv    = reservedIds.includes(id);
      const isRota   = rotaRows.includes(row);

      let state: DemoSeatState["state"] = "available";
      if (isRsv)        state = "reserved";
      else if (isRota)  state = "rota_hold";
      else if (remaining > 0) { state = "occupied"; remaining--; }

      seats.push({
        seat_id:            id,
        row,
        number:             n,
        section:            "Main Floor",
        state,
        confidence:         state === "occupied" ? 0.93 : 0.82,
        occupying_track_id: state === "occupied" ? Math.floor(Math.random() * 50 + 1) : null,
        bbox:               [0, 0, 0, 0],
        reserved:           isRsv,
        reserved_for:       isRsv ? "Pastor John" : null,
        in_exclusion_zone:  false,
      });
    }
  }
  return seats;
}

// ---------------------------------------------------------------------------
// Fake cameras
// ---------------------------------------------------------------------------
export const DEMO_CAMERAS = [
  {
    camera_id:     "demo-main",
    name:          "Main Floor Cam",
    stream_url:    "demo://",
    location:      "Front",
    zone_name:     "Main Floor",
    zone_capacity: 91,
    zone_order:    0,
    is_active:     true,
    created_at:    "2026-01-01T00:00:00Z",
  },
  {
    camera_id:     "demo-balcony",
    name:          "Balcony Cam",
    stream_url:    "demo://",
    location:      "Upper level",
    zone_name:     "Balcony",
    zone_capacity: 60,
    zone_order:    1,
    is_active:     true,
    created_at:    "2026-01-01T00:00:00Z",
  },
  {
    camera_id:     "demo-overflow",
    name:          "Overflow Cam",
    stream_url:    "demo://",
    location:      "Side hall",
    zone_name:     "Overflow Room",
    zone_capacity: 50,
    zone_order:    2,
    is_active:     true,
    created_at:    "2026-01-01T00:00:00Z",
  },
  {
    camera_id:     "demo-stadium",
    name:          "Stadium Cam",
    stream_url:    "demo://",
    location:      "Main Bowl",
    zone_name:     "Stadium — Main Bowl",
    zone_capacity: 10000,
    zone_order:    3,
    is_active:     true,
    created_at:    "2026-01-01T00:00:00Z",
  },
  {
    camera_id:     "demo-outside",
    name:          "Outside Cam",
    stream_url:    "demo://",
    location:      "queue",
    zone_name:     "Outside",
    zone_capacity: 0,
    zone_order:    4,
    is_active:     true,
    created_at:    "2026-01-01T00:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Global demo feed registry — so reset events can reach running feeds
// ---------------------------------------------------------------------------
const _demoFeeds: Map<string, DemoFeed> = new Map();

export function registerDemoFeed(cameraId: string, feed: DemoFeed) {
  _demoFeeds.set(cameraId, feed);
}

export function resetDemoFeed(cameraId: string) {
  _demoFeeds.get(cameraId)?.reset();
}

// ---------------------------------------------------------------------------
// Live fake pipeline state generator
// ---------------------------------------------------------------------------
export class DemoFeed {
  private _current: number;
  private _peak:    number;
  private _entries: number;
  private _exits:   number;
  private _tick     = 0;
  private _seats:   DemoSeatState[];
  private _cameraId: string;

  constructor(cameraId: string, initialCount: number) {
    this._cameraId = cameraId;
    this._current  = initialCount;
    this._peak     = initialCount;
    this._entries  = initialCount;
    this._exits    = 0;

    const isStadium  = cameraId === "demo-stadium";
    const totalSeats = isStadium ? 10000 : undefined;

    // Try to use the auto-generated layout from localStorage first
    // (stored there when a camera is registered with a capacity)
    let seatsFromLayout: DemoSeatState[] | null = null;
    try {
      const storedLayouts = JSON.parse(localStorage.getItem("kyro_demo_layouts") ?? "{}");
      const layout = storedLayouts[cameraId];
      if (layout?.seats?.length > 0) {
        let remaining = initialCount;
        seatsFromLayout = layout.seats.map((s: any, i: number): DemoSeatState => {
          const occupied = remaining > 0 && s.seat_id !== "D7";
          if (occupied) remaining--;
          return {
            seat_id:            s.seat_id,
            row:                s.row,
            number:             s.number,
            section:            s.section ?? "Main",
            state:              occupied ? "occupied" : "available",
            confidence:         occupied ? 0.93 : 0.82,
            occupying_track_id: occupied ? i + 1 : null,
            bbox:               s.bbox ?? [0, 0, 0, 0],
            reserved:           false,
            reserved_for:       null,
            in_exclusion_zone:  false,
          };
        });
      }
    } catch {}

    this._seats = seatsFromLayout ?? makeDemoSeats(
      initialCount,
      isStadium ? [] : (cameraId === "demo-main" ? ["D7"] : []),
      isStadium ? [] : (cameraId === "demo-main" ? ["B"] : []),
      totalSeats,
    );
  }

  tick(): object {
    this._tick++;
    // Simulate realistic church attendance curve
    const phase = this._tick % 300;
    const cap = this._cameraId === "demo-main"     ? 91
               : this._cameraId === "demo-balcony"  ? 60
               : this._cameraId === "demo-overflow" ? 50
               : this._cameraId === "demo-stadium"  ? 10000
               : this._cameraId === "demo-outside"  ? 200
               : this._seats.length > 0 ? this._seats.length : 100;

    const delta =
      phase < 80  ? (Math.random() > 0.3 ? 1 : 0)
      : phase < 180 ? (Math.random() > 0.85 ? (Math.random() > 0.5 ? 1 : -1) : 0)
      : (Math.random() > 0.4 ? -1 : 0);

    // Cap at capacity — never exceed it
    this._current  = Math.min(cap, Math.max(0, this._current + delta));
    this._peak     = Math.max(this._peak, this._current);
    this._entries += Math.max(0, delta);
    this._exits   += Math.max(0, -delta);

    // Occasionally mutate a seat state for realism
    if (this._tick % 8 === 0) {
      const idx = Math.floor(Math.random() * this._seats.length);
      const s   = this._seats[idx];
      if (s.state === "reserved" || s.state === "rota_hold") {
        // never mutate
      } else if (s.state === "available" && this._current < cap * 0.9) {
        s.state = "occupied";
        s.occupying_track_id = Math.floor(Math.random() * 50 + 1);
      } else if (s.state === "occupied" && Math.random() < 0.1) {
        s.state = "temporarily_vacant";
        s.occupying_track_id = null;
      } else if (s.state === "temporarily_vacant" && Math.random() < 0.15) {
        s.state = Math.random() > 0.5 ? "occupied" : "available";
      }
    }

    return {
      type:         "frame",
      camera_id:    this._cameraId,
      frame_number: this._tick,
      timestamp:    Date.now() / 1000,
      attendance: {
        current:       this._current,
        peak:          this._peak,
        entries:       this._entries,
        exits:         this._exits,
        occupancy_pct: Math.round((this._current / cap) * 1000) / 10,
      },
      seat_states: this._seats,
      perf:        { inference_ms: 12.4, total_ms: 18.1, fps: 15 },
    };
  }

  get current()    { return this._current;  }
  get seats()      { return this._seats;    }

  /** Reset all seat states to available and zero attendance counters */
  reset(): void {
    this._current = 0;
    this._peak    = 0;
    this._entries = 0;
    this._exits   = 0;
    this._tick    = 0;
    this._seats   = this._seats.map((s) => ({
      ...s,
      state:              s.state === "reserved" || s.state === "rota_hold" ? s.state : "available" as const,
      occupying_track_id: null,
    }));
  }
}

// ---------------------------------------------------------------------------
// Fake review requests — rotating stream, fires every ~5 min in demo
// ---------------------------------------------------------------------------

const _REVIEW_POOL = [
  // Stage/altar questions — admin sees these
  {
    review_type: "stage_question" as const,
    target_role: "admin" as const,
    question: "Seat C5 (Main Floor) — person moved toward the front. Is this the stage or altar area?",
    track_id: 42, seat_id: "C5",
    position: [640, 120] as [number, number],
    bbox_hint: [540, 40, 740, 200],
    confidence: 0.52,
    best_guess: "stage_move",
    options: ["Yes, it's the stage/altar", "No — toilet break", "No — they left", "Ignore"],
  },
  {
    review_type: "zone_proposal" as const,
    target_role: "admin" as const,
    question: "Main Floor is at 89% capacity (81/91). Does this match what you see on the floor?",
    track_id: -1001, seat_id: null,
    position: [640, 360] as [number, number],
    bbox_hint: null,
    confidence: 0.75,
    best_guess: "seated",
    options: ["Yes — count looks right", "No — higher than shown", "No — lower than shown", "Ignore"],
  },
  {
    review_type: "stage_question" as const,
    target_role: "admin" as const,
    question: "Seat A3 (Main Floor, Row A) moved to the front-right area. Is that a known zone?",
    track_id: 58, seat_id: "A3",
    position: [900, 90] as [number, number],
    bbox_hint: [820, 20, 980, 160],
    confidence: 0.48,
    best_guess: "stage_move",
    options: ["Yes, it's the stage/altar", "No — toilet break", "Create a zone here", "Ignore"],
  },
  // Absence/people questions — operator sees these
  {
    review_type: "absence_question" as const,
    target_role: "operator" as const,
    question: "Seat B8 (Main Floor, Row B) has been empty for 7 min — where did they go?",
    track_id: 17, seat_id: "B8",
    position: [420, 380] as [number, number],
    bbox_hint: null,
    confidence: 0.38,
    best_guess: "absence",
    options: ["Toilet / short break", "Went on stage", "Left the building", "Still in seat (ignore)"],
  },
  {
    review_type: "absence_question" as const,
    target_role: "operator" as const,
    question: "Seat D12 (Main Floor, Row D) has been empty for 4 min — is it free now?",
    track_id: 31, seat_id: "D12",
    position: [0, 0] as [number, number],
    bbox_hint: null,
    confidence: 0.42,
    best_guess: "absence",
    options: ["Yes — free the seat", "No — they're coming back", "They went on stage", "Left the building"],
  },
  {
    review_type: "front_rush_question" as const,
    target_role: "operator" as const,
    question: "4 people from Main Floor moved toward the front — did someone go to the altar or stage?",
    track_id: -4003, seat_id: null,
    position: [640, 140] as [number, number],
    bbox_hint: null,
    confidence: 0.55,
    best_guess: "front_rush",
    options: ["Yes, altar/stage call", "No, just coincidence", "Pastor arrived at front", "Ignore"],
  },
  {
    review_type: "altar_call_question" as const,
    target_role: "operator" as const,
    question: "Seat E6 (Main Floor): person was at the front for ~3 min, then left 5 min ago — did they give their life to Christ?",
    track_id: 24, seat_id: "E6",
    position: [0, 0] as [number, number],
    bbox_hint: null,
    confidence: 0.5,
    best_guess: "gave_life",
    options: ["Yes — gave their life to Christ ✝", "No — went to the toilet", "No — left the building", "Still here (ignore)"],
  },
  {
    review_type: "absence_question" as const,
    target_role: "operator" as const,
    question: "Someone returned to Seat G2 (Main Floor, Row G) after 9 min away — is this the original occupant?",
    track_id: 65, seat_id: "G2",
    position: [0, 0] as [number, number],
    bbox_hint: null,
    confidence: 0.6,
    best_guess: "seated",
    options: ["Yes — same person back", "No — different person", "Not sure (keep as occupied)", "Ignore"],
  },
  {
    review_type: "front_rush_question" as const,
    target_role: "operator" as const,
    question: "3 people from Balcony moved toward the aisle — are they finding seats, leaving, or is this a worship moment?",
    track_id: -3007, seat_id: null,
    position: [640, 200] as [number, number],
    bbox_hint: null,
    confidence: 0.45,
    best_guess: "seated",
    options: ["Finding seats — hold", "Worship / standing prayer", "Leaving the section", "Ignore"],
  },
  {
    review_type: "absence_question" as const,
    target_role: "operator" as const,
    question: "Seat F4 (Main Floor, Row F) has been temporarily vacant for 6 min — should it be marked free?",
    track_id: 89, seat_id: "F4",
    position: [0, 0] as [number, number],
    bbox_hint: null,
    confidence: 0.4,
    best_guess: "absence",
    options: ["Yes — mark it free", "No — still occupied", "Toilet break — keep hold", "Left the building"],
  },
];

const DEMO_ANSWERED_KEY = "kyro_demo_answered";

/**
 * Record that a demo review question has been answered.
 * Stores the question text + answer so the AI doesn't repeat it.
 */
export function recordDemoAnswer(reviewId: string, questionText: string, answer: string): void {
  if (typeof window === "undefined") return;
  try {
    const stored: Record<string, { question: string; answer: string; ts: number }> =
      JSON.parse(localStorage.getItem(DEMO_ANSWERED_KEY) ?? "{}");
    stored[reviewId] = { question: questionText, answer, ts: Date.now() };
    // Keep last 100 answered questions — prune old ones
    const entries = Object.entries(stored).sort((a, b) => b[1].ts - a[1].ts).slice(0, 100);
    localStorage.setItem(DEMO_ANSWERED_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

/**
 * Check if a question with the same text has already been answered.
 * Returns the answer if yes, null if it should be asked again.
 */
function getDemoAnswered(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored: Record<string, { question: string; answer: string; ts: number }> =
      JSON.parse(localStorage.getItem(DEMO_ANSWERED_KEY) ?? "{}");
    // Return the set of question texts that have been answered
    return new Set(Object.values(stored).map((v) => v.question));
  } catch { return new Set(); }
}

/**
 * Returns the next demo review question, skipping any already answered.
 * One question at a time — AI waits for answers before asking again.
 */
let _reviewPoolIdx = 0;
export function getNextDemoReviews(role: "admin" | "operator"): typeof DEMO_REVIEWS {
  const relevant = _REVIEW_POOL.filter((r) => r.target_role === role || r.target_role === "admin");
  const answered = getDemoAnswered();

  // Find next unanswered question — skip ones the AI already knows the answer to
  let attempts = 0;
  let item = relevant[_reviewPoolIdx % relevant.length];
  while (answered.has(item.question) && attempts < relevant.length) {
    _reviewPoolIdx++;
    attempts++;
    item = relevant[_reviewPoolIdx % relevant.length];
  }

  // If all questions have been answered, still cycle through but only ask
  // question types that change (absence/front rush) not spatial ones already learned
  if (attempts >= relevant.length) {
    const dynamic = relevant.filter((r) =>
      r.review_type === "absence_question" ||
      r.review_type === "front_rush_question" ||
      r.review_type === "altar_call_question"
    );
    if (dynamic.length > 0) {
      item = dynamic[_reviewPoolIdx % dynamic.length];
    }
  }

  _reviewPoolIdx++;

  return [{
    type: "review_request" as const,
    review_id: `demo-${Date.now()}-0`,
    camera_id: "demo-main",
    ...item,
    created_at: Date.now() / 1000,
  }];
}
export const DEMO_REVIEWS = _REVIEW_POOL.slice(0, 2).map((r) => ({
  type: "review_request" as const,
  review_id: `demo-r${_REVIEW_POOL.indexOf(r) + 1}`,
  camera_id: "demo-main",
  ...r,
  created_at: Date.now() / 1000,
}));



// ---------------------------------------------------------------------------
// Fake analytics data
// ---------------------------------------------------------------------------
export function makeDemoAnalytics() {
  const now   = Date.now();
  const day   = 86_400_000;

  const history = Array.from({ length: 30 }, (_, i) => {
    const t = new Date(now - (29 - i) * day);
    const base = 280 + Math.sin(i * 0.4) * 80;
    return {
      timestamp:     t.toISOString(),
      attendance:    Math.round(base + (Math.random() - 0.5) * 40),
      occupancy_pct: Math.round((base / 4) * 10) / 10,
    };
  });

  const heatmap = {
    camera_id: "demo-main",
    grid: Array.from({ length: 10 }, (_, r) =>
      Array.from({ length: 13 }, (_, c) =>
        Math.round(Math.random() * 100 * (r < 3 ? 0.4 : r < 7 ? 0.9 : 0.6))
      )
    ),
    rows: 10,
    cols: 13,
  };

  const arrival = Array.from({ length: 24 }, (_, h) => ({
    hour:      h,
    count:     h >= 8 && h <= 12 ? Math.round(40 + Math.random() * 60) : Math.round(Math.random() * 8),
    avg_count: h >= 8 && h <= 12 ? 55 : 3,
  }));

  const summary = {
    camera_id:        "demo-main",
    total_sessions:   24,
    all_time_peak:    412,
    avg_attendance:   287,
    avg_occupancy_pct: 72.4,
    first_session:    new Date(now - 180 * day).toISOString(),
    last_session:     new Date(now - day).toISOString(),
  };

  return { history, heatmap, arrival, summary };
}

// ---------------------------------------------------------------------------
// Fake sessions
// ---------------------------------------------------------------------------
const _now = Date.now();
export const DEMO_SESSIONS = [
  {
    session_id:       "sess-001",
    camera_id:        "demo-main",
    name:             "Sunday Morning Service",
    started_at:       new Date(_now - 2 * 3600_000).toISOString(),
    ended_at:         new Date(_now - 10 * 60_000).toISOString(),
    venue_capacity:   250,
    peak_attendance:  218,
    total_entries:    231,
    total_exits:      14,
  },
  {
    session_id:       "sess-002",
    camera_id:        "demo-main",
    name:             "Wednesday Bible Study",
    started_at:       new Date(_now - 7 * 86_400_000 - 1.5 * 3600_000).toISOString(),
    ended_at:         new Date(_now - 7 * 86_400_000).toISOString(),
    venue_capacity:   150,
    peak_attendance:  94,
    total_entries:    98,
    total_exits:      4,
  },
  {
    session_id:       "sess-003",
    camera_id:        "demo-balcony",
    name:             "Sunday Evening Praise",
    started_at:       new Date(_now - 14 * 86_400_000 - 2 * 3600_000).toISOString(),
    ended_at:         new Date(_now - 14 * 86_400_000).toISOString(),
    venue_capacity:   60,
    peak_attendance:  47,
    total_entries:    52,
    total_exits:      5,
  },
];

// ---------------------------------------------------------------------------
// Fake users
// ---------------------------------------------------------------------------
export const DEMO_USERS = [
  {
    id:           1,
    username:     "admin",
    display_name: "Admin",
    role:         "admin",
    is_active:    true,
    created_at:   new Date(_now - 90 * 86_400_000).toISOString(),
  },
  {
    id:           2,
    username:     "sarah.usher",
    display_name: "Sarah (Usher)",
    role:         "operator",
    is_active:    true,
    created_at:   new Date(_now - 60 * 86_400_000).toISOString(),
  },
  {
    id:           3,
    username:     "james.viewer",
    display_name: "James",
    role:         "viewer",
    is_active:    true,
    created_at:   new Date(_now - 30 * 86_400_000).toISOString(),
  },
];
