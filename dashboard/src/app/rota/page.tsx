"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { DateTimePicker } from "@/components/ui/DateTimePicker";
import { useCameras } from "@/hooks/useCameras";
import { seatsApi } from "@/lib/api";
import { ROW_CONFIG as DEMO_ROW_CONFIG } from "@/lib/demo";
import { parseRotaText, needsSeatingAnswer, type ParsedRotaEntry, type SectionInfo } from "@/lib/rotaParser";
import { SeatingAreaPicker, type SeatingAnswer } from "@/components/ui/SeatingAreaPicker";
import {
  Upload, Camera, Check, X, Plus, Trash2, AlertCircle,
  Clock, ChevronDown, ChevronUp, CalendarDays, Users2,
} from "lucide-react";

const API_URL   = process.env.NEXT_PUBLIC_API_URL ?? "";
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO === "true";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

const CARD   = "#0d1117";
const BORDER = "#1e2235";
const INPUT  = "bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-full";

const DEMO_ROTA_KEY = "kyro_demo_rota";

function loadDemoRota(): ActiveRotaEntry[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(DEMO_ROTA_KEY) ?? "[]"); } catch { return []; }
}

function saveDemoRota(entries: ActiveRotaEntry[]) {
  try { localStorage.setItem(DEMO_ROTA_KEY, JSON.stringify(entries)); } catch {}
}

// ─── Types ────────────────────────────────────────────────────────────────────

// Parsed/editable entry shape used by this page — same shape the backend
// confirm-photo endpoint expects, re-exported from the free local parser.
type ParsedEntry = ParsedRotaEntry;

