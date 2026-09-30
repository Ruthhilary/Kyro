"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AlertTriangle, X, Bell, ChevronDown, ChevronUp, Eye, GripVertical } from "lucide-react";
import { recordDemoAnswer } from "@/lib/demo";
import { inDemoMode } from "@/lib/liveMode";
import { ZoomableImage } from "@/components/ui/ZoomableImage";
import type { ReviewRequest } from "@/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const UNANSWERED_KEY = "kyro_unanswered_reviews";

const TYPE_ICONS: Record<string, string> = {
  stage_question:       "🎤",
  front_rush_question:  "🏃",
  absence_question:     "⏱",
  zone_proposal:        "📍",
  altar_call_question:  "✝️",
};

const TYPE_COLOURS: Record<string, { border: string; badge: string; text: string }> = {
  stage_question:       { border: "#6366f1", badge: "#312e81", text: "#a5b4fc" },
  front_rush_question:  { border: "#f59e0b", badge: "#78350f", text: "#fde68a" },
  absence_question:     { border: "#10b981", badge: "#064e3b", text: "#6ee7b7" },
  zone_proposal:        { border: "#8b5cf6", badge: "#4c1d95", text: "#c4b5fd" },
  altar_call_question:  { border: "#f59e0b", badge: "#7c2d12", text: "#fed7aa" },
};

// ─── Desktop push notification for new AI question ───────────────────────────
function fireDesktopNotification(review: ReviewRequest) {
  if (typeof window === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const icon = TYPE_ICONS[review.review_type] ?? "❓";
    new Notification(`${icon} Kyro needs your input`, {
      body: review.question,
      tag: `kyro-review-${review.review_id}`,
      icon: "/kyro-icon.png",
      requireInteraction: true, // stays until dismissed
    });
  } catch {}
}

// ─── Unanswered storage helpers ───────────────────────────────────────────────
function loadUnanswered(): ReviewRequest[] {
  if (typeof window === "undefined") return [];
  try {
    const all = JSON.parse(localStorage.getItem(UNANSWERED_KEY) ?? "[]") as ReviewRequest[];
    // Auto-prune questions older than 24 hours — they stay all day, gone tomorrow
    const cutoff = Date.now() / 1000 - 24 * 3600;
    const fresh = all.filter((r) => r.created_at > cutoff).slice(0, 10);
    if (fresh.length !== all.length) saveUnanswered(fresh);
    return fresh;
  } catch { return []; }
}

function saveUnanswered(reviews: ReviewRequest[]) {
  try { localStorage.setItem(UNANSWERED_KEY, JSON.stringify(reviews)); } catch {}
}

function addUnanswered(review: ReviewRequest) {
  const existing = loadUnanswered();
  if (existing.find((r) => r.review_id === review.review_id)) return;
  // Cap at 10 unanswered — oldest drop off so the list stays manageable
  const updated = [review, ...existing].slice(0, 10);
  saveUnanswered(updated);
  window.dispatchEvent(new Event("kyro_unanswered_changed"));
}

function removeUnanswered(reviewId: string) {
  saveUnanswered(loadUnanswered().filter((r) => r.review_id !== reviewId));
  window.dispatchEvent(new Event("kyro_unanswered_changed"));
}

// ─── Archived (dismissed-not-deleted) storage ────────────────────────────────
// When the user hits "X" on the unanswered panel we USED to delete every
// question permanently. Now we move them here instead, and a small floating
// bell lets the user restore them later. Same TTL / cap as unanswered so
// this doesn't grow forever.
const ARCHIVED_KEY = "kyro_archived_reviews";

function loadArchived(): ReviewRequest[] {
  if (typeof window === "undefined") return [];
  try {
    const all = JSON.parse(localStorage.getItem(ARCHIVED_KEY) ?? "[]") as ReviewRequest[];
    const cutoff = Date.now() / 1000 - 24 * 3600;
    const fresh  = all.filter((r) => r.created_at > cutoff).slice(0, 20);
    if (fresh.length !== all.length) {
      try { localStorage.setItem(ARCHIVED_KEY, JSON.stringify(fresh)); } catch {}
    }
    return fresh;
  } catch { return []; }
}

