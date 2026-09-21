"use client";

import { useState } from "react";
import { MapPin, ChevronDown, ChevronUp, Check } from "lucide-react";
import type { SectionInfo } from "@/lib/rotaParser";

const BORDER = "#1e2235";

export interface SeatingAnswer {
  section: string | null;
  rows: string[];
}

interface Props {
  label: string;
  sections: SectionInfo[];
  value: SeatingAnswer;
  resolved: boolean;
  onChange: (v: SeatingAnswer) => void;
  onSkip: () => void;
}

/**
 * Asks the one question Kyro couldn't answer from the photo alone:
 * "where does this entry sit?" — with a dropdown of known seating areas
 * and an optional visual chart to click rows directly, so the user can
 * show Kyro exactly where and save it, no typing required.
 */
export function SeatingAreaPicker({ label, sections, value, resolved, onChange, onSkip }: Props) {
  const [showChart, setShowChart] = useState(false);

  function pickSection(name: string) {
    onChange({ section: name || null, rows: [] });
  }

  function toggleRow(section: string, row: string) {
    const sameSection = value.section === section;
    const current = sameSection ? value.rows : [];
    const rows = current.includes(row) ? current.filter((r) => r !== row) : [...current, row];
    onChange({ section, rows });
  }

  return (
    <div
      className="rounded-lg px-3 py-3 flex flex-col gap-2"
      style={{
        background: resolved ? "rgba(16,185,129,0.06)" : "rgba(245,158,11,0.07)",
        border: `1px solid ${resolved ? "rgba(16,185,129,0.25)" : "rgba(245,158,11,0.25)"}`,
      }}
    >
      <div className="flex items-start gap-2">
        <MapPin size={13} className={resolved ? "text-emerald-400" : "text-amber-400"} style={{ marginTop: 2 }} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium" style={{ color: resolved ? "#6ee7b7" : "#fde68a" }}>
            Which seating area is &ldquo;{label || "this entry"}&rdquo; in?
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            Kyro couldn&apos;t read that from the photo — without it, it may mistake them going
            to the front for an altar call response.
          </p>
        </div>
      </div>

      {sections.length > 0 ? (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={value.section ?? ""}
            onChange={(e) => pickSection(e.target.value)}
            className="bg-gray-900 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Choose a seating area…</option>
            {sections.map((s) => (
              <option key={s.section} value={s.section}>{s.section}</option>
            ))}
          </select>
          <button
            onClick={() => setShowChart((p) => !p)}
            className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
          >
            {showChart ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {showChart ? "Hide seating chart" : "Show seating chart"}
          </button>
          <button onClick={onSkip} className="text-xs text-gray-500 hover:text-gray-300 ml-auto">
            No fixed seat
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            placeholder="Type the seating area, e.g. Choir"
            value={value.section ?? ""}
            onChange={(e) => onChange({ section: e.target.value || null, rows: value.rows })}
            className="bg-gray-900 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5 flex-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button onClick={onSkip} className="text-xs text-gray-500 hover:text-gray-300 shrink-0">
            No fixed seat
          </button>
        </div>
      )}

      {showChart && sections.length > 0 && (
        <div className="rounded-lg p-3 flex flex-col gap-2" style={{ background: "#0a0c18", border: `1px solid ${BORDER}` }}>
          <p className="text-xs text-gray-600 mb-1">Tap the rows this group sits in</p>
          {sections.map((s) => (
            <div key={s.section} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-gray-500 w-24 shrink-0 truncate">{s.section}</span>
              {s.rows.map((r) => {
                const active = value.section === s.section && value.rows.includes(r);
                return (
                  <button
                    key={r}
                    onClick={() => toggleRow(s.section, r)}
                    className="w-7 h-7 rounded text-xs font-medium transition-colors shrink-0"
                    style={{
                      background: active ? "#4f46e5" : "#141830",
                      color: active ? "#fff" : "#9ca3af",
                      border: `1px solid ${active ? "#6366f1" : BORDER}`,
                    }}
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {resolved && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-400">
          <Check size={12} /> Got it — saved to this entry.
        </div>
      )}
    </div>
  );
}
