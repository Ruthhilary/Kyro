"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { CalendarClock } from "lucide-react";
import { InlineCalendar } from "./DatePicker";

const BG     = "#13152a";
const BORDER = "#1e2235";

interface Props {
  /** "YYYY-MM-DDTHH:MM" (seconds are ignored if present). */
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

/** Split "2026-09-15T14:30[:00]" into ["2026-09-15", "14:30"]. */
function split(value: string): [string, string] {
  if (!value) return ["", ""];
  const [d, t = ""] = value.split("T");
  return [d ?? "", t.slice(0, 5)];
}

const QUICK_TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "18:00", "18:30", "19:00"];

/**
 * Date + time picker matching the app theme.
 *
 * Replaces <input type="datetime-local">, which renders the operating system's
 * own picker — a white panel that ignores the app's styling entirely and can't
 * be reached with CSS. The calendar half is the shared InlineCalendar, so this
 * stays visually identical to every other date control in the product.
 *
 * Time is a plain text field rather than a dropdown of fixed slots: rota entries
 * land on arbitrary minutes ("choir back to seat by 10:47"), so a fixed list
 * would quietly prevent valid input. The quick-pick row covers the common cases
 * without closing off the uncommon ones.
 */
export function DateTimePicker({ value, onChange, placeholder = "Pick date & time" }: Props) {
  const [open, setOpen] = useState(false);
  const [datePart, timePart] = split(value);
  // Local buffer so a half-typed time ("1", "14:") doesn't get written back as
  // an invalid value on every keystroke.
  const [timeDraft, setTimeDraft] = useState(timePart || "");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef   = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => { setTimeDraft(timePart || ""); }, [timePart]);

  useEffect(() => {
    if (open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const width = 272;
      setPos({
        // Flip above the trigger when there isn't room below, so the panel
        // isn't clipped for entries near the bottom of a long rota list.
        top:  r.bottom + 340 > window.innerHeight ? Math.max(8, r.top - 348) : r.bottom + 6,
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const commit = (date: string, time: string) => {
    if (!date) return;
    onChange(`${date}T${time || "00:00"}`);
  };

  const commitTimeDraft = () => {
    // Accept "9", "930", "9:30", "09:30" — normalise or fall back to the last
    // known-good value rather than writing something unparseable.
    const raw = timeDraft.trim();
    const m = raw.match(/^(\d{1,2})[:.]?(\d{2})?$/);
    if (!m) { setTimeDraft(timePart || ""); return; }
    let h = Math.min(23, parseInt(m[1], 10));
    let mi = Math.min(59, parseInt(m[2] ?? "0", 10));
    const norm = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
    setTimeDraft(norm);
    commit(datePart || new Date().toISOString().slice(0, 10), norm);
  };

  const display = datePart
    ? `${new Date(datePart + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · ${timePart || "00:00"}`
    : placeholder;

  return (
    <>
      <button ref={triggerRef} type="button"
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors w-full"
        style={{
          background: BG,
          border: `1px solid ${open ? "#6366f1" : BORDER}`,
          color: datePart ? "#e5e7eb" : "#6b7280",
        }}>
        <CalendarClock size={12} style={{ color: "#6b7280", flexShrink: 0 }} />
        <span className="flex-1 text-left">{display}</span>
      </button>

      {open && typeof window !== "undefined" && createPortal(
        <div ref={panelRef}
          className="fixed z-[9999] rounded-2xl shadow-2xl overflow-hidden"
          style={{ top: pos.top, left: pos.left, width: 272, background: "#0d0f1c", border: "1px solid #2d3148" }}>

          <InlineCalendar
            value={datePart}
            showFooter={false}
            onChange={(v) => commit(v, timeDraft || timePart || "00:00")}
          />

          <div className="px-3 py-2.5" style={{ borderTop: `1px solid ${BORDER}` }}>
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 10, color: "#6b7280" }}>Time</span>
              <input
                value={timeDraft}
                onChange={(e) => setTimeDraft(e.target.value)}
                onBlur={commitTimeDraft}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitTimeDraft(); setOpen(false); }
                  if (e.key === "Escape") setOpen(false);
                }}
                placeholder="HH:MM"
                className="flex-1 rounded-lg px-2 py-1 text-xs focus:outline-none"
                style={{ background: "#141830", border: `1px solid ${BORDER}`, color: "#e5e7eb" }} />
            </div>

            <div className="flex flex-wrap gap-1 mt-2">
              {QUICK_TIMES.map((t) => (
                <button key={t} type="button"
                  onClick={() => {
                    setTimeDraft(t);
                    commit(datePart || new Date().toISOString().slice(0, 10), t);
                  }}
                  className="rounded-md px-1.5 py-0.5 transition-colors"
                  style={{
                    fontSize: 10,
                    background: t === (timeDraft || timePart) ? "#6366f1" : "#1e2235",
                    color: t === (timeDraft || timePart) ? "#fff" : "#9ca3af",
                  }}>
                  {t}
                </button>
              ))}
            </div>

            <div className="flex justify-end mt-2">
              <button type="button"
                onClick={() => { commitTimeDraft(); setOpen(false); }}
                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