function saveArchived(reviews: ReviewRequest[]) {
  try { localStorage.setItem(ARCHIVED_KEY, JSON.stringify(reviews)); } catch {}
  window.dispatchEvent(new Event("kyro_archived_changed"));
}

function archiveUnanswered(all: ReviewRequest[]) {
  // Merge with existing archive, de-duped by review_id, cap at 20.
  const existing = loadArchived();
  const seen     = new Set(existing.map((r) => r.review_id));
  const merged   = [...all.filter((r) => !seen.has(r.review_id)), ...existing].slice(0, 20);
  saveArchived(merged);
}

function restoreAllArchived() {
  const archived  = loadArchived();
  if (archived.length === 0) return;
  const current   = loadUnanswered();
  const seen      = new Set(current.map((r) => r.review_id));
  const merged    = [...archived.filter((r) => !seen.has(r.review_id)), ...current].slice(0, 10);
  saveUnanswered(merged);
  saveArchived([]);
  window.dispatchEvent(new Event("kyro_unanswered_changed"));
}

// ─── Demo snapshot ────────────────────────────────────────────────────────────
function DemoSnapshot({ review }: { review: ReviewRequest }) {
  const [cx, cy] = review.position ?? [200, 150];
  const nx = Math.round((cx / 1280) * 320);
  const ny = Math.round((cy / 720)  * 180);
  return (
    <div className="relative w-full overflow-hidden rounded-lg" style={{ background: "var(--bg-inset)", border: "1px solid var(--border-strong)" }}>
      <svg viewBox="0 0 320 180" className="w-full" style={{ maxHeight: 140 }}>
        <rect width="320" height="180" fill="var(--bg-base)" />
        {[60, 80, 100, 120, 140].map((y, i) => (
          <rect key={i} x="20" y={y} width="280" height="10" rx="2" fill="var(--border-subtle)" opacity="0.7" />
        ))}
        <rect x="60" y="10" width="200" height="20" rx="4" fill="var(--bg-hover)" stroke="var(--border-strong)" strokeWidth="1" />
        <text x="160" y="24" textAnchor="middle" fontSize="8" fill="#4b5563" fontFamily="sans-serif" letterSpacing="2">STAGE</text>
        <circle cx={nx} cy={ny} r="10" fill="#6366f1" opacity="0.9" />
        <rect x={nx - 6} y={ny + 10} width="12" height="16" rx="3" fill="#6366f1" opacity="0.9" />
        <circle cx={nx} cy={ny + 8} r="22" fill="none" stroke="#6366f1" strokeWidth="2" opacity="0.8">
          <animate attributeName="r" values="22;28;22" dur="1.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.8;0.2;0.8" dur="1.5s" repeatCount="indefinite" />
        </circle>
        <rect x="4" y="4" width="70" height="14" rx="3" fill="var(--bg-card)" opacity="0.9" />
        <text x="8" y="14" fontSize="8" fill="#a5b4fc" fontFamily="sans-serif">Kyro flagged ↑</text>
      </svg>
      <div className="absolute bottom-1.5 right-2 text-xs" style={{ color: "#4b5563" }}>Demo view</div>
    </div>
  );
}

