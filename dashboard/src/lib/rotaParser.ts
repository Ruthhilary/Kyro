/**
 * Kyro — Free, offline rota-photo parser.
 *
 * Turns OCR text (read entirely in the browser by tesseract.js — no API key,
 * no server round-trip, no cost) into structured rota entries.
 *
 * It also cross-references each entry against the venue's known seating
 * sections/rows (passed in as `sections`) so it can auto-fill the seating
 * area when the photo makes it obvious, and flag — via `needsSeatingAnswer`
 * — only the entries that are genuinely ambiguous, for the app to ask the
 * user about directly (see SeatingAreaPicker).
 */

export interface ParsedRotaEntry {
  label: string;
  start_time: string;
  end_time: string;
  rows: string[];
  seat_ids: string[];
  section: string | null;
  confidence: "high" | "medium" | "low";
  note: string | null;
}

export interface SectionInfo {
  section: string;
  rows: string[];
}

/** Words that suggest a line refers to a group appearing on stage/front,
 *  rather than a one-off note — used only to write a friendlier note. */
const GROUP_KEYWORDS = [
  "choir", "worship", "praise", "band", "team", "ushers", "usher",
  "welcome", "greeters", "youth", "kids", "children", "media", "tech",
  "sound", "dance", "drama", "intercessors", "prayer", "security",
  "hospitality", "deacons", "elders", "singers", "musicians",
];

function todayLocal(): string {
  return new Date().toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Normalise common OCR mistakes before parsing. */
function cleanOcrText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/[|]/g, "I")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/-{2,}/g, "-")
    .trim();
}

function toHM(hStr: string, mStr: string | undefined, ap: string | undefined): { h: number; m: number } | null {
  let h = parseInt(hStr, 10);
  const m = mStr ? parseInt(mStr, 10) : 0;
  if (Number.isNaN(h) || h > 23 || m > 59) return null;
  const period = (ap ?? "").toLowerCase();
  if (period === "pm" && h < 12) h += 12;
  if (period === "am" && h === 12) h = 0;
  // Rotas often write bare hours with no am/pm. Service times of 1–7 with no
  // marker are almost always afternoon slots (9,10,11,12 need no adjustment).
  if (!period && h >= 1 && h <= 7) h += 12;
  return { h, m };
}

/** Matches "10:00", "10.00", "10", optionally followed by am/pm. */
function makeTimeRegex(): RegExp {
  return /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/gi;
}

function extractTimes(line: string, date: string): string[] {
  const out: string[] = [];
  const rx = makeTimeRegex();
  let m: RegExpExecArray | null;
  while ((m = rx.exec(line)) !== null) {
    // Require either a ":"/"." separator or an am/pm suffix — otherwise a
    // bare number (bullet, verse reference, row count) gets misread as a time.
    if (!m[2] && !m[3]) continue;
    const hm = toHM(m[1], m[2], m[3]);
    if (!hm) continue;
    out.push(`${date}T${pad2(hm.h)}:${pad2(hm.m)}:00`);
  }
  return out;
}

function addMinutesIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setMinutes(d.getMinutes() + minutes);
  const y = d.getFullYear(), mo = pad2(d.getMonth() + 1), da = pad2(d.getDate());
  return `${y}-${mo}-${da}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

/** Explicit row references: "Rows A-C", "Row A, B", "row: D". */
function extractRows(line: string): string[] {
  const rows = new Set<string>();
  const rangeRx = /\brows?\s*[:\-]?\s*([A-Za-z])\s*(?:-|to|–|—)\s*([A-Za-z])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRx.exec(line)) !== null) {
    const a = m[1].toUpperCase().charCodeAt(0);
    const b = m[2].toUpperCase().charCodeAt(0);
    for (let c = Math.min(a, b); c <= Math.max(a, b); c++) rows.add(String.fromCharCode(c));
  }
  const listRx = /\brows?\s*[:\-]?\s*((?:[A-Za-z]\s*,?\s*)+)/gi;
  while ((m = listRx.exec(line)) !== null) {
    const letters = m[1].match(/[A-Za-z]/g) ?? [];
    letters.forEach((l) => rows.add(l.toUpperCase()));
  }
  return Array.from(rows);
}

/** Explicit seat IDs: "seat D7", "seats D7, D8". */
function extractSeatIds(line: string): string[] {
  const ids = new Set<string>();
  const rx = /\bseats?\s*[:\-]?\s*((?:[A-Za-z]\d{1,3}\s*,?\s*)+)/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(line)) !== null) {
    const tokens = m[1].match(/[A-Za-z]\d{1,3}/g) ?? [];
    tokens.forEach((t) => ids.add(t.toUpperCase()));
  }
  return Array.from(ids);
}

/** Match a label against known seating-area names (substring, case-insensitive). */
function matchSection(label: string, sections: SectionInfo[]): SectionInfo | null {
  const l = label.toLowerCase();
  let best: SectionInfo | null = null;
  for (const s of sections) {
    const name = s.section.toLowerCase();
    if (!name) continue;
    if (l.includes(name) || name.includes(l)) {
      if (!best || name.length > best.section.length) best = s;
    }
  }
  return best;
}

function stripKnownLabelNoise(line: string): string {
  return line
    .replace(/\brows?\s*[:\-]?\s*(?:[A-Za-z]\s*,?\s*)+(?:(?:-|to|–|—)\s*[A-Za-z])?/gi, "")
    .replace(/\bseats?\s*[:\-]?\s*(?:[A-Za-z]\d{1,3}\s*,?\s*)+/gi, "")
    .replace(makeTimeRegex(), "")
    .replace(/[-–—]+/g, " ")
    .replace(/[:.]/g, " ")
    .replace(/\bto\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Parse OCR'd rota text into structured entries.
 *
 * `sections` — the venue's known seating sections/rows (from the active seat
 * layout, or a sensible fallback in demo mode). When a line names a known
 * section, it's auto-filled; otherwise the entry is left for the user to
 * confirm — see `needsSeatingAnswer`.
 */
export function parseRotaText(text: string, sections: SectionInfo[] = []): ParsedRotaEntry[] {
  const date = todayLocal();
  const clean = cleanOcrText(text);
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);

  const entries: ParsedRotaEntry[] = [];
  // Parallel bookkeeping, cleared up in the second pass below.
  const singleTime: boolean[] = [];
  const hasLocationArr: boolean[] = [];
  const isGroupArr: boolean[] = [];

  for (const line of lines) {
    if (line.length < 3) continue;

    const times = extractTimes(line, date);
    if (times.length === 0) continue;

    const rows = extractRows(line);
    const seatIds = extractSeatIds(line);
    let label = stripKnownLabelNoise(line);
    label = label.replace(/\brows?\b/gi, "").replace(/\bseats?\b/gi, "").trim();
    if (!label || label.length < 2) continue;

    const matched = rows.length === 0 && seatIds.length === 0 ? matchSection(label, sections) : null;
    const hasLocation = rows.length > 0 || seatIds.length > 0 || !!matched;
    const isGroup = GROUP_KEYWORDS.some((k) => label.toLowerCase().includes(k));

    entries.push({
      label,
      start_time: times[0],
      end_time: times[1] ?? addMinutesIso(times[0], 30), // placeholder — refined below
      rows,
      seat_ids: seatIds,
      section: matched?.section ?? null,
      confidence: times.length >= 2 && hasLocation ? "high" : times.length >= 2 || hasLocation ? "medium" : "low",
      note: null, // filled in below, once we know whether chaining resolved the end time
    });
    singleTime.push(times.length < 2);
    hasLocationArr.push(hasLocation);
    isGroupArr.push(isGroup);
  }

  // Many rotas — especially a running "order of service" — list only a
  // single time per line (when a group goes up), not an explicit
  // start/end slot. For those, the next scheduled entry's start time is a
  // far better estimate of when this one ends than a blind +30 minutes,
  // so chain them when the gap is a plausible single-session length.
  for (let i = 0; i < entries.length; i++) {
    if (singleTime[i]) {
      const next = entries[i + 1];
      let chained = false;
      if (next) {
        const gapMin = (new Date(next.start_time).getTime() - new Date(entries[i].start_time).getTime()) / 60000;
        if (gapMin > 0 && gapMin <= 180) {
          entries[i].end_time = next.start_time;
          chained = true;
        }
      }
      if (!chained) {
        entries[i].note = "Only one time found for this entry — please check the end time";
      }
    }
    if (!hasLocationArr[i] && isGroupArr[i] && !entries[i].note) {
      entries[i].note = "Seating area wasn't in the photo — Kyro will ask you below";
    }
  }

  return entries;
}

/** True when we genuinely don't know where this entry sits, and should ask. */
export function needsSeatingAnswer(e: ParsedRotaEntry): boolean {
  return e.rows.length === 0 && e.seat_ids.length === 0 && !e.section && e.label.trim().length > 0;
}