interface ActiveRotaEntry {
  entry_id: string;
  label: string;
  start_time: string;
  end_time: string;
  rows: string[];
  seat_ids: string[];
  section: string | null;
  is_active: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem("kyro_token") ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function confidenceBadge(c: string) {
  if (c === "high")   return { bg: "rgba(16,185,129,0.15)", text: "#6ee7b7", label: "High" };
  if (c === "medium") return { bg: "rgba(245,158,11,0.15)", text: "#fde68a", label: "Medium" };
  return               { bg: "rgba(239,68,68,0.15)",  text: "#fca5a5", label: "Low — review" };
}

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

function blankEntry(): ParsedEntry {
  const base = `${todayLocal()}T`;
  return { label: "", start_time: `${base}10:00:00`, end_time: `${base}10:30:00`,
           rows: [], seat_ids: [], section: null, confidence: "high", note: null };
}

/** Load the venue's known seating areas (sections + their rows). Used both
 *  to auto-fill obvious entries during parsing and to power the "which
 *  seating area is this?" picker for entries that stay ambiguous.
 *  Entirely local/free — no AI call involved. */
async function loadSectionsFor(camId: string | null): Promise<SectionInfo[]> {
  if (!camId) return [];
  if (inDemoMode()) {
    return [{ section: "Main Floor", rows: DEMO_ROW_CONFIG.map((r) => r.row) }];
  }
  try {
    const layouts = await seatsApi.listLayouts(camId);
    const active = layouts.find((l) => l.is_active) ?? layouts[0];
    if (!active) return [];
    const bySection = new Map<string, Set<string>>();
    for (const seat of active.seats) {
      if (!bySection.has(seat.section)) bySection.set(seat.section, new Set());
      bySection.get(seat.section)!.add(seat.row);
    }
    return Array.from(bySection.entries()).map(([section, rows]) => ({
      section,
      rows: Array.from(rows).sort(),
    }));
  } catch {
    return [];
  }
}

// ─── Photo Upload Panel ───────────────────────────────────────────────────────

function PhotoUpload({ sections, onParsed }: {
  sections: SectionInfo[];
  onParsed: (entries: ParsedEntry[], rawText: string, warnings: string[]) => void;
}) {
  const [dragging, setDragging]   = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      // Run OCR entirely in the browser — no backend, no API key, no cost.
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      const { data: { text } } = await worker.recognize(file);
      await worker.terminate();

      // Parse the extracted text into rota entries, using the venue's known
      // seating areas to auto-fill whatever the photo makes obvious.
      const entries = parseRotaText(text, sections);
      const warns: string[] = [];
      if (entries.length === 0) {
        warns.push("Couldn't read structured times from this image — please fill in manually below.");
      } else if (entries.every(needsSeatingAnswer)) {
        // A running order that only lists times (e.g. "10:00 Choir",
        // "10:15 Offering") has nothing for the parser to place on a seat
        // map — that's expected, not a parsing failure, so say so plainly
        // rather than flagging every single row as "low confidence".
        warns.push("This rota lists times only, with no seating rows — Kyro will ask below where each group sits.");
      }
      onParsed(entries.length > 0 ? entries : [blankEntry()], text, warns);
    } catch (e: any) {
      onParsed([blankEntry()], "", ["Could not read image — fill in manually below."]);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) upload(file);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className="rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-3 py-10 cursor-pointer transition-colors"
      style={{ borderColor: dragging ? "#6366f1" : BORDER, background: dragging ? "rgba(99,102,241,0.06)" : CARD }}
    >
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      {uploading ? (
        <>
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Reading your rota…</p>
          <p className="text-xs text-gray-600">Scanning the image on your device — nothing is uploaded</p>
        </>
      ) : (
        <>
          <div className="w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ background: "rgba(99,102,241,0.12)" }}>
            <Upload size={22} className="text-indigo-400" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-white">Drop a photo of your rota</p>
            <p className="text-xs text-gray-500 mt-1">Read locally in your browser — free, no API key needed</p>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Editable entry row ───────────────────────────────────────────────────────

function EntryEditor({ entry, index, onChange, onRemove }: {
  entry: ParsedEntry;
  index: number;
  onChange: (i: number, e: ParsedEntry) => void;
  onRemove: (i: number) => void;
}) {
  const badge = confidenceBadge(entry.confidence);

  function set(field: keyof ParsedEntry, val: any) {
    onChange(index, { ...entry, [field]: val });
  }

  return (
    <div className="rounded-xl p-4 flex flex-col gap-3"
      style={{ background: "#0a0c18", border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-2">
        <span className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ background: badge.bg, color: badge.text }}>
          {badge.label} confidence
        </span>
        <button onClick={() => onRemove(index)}
          className="ml-auto text-gray-600 hover:text-red-400 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Who / group</label>
          <input value={entry.label} onChange={(e) => set("label", e.target.value)}
            placeholder="e.g. Choir, Pastor John, Welcome Team"
            className={INPUT} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Section (optional)</label>
          <input value={entry.section ?? ""} onChange={(e) => set("section", e.target.value || null)}
            placeholder="e.g. Choir"
            className={INPUT} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">On stage from</label>
          <DateTimePicker value={entry.start_time.slice(0, 16)}
            onChange={(v) => set("start_time", `${v}:00`)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Back to seat by</label>
          <DateTimePicker value={entry.end_time.slice(0, 16)}
            onChange={(v) => set("end_time", `${v}:00`)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Seat rows (comma-separated)</label>
          <input value={entry.rows.join(", ")}
            onChange={(e) => set("rows", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            placeholder="e.g. A, B, C"
            className={INPUT} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Specific seat IDs (optional)</label>
          <input value={entry.seat_ids.join(", ")}
            onChange={(e) => set("seat_ids", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            placeholder="e.g. D7, D8"
            className={INPUT} />
        </div>
      </div>

      {entry.note && (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2"
          style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
          <AlertCircle size={13} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300">{entry.note}</p>
        </div>
      )}
    </div>
  );
}

// ─── Active rota list ─────────────────────────────────────────────────────────

function ActiveRota({ cameraId, entries, onDeleted }: {
  cameraId: string;
  entries: ActiveRotaEntry[];
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(entryId: string) {
    setDeleting(entryId);
    try {
      if (inDemoMode()) {
        const updated = loadDemoRota().filter((e) => e.entry_id !== entryId);
        saveDemoRota(updated);
      } else {
        await fetch(`${API_URL}/api/v1/rota/${cameraId}/${entryId}`, {
          method: "DELETE",
          headers: authHeader(),
        });
      }
      onDeleted(entryId);
    } finally {
      setDeleting(null);
    }
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-600 text-center py-6">
        No rota entries yet — upload a photo or add one manually below.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map((e) => {
        const now = Date.now();
        const start = new Date(e.start_time).getTime();
        const end   = new Date(e.end_time).getTime();
        const live  = now >= start && now <= end;
        const past  = now > end;
        return (
          <div key={e.entry_id} className="flex items-start gap-3 rounded-xl px-4 py-3"
            style={{ background: live ? "rgba(99,102,241,0.08)" : "#0a0c18",
                     border: `1px solid ${live ? "#4338ca" : BORDER}` }}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-white">{e.label}</span>
                {live && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: "rgba(99,102,241,0.3)", color: "#a5b4fc" }}>
                    ● Live now
                  </span>
                )}
                {past && (
                  <span className="text-xs text-gray-600">ended</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <Clock size={11} />
                  {formatTime(e.start_time)} – {formatTime(e.end_time)}
                </span>
                {e.section && (
                  <span className="flex items-center gap-1">
                    <Users2 size={11} />
                    {e.section}
                  </span>
                )}
                {e.rows.length > 0 && (
                  <span className="flex items-center gap-1">
                    {!e.section && <Users2 size={11} />}
                    Rows {e.rows.join(", ")}
                  </span>
                )}
                {e.seat_ids.length > 0 && (
                  <span>Seats: {e.seat_ids.join(", ")}</span>
                )}
              </div>
            </div>
            <button onClick={() => remove(e.entry_id)} disabled={deleting === e.entry_id}
              className="text-gray-600 hover:text-red-400 transition-colors shrink-0 disabled:opacity-40">
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RotaPage() {
  const { cameras } = useCameras();
  const [cameraId, setCameraId]     = useState<string | null>(null);
  const activeCamId = cameraId ?? cameras[0]?.camera_id ?? null;

  // Known seating areas for the active camera — used to auto-fill obvious
  // entries and to power the seating-area picker for ambiguous ones.
  const [sections, setSections] = useState<SectionInfo[]>([]);

  // Photo parse state
  const [parsed, setParsed]         = useState<ParsedEntry[] | null>(null);
  const [rawText, setRawText]       = useState("");
  const [warnings, setWarnings]     = useState<string[]>([]);
  const [showRaw, setShowRaw]       = useState(false);

  // Entries the user has explicitly said "no fixed seat" for — excluded
  // from the pending-questions count even though they stay unlocated.
  const [skipped, setSkipped] = useState<Set<number>>(new Set());

  // Confirm state
  const [saving, setSaving]         = useState(false);
  const [saveErr, setSaveErr]       = useState<string | null>(null);
  const [saved, setSaved]           = useState(false);

  // Active rota
  const [active, setActive]         = useState<ActiveRotaEntry[]>([]);
  const [loadingActive, setLoading] = useState(false);

  const loadActive = useCallback(async (camId: string) => {
    if (inDemoMode()) {
      setActive(loadDemoRota());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/rota/${camId}`, {
        headers: authHeader(),
      });
      if (res.ok) setActive(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  // Load active entries + known seating areas on mount and when camera changes
  useEffect(() => {
    if (!activeCamId) return;
    loadActive(activeCamId);
    loadSectionsFor(activeCamId).then(setSections);
  }, [activeCamId, loadActive]);

  function handleCameraChange(id: string) {
    setCameraId(id);
    setParsed(null); setSaved(false); setSaveErr(null); setSkipped(new Set());
    loadActive(id);
    loadSectionsFor(id).then(setSections);
  }

  function handleParsed(entries: ParsedEntry[], raw: string, warns: string[]) {
    setParsed(entries.length > 0 ? entries : [blankEntry()]);
    setRawText(raw);
    setWarnings(warns);
    setSaved(false);
    setSkipped(new Set());
  }

  function updateEntry(i: number, e: ParsedEntry) {
    if (!parsed) return;
    const updated = [...parsed];
    updated[i] = e;
    setParsed(updated);
  }

  function updateSeatingAnswer(i: number, answer: SeatingAnswer) {
    if (!parsed) return;
    updateEntry(i, { ...parsed[i], section: answer.section, rows: answer.rows });
    // Answering supersedes an earlier skip for this entry.
    setSkipped((prev) => { const next = new Set(prev); next.delete(i); return next; });
  }

  function skipSeatingAnswer(i: number) {
    setSkipped((prev) => new Set(prev).add(i));
  }

  function removeEntry(i: number) {
    if (!parsed) return;
    setParsed(parsed.filter((_, idx) => idx !== i));
    setSkipped((prev) => {
      const next = new Set<number>();
      prev.forEach((idx) => {
        if (idx === i) return;
        next.add(idx > i ? idx - 1 : idx);
      });
      return next;
    });
  }

  // Entries that are still genuinely ambiguous and haven't been skipped —
  // these block saving until the user answers or explicitly skips them.
  const pendingIdx = (parsed ?? [])
    .map((e, i) => (needsSeatingAnswer(e) && !skipped.has(i) ? i : -1))
    .filter((i) => i >= 0);

  async function confirm() {
    if (!parsed || !activeCamId) return;
    if (pendingIdx.length > 0) return;
    if (inDemoMode()) {
      // Convert parsed entries to active rota entries and persist them
      const newEntries: ActiveRotaEntry[] = parsed
        .filter((e) => e.label.trim())
        .map((e, i) => ({
          entry_id:  `rota-demo-${Date.now()}-${i}`,
          label:     e.label,
          start_time: e.start_time,
          end_time:   e.end_time,
          rows:       e.rows,
          seat_ids:   e.seat_ids,
          section:    e.section,
          is_active:  true,
        }));
      const all = [...loadDemoRota(), ...newEntries];
      saveDemoRota(all);
      setActive(all);
      setSaved(true);
      setParsed(null);
      return;
    }
    setSaving(true); setSaveErr(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/rota/${activeCamId}/confirm-photo`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ entries: parsed, service_date: todayLocal() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? res.statusText);
      }
      setSaved(true);
      setParsed(null);
      await loadActive(activeCamId);
    } catch (e: any) {
      setSaveErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: "#070911" }}>
      <Sidebar />
      <main className="flex-1 p-6 max-w-2xl flex flex-col gap-6">

        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <CalendarDays size={20} className="text-indigo-400" />
            Service Rota
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Upload a photo of your printed rota so Kyro knows who is scheduled on stage and when —
            it won't confuse scheduled appearances with altar call responses.
          </p>
        </div>

        {/* Camera selector */}
        {cameras.length > 1 && (
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 shrink-0">Camera zone</label>
            <select value={activeCamId ?? ""} onChange={(e) => handleCameraChange(e.target.value)}
              className="bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              {cameras.map((c) => (
                <option key={c.camera_id} value={c.camera_id}>{c.zone_name || c.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Explainer banner */}
        <div className="rounded-xl px-4 py-3 flex items-start gap-3"
          style={{ background: "rgba(99,102,241,0.07)", border: "1px solid rgba(99,102,241,0.2)" }}>
          <AlertCircle size={15} className="text-indigo-400 shrink-0 mt-0.5" />
          <p className="text-xs text-gray-300 leading-relaxed">
            Kyro uses this rota to tell the difference between someone going to the altar to
            give their life to Christ, and someone who was already scheduled to be at the front
            (choir, worship team, pastor, welcome team). The photo is read entirely on your
            device — free, no API key, nothing uploaded to parse it. If Kyro can't tell where a
            group sits, it'll ask you below instead of guessing.
          </p>
        </div>

        {/* Active rota */}
        <div className="rounded-xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
            <p className="text-sm font-semibold text-white">Today's rota</p>
            <p className="text-xs text-gray-500 mt-0.5">
              These entries are live in Kyro — entries shown in purple are active right now
            </p>
          </div>
          <div className="px-4 py-4">
            {loadingActive ? (
              <p className="text-sm text-gray-600 text-center py-4">Loading…</p>
            ) : activeCamId ? (
              <ActiveRota
                cameraId={activeCamId}
                entries={active}
                onDeleted={(id) => setActive((prev) => prev.filter((e) => e.entry_id !== id))}
              />
            ) : (
              <p className="text-sm text-gray-600 text-center py-4">No cameras registered yet</p>
            )}
          </div>
        </div>

        {/* Success banner */}
        {saved && (
          <div className="rounded-xl px-4 py-3 flex items-center gap-2"
            style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)" }}>
            <Check size={14} className="text-emerald-400" />
            <p className="text-sm text-emerald-300">Rota saved — Kyro will use these times immediately.</p>
          </div>
        )}

        {/* Upload panel */}
        {activeCamId && !parsed && (
          <div className="rounded-xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
            <div className="px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <p className="text-sm font-semibold text-white flex items-center gap-2">
                <Camera size={14} className="text-indigo-400" />
                Upload rota photo
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Take a photo of your printed or whiteboard rota — Kyro reads it on-device
              </p>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <PhotoUpload sections={sections} onParsed={handleParsed} />
              <div className="flex items-center gap-3">
                <div className="flex-1 border-t" style={{ borderColor: BORDER }} />
                <span className="text-xs text-gray-600">or</span>
                <div className="flex-1 border-t" style={{ borderColor: BORDER }} />
              </div>
              <button onClick={() => setParsed([blankEntry()])}
                className="flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors self-start">
                <Plus size={14} /> Add entry manually
              </button>
            </div>
          </div>
        )}

        {/* Parsed entries for review + confirm */}
        {parsed && (
          <div className="rounded-xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
            <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <div>
                <p className="text-sm font-semibold text-white">Review & confirm</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Check the times and rows, then save to Kyro
                </p>
              </div>
              <button onClick={() => { setParsed(null); setSaveErr(null); }}
                className="text-gray-600 hover:text-gray-300">
                <X size={15} />
              </button>
            </div>

            {warnings.length > 0 && (
              <div className="px-4 pt-3">
                <div className="flex items-start gap-2 rounded-lg px-3 py-2 mb-2"
                  style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)" }}>
                  <AlertCircle size={12} className="text-indigo-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-indigo-300">{warnings[0]}</p>
                </div>
              </div>
            )}

            {pendingIdx.length > 0 && (
              <div className="px-4 pt-3">
                <div className="flex items-start gap-2 rounded-lg px-3 py-2"
                  style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)" }}>
                  <AlertCircle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-300">
                    Kyro needs {pendingIdx.length} more seating {pendingIdx.length === 1 ? "answer" : "answers"} below
                    before this can be saved.
                  </p>
                </div>
              </div>
            )}

            <div className="px-4 py-3 flex flex-col gap-3">
              {parsed.map((entry, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <EntryEditor entry={entry} index={i}
                    onChange={updateEntry} onRemove={removeEntry} />
                  {needsSeatingAnswer(entry) && (
                    <SeatingAreaPicker
                      label={entry.label}
                      sections={sections}
                      value={{ section: entry.section, rows: entry.rows }}
                      resolved={skipped.has(i)}
                      onChange={(answer) => updateSeatingAnswer(i, answer)}
                      onSkip={() => skipSeatingAnswer(i)}
                    />
                  )}
                </div>
              ))}

              <button onClick={() => setParsed([...parsed, blankEntry()])}
                className="flex items-center gap-2 text-xs text-indigo-400 hover:text-indigo-300 self-start transition-colors">
                <Plus size={12} /> Add another entry
              </button>

              {saveErr && <p className="text-xs text-red-400">{saveErr}</p>}

              <div className="flex gap-2 pt-1">
                <button onClick={confirm} disabled={saving || parsed.length === 0 || pendingIdx.length > 0}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50">
                  <Check size={14} />
                  {saving
                    ? "Saving…"
                    : pendingIdx.length > 0
                    ? "Answer the seating questions above"
                    : `Save ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"} to Kyro`}
                </button>
                <button onClick={() => { setParsed(null); setSaveErr(null); }}
                  className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white bg-gray-800">
                  Cancel
                </button>
              </div>
            </div>

            {/* Raw text toggle */}
            {rawText && (
              <div style={{ borderTop: `1px solid ${BORDER}` }}>
                <button onClick={() => setShowRaw((p) => !p)}
                  className="w-full flex items-center justify-between px-4 py-2 text-xs text-gray-500 hover:text-gray-300">
                  <span>What Kyro read from the image</span>
                  {showRaw ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                {showRaw && (
                  <pre className="px-4 pb-4 text-xs text-gray-500 font-mono whitespace-pre-wrap leading-relaxed">
                    {rawText}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