function LiveSnapshot({ cameraId, reviewId }: { cameraId: string; reviewId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSnap = useCallback(async () => {
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("kyro_token") ?? "" : "";
      const res = await fetch(`${API_URL}/api/v1/review/${cameraId}/snapshot/${reviewId}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      if (res.ok) {
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        setSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      }
    } catch {}
    finally { setLoading(false); }
  }, [cameraId, reviewId]);

  useEffect(() => {
    fetchSnap();
    intervalRef.current = setInterval(fetchSnap, 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchSnap]);

  if (loading) return (
    <div className="w-full h-24 rounded-lg flex items-center justify-center" style={{ background: "var(--bg-inset)", border: "1px solid var(--border-strong)" }}>
      <span className="text-xs" style={{ color: "#4b5563" }}>Loading snapshot…</span>
    </div>
  );
  if (!src) return null;
  return (
    <ZoomableImage
      src={src}
      alt="Kyro flagged area"
      maxHeight={160}
      badge={<><Eye size={9} /> Live</>}
    />
  );
}

// ─── Answer map ───────────────────────────────────────────────────────────────
const ANSWER_MAP: Record<string, string> = {
  "Yes, it's the stage":                        "yes",
  "Yes, it's the stage/altar":                  "yes",
  "No, it's the front area":                    "no",
  "No — toilet break":                          "toilet",
  "No — they left the building":                "left",
  "No — they left":                             "left",
  "Create a zone here":                         "create_zone",
  "Ignore this":                                "ignore",
  "Ignore":                                     "ignore",
  "Yes, altar/stage call":                      "yes",
  "No, just coincidence":                       "no",
  "Pastor arrived at front":                    "yes",
  "Toilet / short break":                       "toilet",
  "Went on stage":                              "stage",
  "Left the building":                          "left",
  "Still in seat (ignore)":                     "ignore",
  "Yes — gave their life to Christ ✝":          "gave_life",
  "Yes — gave their life to Christ":            "gave_life",
  "No — went to the toilet":                    "toilet",
  "No — left the building":                     "left",
  "Still here (ignore)":                        "ignore",
  "Yes — free the seat":                        "left",
  "No — they're coming back":                   "toilet",
  "They went on stage":                         "stage",
  "Yes — same person back":                     "ignore",
  "No — different person":                      "no",
  "Not sure (keep as occupied)":                "ignore",
  "Yes — count looks right":                    "yes",
  "No — higher than shown":                     "no",
  "No — lower than shown":                      "no",
  "Finding seats — hold":                       "ignore",
  "Worship / standing prayer":                  "stage",
  "Leaving the section":                        "left",
  "Yes — mark it free":                         "left",
  "No — still occupied":                        "ignore",
  "Toilet break — keep hold":                   "toilet",
};

// ─── Single review card (ONE at a time) ──────────────────────────────────────
function ReviewCard({
  review,
  cameraId,
  onDismiss,
  onTimeout,
}: {
  review: ReviewRequest;
  cameraId: string;
  onDismiss: () => void;
  onTimeout: (r: ReviewRequest) => void;
}) {
  const [answering, setAnswering] = useState(false);
  const [timeLeft, setTimeLeft]   = useState(90); // 90 seconds to answer
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const colours = TYPE_COLOURS[review.review_type] ?? TYPE_COLOURS.absence_question;
  const icon    = TYPE_ICONS[review.review_type] ?? "❓";

  // Fire desktop notification when card appears
  useEffect(() => { fireDesktopNotification(review); }, [review.review_id]);

  useEffect(() => {
    const startedAt = review.created_at * 1000;
    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const left    = Math.max(0, 90 - Math.floor(elapsed));
      setTimeLeft(left);
      if (left === 0) {
        clearInterval(timerRef.current!);
        onTimeout(review); // save to unanswered instead of silently dropping
        onDismiss();
      }
    }, 1000);
    return () => clearInterval(timerRef.current!);
  }, [review.review_id]);

  async function answer(option: string) {
    const answerCode = ANSWER_MAP[option] ?? option.toLowerCase().split(" ")[0];
    setAnswering(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("kyro_token") ?? "" : "";
      if (!token.includes("demo_signature")) {
        await fetch(`${API_URL}/api/v1/review/${cameraId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ review_id: review.review_id, answer: answerCode }),
        });
      }
      // Store the answer so the AI doesn't repeat this question (demo + real)
      recordDemoAnswer(review.review_id, review.question, answerCode);
      removeUnanswered(review.review_id);
    } catch (e) { console.error("Review answer failed", e); }
    onDismiss();
  }

  const pct = (timeLeft / 90) * 100;

  return (
    <div className="w-80 rounded-xl shadow-2xl overflow-hidden"
      style={{ background: "var(--bg-card)", border: `1px solid ${colours.border}` }}>
      <div className="h-0.5 w-full" style={{ background: "var(--border-subtle)" }}>
        <div className="h-full transition-all duration-1000"
          style={{ width: `${pct}%`, background: colours.border }} />
      </div>
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <span className="text-xl mt-0.5">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: colours.badge, color: colours.text }}>Kyro needs input</span>
            <span className="text-xs ml-auto tabular-nums" style={{ color: timeLeft < 20 ? "#f87171" : "#6b7280" }}>{timeLeft}s</span>
          </div>
          <p className="text-sm font-medium text-white leading-snug">{review.question}</p>
          {review.seat_id && (
            <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>Seat {review.seat_id}</p>
          )}
          <p className="text-xs mt-1 flex items-center gap-1" style={{ color: "#f59e0b" }}>
            <AlertTriangle size={10} />
            Your answer trains the AI — it won't ask again for this
          </p>
        </div>
        <button onClick={() => { onTimeout(review); onDismiss(); }}
          className="text-gray-600 hover:text-gray-400 shrink-0 mt-0.5" title="Skip for now">
          <X size={14} />
        </button>
      </div>
      <div className="px-4 pb-2">
        {inDemoMode() ? <DemoSnapshot review={review} /> : <LiveSnapshot cameraId={cameraId} reviewId={review.review_id} />}
      </div>
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        {review.options.map((opt) => (
          <button key={opt} onClick={() => answer(opt)} disabled={answering}
            className="w-full text-left px-3 py-2 rounded-lg text-sm transition-all disabled:opacity-50"
            style={{ background: "var(--border-subtle)", color: "#d1d5db" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = colours.badge;
              (e.currentTarget as HTMLButtonElement).style.color = colours.text;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--border-subtle)";
              (e.currentTarget as HTMLButtonElement).style.color = "#d1d5db";
            }}>{opt}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Unanswered backlog panel ─────────────────────────────────────────────────
// Draggable position — stored in localStorage so it survives refreshes and
// respects wherever the user put it last (default puts it in the bottom-right,
// clear of the sidebar's Sign-out button on the bottom-left).
const POSITION_KEY = "kyro_unanswered_position";
const PANEL_WIDTH  = 320;
const PANEL_ESTIMATED_HEIGHT = 320;   // rough — used only for default placement

interface PanelPos { x: number; y: number; }

function loadPosition(): PanelPos | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === "number" && typeof p?.y === "number") return p;
  } catch {}
  return null;
}

