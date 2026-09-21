"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";

const BG     = "#13152a";
const BORDER = "#1e2235";
const HOVER  = "#1e2235";

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

interface Props {
  value: string;        // "YYYY-MM-DD" or ""
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}

interface InlineCalendarProps {
  value: string;                      // "YYYY-MM-DD" or ""
  onChange: (v: string) => void;
  max?: string;                       // "YYYY-MM-DD" — dates after this are disabled
  showFooter?: boolean;
  onClear?: () => void;
}

/**
 * The calendar grid on its own, with no trigger button or popover.
 *
 * Exists so the same dark themed calendar can be dropped inside an existing
 * dropdown (see the attendance header) instead of falling back to a native
 * <input type="date">. The native control renders the operating system's own
 * picker — a white, unstyleable panel that ignores the app theme entirely,
 * which is why that one control looked like it belonged to a different
 * product. Nothing about it is themeable, so the only real fix is not to use it.
 */
export function InlineCalendar({ value, onChange, max, showFooter = true, onClear }: InlineCalendarProps) {
  const [viewYear, setViewYear]   = useState(() => value ? parseInt(value.slice(0,4)) : new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => value ? parseInt(value.slice(5,7)) - 1 : new Date().getMonth());

  // Follow the selection when it changes from outside (e.g. a "Yesterday"
  // shortcut) so the grid isn't left showing an unrelated month.
  useEffect(() => {
    if (!value) return;
    setViewYear(parseInt(value.slice(0, 4)));
    setViewMonth(parseInt(value.slice(5, 7)) - 1);
  }, [value]);

  const firstDay    = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrev  = new Date(viewYear, viewMonth, 0).getDate();

  const cells: { day: number; month: "prev" | "curr" | "next" }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, month: "prev" });
  for (let d = 1; d <= daysInMonth; d++)  cells.push({ day: d, month: "curr" });
  // Compute the shortfall ONCE. Testing `d <= 42 - cells.length` inside the
  // loop re-evaluates the bound as the array grows, so it meets itself
  // halfway and the grid comes up short — a ragged bottom row on every month.
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) cells.push({ day: d, month: "next" });

  const today    = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;

  const cellDate = (cell: { day: number; month: "prev" | "curr" | "next" }) => {
    let y = viewYear, m = viewMonth;
    if (cell.month === "prev") { m--; if (m < 0) { m = 11; y--; } }
    if (cell.month === "next") { m++; if (m > 11) { m = 0; y++; } }
    return `${y}-${String(m+1).padStart(2,"0")}-${String(cell.day).padStart(2,"0")}`;
  };

  const prevMonth = () => { let m = viewMonth - 1, y = viewYear; if (m < 0) { m = 11; y--; } setViewMonth(m); setViewYear(y); };
  const nextMonth = () => { let m = viewMonth + 1, y = viewYear; if (m > 11) { m = 0; y++; } setViewMonth(m); setViewYear(y); };

  return (
    <div>
      {/* Month/year nav */}
      <div className="flex items-center justify-between px-3 py-2.5" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <button type="button" onClick={prevMonth}
          className="p-1 rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition-colors">
          <ChevronLeft size={15} />
        </button>
        <span className="text-xs font-semibold text-white">{MONTHS[viewMonth]} {viewYear}</span>
        <button type="button" onClick={nextMonth}
          className="p-1 rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition-colors">
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 px-2 pt-2.5 pb-1">
        {DAYS.map((d, i) => (
          <div key={d} className="text-center text-[10px] font-medium pb-1"
            style={{ color: i === 0 || i === 6 ? "#6366f1" : "#6b7280" }}>{d}</div>
        ))}
      </div>

      {/* Date grid */}
      <div className="grid grid-cols-7 px-2 pb-2 gap-y-0.5">
        {cells.map((cell, i) => {
          const str        = cellDate(cell);
          const isSelected = str === value;
          const isToday    = str === todayStr;
          const isCurr     = cell.month === "curr";
          const isWeekend  = i % 7 === 0 || i % 7 === 6;
          const disabled   = Boolean(max && str > max);

          return (
            <button key={i} type="button" disabled={disabled}
              onClick={() => onChange(str)}
              className="flex items-center justify-center rounded-lg text-xs h-7 transition-colors"
              style={{
                background: isSelected ? "#6366f1" : isToday ? "#1e2235" : "transparent",
                color: disabled ? "#2a2f45"
                  : isSelected ? "#fff"
                  : !isCurr ? "#374151"
                  : isWeekend ? "#818cf8"
                  : "#e5e7eb",
                fontWeight: isSelected || isToday ? 600 : 400,
                border: isToday && !isSelected ? "1px solid #374151" : "1px solid transparent",
                cursor: disabled ? "not-allowed" : "pointer",
              }}
              onMouseEnter={(e) => { if (!isSelected && !disabled) (e.currentTarget as HTMLElement).style.background = HOVER; }}
              onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = isToday ? "#1e2235" : "transparent"; }}>
              {cell.day}
            </button>
          );
        })}
      </div>

      {showFooter && (
        <div className="px-3 pb-2.5 flex justify-between items-center"
          style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
          <button type="button"
            onClick={() => { onClear ? onClear() : onChange(""); }}
            className="text-xs px-2.5 py-1 rounded-lg text-gray-400 hover:text-white transition-colors"
            style={{ background: "#1e2235" }}>
            Clear
          </button>
          <button type="button"
            onClick={() => { const t = new Date(); setViewYear(t.getFullYear()); setViewMonth(t.getMonth()); }}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            Today
          </button>
        </div>
      )}
    </div>
  );
}

export function DatePicker({ value, onChange, placeholder = "Pick date", label }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({
        top:  r.bottom + 6,
        left: Math.min(r.left, window.innerWidth - 280),
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const display = value
    ? new Date(value + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : placeholder;

  return (
    <>
      <button ref={triggerRef} type="button"
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors"
        style={{
          background: BG, border: `1px solid ${open ? "#6366f1" : BORDER}`,
          color: value ? "#e5e7eb" : "#6b7280",
          minWidth: 140,
        }}>
        <Calendar size={12} style={{ color: "#6b7280", flexShrink: 0 }} />
        <span className="flex-1 text-left">{display}</span>
        {value && (
          <span
            onClick={(e) => { e.stopPropagation(); onChange(""); }}
            className="text-gray-600 hover:text-white ml-1 cursor-pointer leading-none">×</span>
        )}
      </button>

      {open && typeof window !== "undefined" && createPortal(
        <div className="fixed z-[9999] rounded-2xl shadow-2xl overflow-hidden"
          style={{ top: pos.top, left: pos.left, width: 272, background: "#0d0f1c", border: `1px solid #2d3148` }}
          onMouseDown={(e) => e.stopPropagation()}>
          <InlineCalendar
            value={value}
            onChange={(v) => { onChange(v); setOpen(false); }}
            onClear={() => { onChange(""); setOpen(false); }}
          />
        </div>,
        document.body
      )}
    </>
  );
}