function savePosition(p: PanelPos): void {
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(p)); } catch {}
}

/** Keep the panel fully on-screen so a resize can't hide it. */
function clampToViewport(p: PanelPos): PanelPos {
  if (typeof window === "undefined") return p;
  const maxX = Math.max(8, window.innerWidth  - PANEL_WIDTH - 8);
  const maxY = Math.max(8, window.innerHeight - 80 - 8);   // 80 = header alone
  return { x: Math.max(8, Math.min(p.x, maxX)), y: Math.max(8, Math.min(p.y, maxY)) };
}

function UnansweredPanel({ cameraId }: { cameraId: string }) {
  const [items, setItems]         = useState<ReviewRequest[]>([]);
  const [open, setOpen]           = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answered, setAnswered]   = useState<string | null>(null); // brief success flash
  const [position, setPosition]   = useState<PanelPos | null>(null);
  const [dragging, setDragging]   = useState(false);
  const dragOffsetRef             = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  useEffect(() => {
    const read = () => setItems(loadUnanswered());
    read();
    window.addEventListener("kyro_unanswered_changed", read);
    return () => window.removeEventListener("kyro_unanswered_changed", read);
  }, []);

  // Focus a specific review when the page is opened from a push notification
  // deep-link (/seating?review=<id>). Dispatched by the seating page after
  // it parses the URL params.
  useEffect(() => {
    function onFocus(e: Event) {
      const id = (e as CustomEvent).detail?.reviewId as string | undefined;
      if (!id) return;
      // Reload in case the target review was just persisted by pipeline events
      const fresh = loadUnanswered();
      setItems(fresh);
      if (fresh.some((r) => r.review_id === id)) {
        setOpen(true);
        setExpandedId(id);
      }
    }
    window.addEventListener("kyro_focus_review", onFocus);
    return () => window.removeEventListener("kyro_focus_review", onFocus);
  }, []);

  // Initialise + clamp position on mount and window resize.
  useEffect(() => {
    function initOrClamp() {
      const saved = loadPosition();
      const fallback: PanelPos = {
        // Default: bottom-RIGHT (was bottom-left, which blocked Sign out
        // in the sidebar). 24 = ~1.5rem breathing room.
        x: Math.max(8, window.innerWidth  - PANEL_WIDTH - 24),
        y: Math.max(8, window.innerHeight - PANEL_ESTIMATED_HEIGHT - 24),
      };
      setPosition(clampToViewport(saved ?? fallback));
    }
    initOrClamp();
    window.addEventListener("resize", initOrClamp);
    return () => window.removeEventListener("resize", initOrClamp);
  }, []);

  // Drag handlers — support mouse and touch so this works on phone + iPad.
  const onDragStart = useCallback((clientX: number, clientY: number) => {
    if (!position) return;
    dragOffsetRef.current = { dx: clientX - position.x, dy: clientY - position.y };
    setDragging(true);
  }, [position]);

  useEffect(() => {
    if (!dragging) return;
    function move(clientX: number, clientY: number) {
      const next = clampToViewport({
        x: clientX - dragOffsetRef.current.dx,
        y: clientY - dragOffsetRef.current.dy,
      });
      setPosition(next);
    }
    const onMouseMove = (e: MouseEvent) => { e.preventDefault(); move(e.clientX, e.clientY); };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      e.preventDefault();
      move(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onEnd = () => {
      setDragging(false);
      if (position) savePosition(position);
    };
    window.addEventListener("mousemove",  onMouseMove);
    window.addEventListener("mouseup",    onEnd);
    window.addEventListener("touchmove",  onTouchMove, { passive: false });
    window.addEventListener("touchend",   onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("mousemove",  onMouseMove);
      window.removeEventListener("mouseup",    onEnd);
      window.removeEventListener("touchmove",  onTouchMove);
      window.removeEventListener("touchend",   onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [dragging, position]);

  async function answer(review: ReviewRequest, option: string) {
    const answerCode = ANSWER_MAP[option] ?? option.toLowerCase().split(" ")[0];
    setAnswering(review.review_id);
    try {
      const token = localStorage.getItem("kyro_token") ?? "";
      if (!token.includes("demo_signature")) {
        await fetch(`${API_URL}/api/v1/review/${cameraId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ review_id: review.review_id, answer: answerCode }),
        });
      }
      // Record the answer — AI won't repeat spatial/learned questions
      recordDemoAnswer(review.review_id, review.question, answerCode);
    } catch {}
    setAnswered(review.review_id);
    setTimeout(() => {
      removeUnanswered(review.review_id);
      setAnswering(null);
      setAnswered(null);
      setExpandedId(null);
    }, 500);
  }

  if (items.length === 0) return null;
  if (!position) return null;  // waiting for mount to compute the default

  return (
    <div
      className="fixed z-40"
      style={{
        left: position.x,
        top:  position.y,
        width: PANEL_WIDTH,
        // While dragging, disable the transition so movement tracks the pointer
        // exactly; snap back once released.
        transition: dragging ? "none" : "left 120ms ease, top 120ms ease",
        userSelect: dragging ? "none" : "auto",
      }}
    >
      {/* Header — the drag handle. Grab the grip icon (or anywhere else that
         isn't the collapse or clear button) to move the panel. */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
        style={{
          background: "var(--bg-card)",
          border: "1px solid rgba(245,158,11,0.4)",
          cursor: dragging ? "grabbing" : "grab",
        }}
        onMouseDown={(e) => {
          // Ignore drags that start on the collapse toggle or clear button
          if ((e.target as HTMLElement).closest("button")) return;
          onDragStart(e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.touches.length === 0) return;
          onDragStart(e.touches[0].clientX, e.touches[0].clientY);
        }}
        aria-label="Drag to reposition"
      >
        <GripVertical size={14} className="text-amber-400/60 shrink-0" />
        <Bell size={14} className="text-amber-400 shrink-0" />
        <button
          onClick={(e) => { e.stopPropagation(); setOpen((p) => !p); }}
          className="flex items-center gap-2 flex-1 text-sm font-medium text-left"
          style={{ color: "#fde68a" }}
        >
          <span className="flex-1">{items.length} unanswered question{items.length !== 1 ? "s" : ""}</span>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            // Archive instead of delete — the questions stay recoverable via
            // the floating bell in the top-right until they expire (24h) or
            // are individually answered.
            archiveUnanswered(items);
            saveUnanswered([]);
            setItems([]);
            setOpen(false);
            window.dispatchEvent(new Event("kyro_unanswered_changed"));
          }}
          className="text-gray-600 hover:text-amber-400 transition-colors shrink-0"
          title="Hide all — you can bring them back from the bell icon"
        >
          <X size={13} />
        </button>
      </div>

      {open && (
        <div className="mt-2 flex flex-col gap-1.5 overflow-y-auto"
          style={{ maxHeight: "60vh" }}>
          {items.map((r) => {
            const colours   = TYPE_COLOURS[r.review_type] ?? TYPE_COLOURS.absence_question;
            const icon      = TYPE_ICONS[r.review_type] ?? "❓";
            const ago       = Math.round((Date.now() / 1000 - r.created_at) / 60);
            const isExpanded = expandedId === r.review_id;
            const isAnswered = answered === r.review_id;

            return (
              <div key={r.review_id} className="rounded-xl overflow-hidden transition-all"
                style={{ background: isExpanded ? "var(--bg-card)" : "var(--bg-card)",
                         border: `1px solid ${isExpanded ? colours.border : colours.border + "40"}` }}>

                {/* Collapsed row — tap to expand */}
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
                  onClick={() => setExpandedId(isExpanded ? null : r.review_id)}>
                  <span className="text-sm shrink-0">{icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white leading-snug truncate">{r.question}</p>
                    <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
                      {ago > 0 ? `${ago} min ago` : "just now"}
                      {!isExpanded && <span style={{ color: colours.text }}> · tap to answer</span>}
                    </p>
                  </div>
                  {isAnswered ? (
                    <span className="text-xs text-green-400 shrink-0">✓</span>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      {isExpanded
                        ? <ChevronUp size={12} className="text-gray-500" />
                        : <ChevronDown size={12} className="text-gray-500" />}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeUnanswered(r.review_id); }}
                        className="text-gray-700 hover:text-red-400 transition-colors ml-0.5">
                        <X size={11} />
                      </button>
                    </div>
                  )}
                </button>

                {/* Expanded — answer options */}
                {isExpanded && !isAnswered && (
                  <div className="px-3 pb-3 flex flex-col gap-1 border-t"
                    style={{ borderColor: colours.border + "30" }}>
                    <p className="text-xs pt-2 pb-1 leading-relaxed text-white">{r.question}</p>
                    {r.options.map((opt) => (
                      <button key={opt} onClick={() => answer(r, opt)}
                        disabled={!!answering}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-40"
                        style={{ background: "var(--border-subtle)", color: "#d1d5db" }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = colours.badge;
                          (e.currentTarget as HTMLButtonElement).style.color = colours.text;
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = "var(--border-subtle)";
                          (e.currentTarget as HTMLButtonElement).style.color = "#d1d5db";
                        }}>
                        {answering === r.review_id ? "Saving…" : opt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Small floating bell that restores archived questions ────────────────────
// Only visible when there IS an archive and the main unanswered panel is
// empty — otherwise the bell would compete with the panel it's meant to be
// an alternative to. Fixed at top-right so it doesn't collide with the
// draggable panel or the sidebar.
function ArchivedRestoreBell() {
  const [archivedCount, setArchivedCount]     = useState(0);
  const [unansweredCount, setUnansweredCount] = useState(0);

  useEffect(() => {
    const read = () => {
      setArchivedCount(loadArchived().length);
      setUnansweredCount(loadUnanswered().length);
    };
    read();
    window.addEventListener("kyro_archived_changed",  read);
    window.addEventListener("kyro_unanswered_changed", read);
    return () => {
      window.removeEventListener("kyro_archived_changed",  read);
      window.removeEventListener("kyro_unanswered_changed", read);
    };
  }, []);

  if (archivedCount === 0 || unansweredCount > 0) return null;

  return (
    <button
      onClick={restoreAllArchived}
      className="fixed z-30 flex items-center gap-2 px-3 py-2 rounded-full shadow-lg transition-transform hover:scale-105"
      style={{
        top: "1rem",
        right: "1rem",
        background: "var(--bg-card)",
        border: "1px solid rgba(245,158,11,0.5)",
        color: "#fde68a",
      }}
      title={`Bring back ${archivedCount} hidden question${archivedCount !== 1 ? "s" : ""}`}
      aria-label={`${archivedCount} hidden question${archivedCount !== 1 ? "s" : ""} — click to restore`}
    >
      <Bell size={14} className="text-amber-400" />
      <span className="text-xs font-semibold">
        {archivedCount}
      </span>
      <span
        className="absolute -top-1 -right-1 w-2 h-2 rounded-full animate-pulse"
        style={{ background: "#f59e0b" }}
      />
    </button>
  );
}

// ─── Main panel — ONE question at a time ─────────────────────────────────────
interface ReviewPanelProps {
  reviews: ReviewRequest[];
  cameraId: string;
  onDismiss: (reviewId: string) => void;
}

export function ReviewPanel({ reviews, cameraId, onDismiss }: ReviewPanelProps) {
  // Show only the FIRST question — one at a time
  const current = reviews[0] ?? null;
  const queueLen = reviews.length;

  function handleTimeout(r: ReviewRequest) {
    addUnanswered(r);
    onDismiss(r.review_id);
  }

  return (
    <>
      {/* One question at a time — bottom right */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
        {queueLen > 1 && (
          <div className="text-xs px-3 py-1.5 rounded-full"
            style={{ background: "var(--border-subtle)", color: "#9ca3af", border: "1px solid #374151" }}>
            +{queueLen - 1} more question{queueLen - 1 !== 1 ? "s" : ""} queued
          </div>
        )}
        {current && (
          <ReviewCard
            key={current.review_id}
            review={current}
            cameraId={cameraId}
            onDismiss={() => onDismiss(current.review_id)}
            onTimeout={handleTimeout}
          />
        )}
      </div>

      {/* Unanswered backlog — draggable, persists across refreshes */}
      <UnansweredPanel cameraId={cameraId} />

      {/* Top-right bell — appears when the backlog is empty but archived
         (X'd) questions still exist. Click restores them all. */}
      <ArchivedRestoreBell />
    </>
  );
}
