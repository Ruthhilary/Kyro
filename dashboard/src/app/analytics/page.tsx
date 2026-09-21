"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { analyticsApi } from "@/lib/api";
import { Sidebar } from "@/components/layout/Sidebar";
import { CameraSwitcher } from "@/components/layout/CameraSwitcher";
import { useAuth } from "@/hooks/useAuth";
import { DEMO_MODE, makeDemoAnalytics } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";
import { TrendingUp, Users, Calendar, BarChart2, Search, X, ArrowUp, ArrowDown, Minus } from "lucide-react";
import { DatePicker } from "@/components/ui/DatePicker";
import type { AttendancePoint, AnalyticsSummary, HourlyBucket } from "@/types";

const BG      = "#0d0f1a";
const CARD_BG = "#13152a";
const BORDER  = "#1e2235";
const DEFAULT_CAMERA = process.env.NEXT_PUBLIC_CAMERA_ID ?? "cam-01";

// Safely parse a date from ISO string using UTC
function parseUTC(ts: string) { return new Date(ts); }
const DAYS_LONG  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ─── Stat card ────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, icon: Icon, accent }: {
  label: string; value: string | number; sub?: string; icon: React.ElementType; accent?: string;
}) {
  return (
    <div className="rounded-2xl p-5 flex flex-col gap-3" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: "#6b7280" }}>{label}</span>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: accent ? `${accent}18` : "#1e2235" }}>
          <Icon size={15} style={{ color: accent ?? "#6b7280" }} />
        </div>
      </div>
      <div>
        <p className="text-3xl font-bold text-white tabular-nums leading-none">{value}</p>
        {sub && <p className="text-xs mt-1.5" style={{ color: "#4b5563" }}>{sub}</p>}
      </div>
    </div>
  );
}

// ─── Day detail panel ─────────────────────────────────────────────────────────
function DayDetail({ point, allData, onClose }: { point: AttendancePoint; allData: AttendancePoint[]; onClose: () => void; }) {
  const d       = parseUTC(point.timestamp);
  const dayName = DAYS_LONG[d.getUTCDay()];
  const dateStr = `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const avg     = allData.reduce((s, x) => s + x.attendance, 0) / (allData.length || 1);
  const diff    = Math.round(point.attendance - avg);
  const diffPct = avg > 0 ? Math.round((diff / avg) * 100) : 0;
  const sameDay = allData.filter((x) => parseUTC(x.timestamp).getUTCDay() === d.getUTCDay());
  const idx     = sameDay.findIndex((x) => x.timestamp === point.timestamp);
  const prev    = idx > 0 ? sameDay[idx - 1] : null;
  const prevDiff = prev ? point.attendance - prev.attendance : null;

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <div>
          <p className="text-sm font-bold text-white">{dateStr}</p>
          <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>{dayName}</p>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
      </div>
      <div className="p-5 grid grid-cols-3 gap-4">
        <div className="rounded-xl p-4 flex flex-col gap-1 min-w-0" style={{ background: "#0d0f1c", border: `1px solid ${BORDER}` }}>
          <p className="text-xs whitespace-nowrap" style={{ color: "#6b7280" }}>Attendance</p>
          <p className="text-2xl font-bold text-white tabular-nums">{point.attendance.toLocaleString()}</p>
          <div className="flex items-center gap-1 text-xs flex-wrap">
            {diff > 0 ? <><ArrowUp size={10} className="text-green-400" /><span className="text-green-400">+{diff} vs avg</span></>
              : diff < 0 ? <><ArrowDown size={10} className="text-red-400" /><span className="text-red-400">{diff} vs avg</span></>
              : <><Minus size={10} style={{ color:"#6b7280" }}/><span style={{ color:"#6b7280" }}>At average</span></>}
          </div>
        </div>
        <div className="rounded-xl p-4 flex flex-col gap-1 min-w-0" style={{ background: "#0d0f1c", border: `1px solid ${BORDER}` }}>
          <p className="text-xs whitespace-nowrap" style={{ color: "#6b7280" }}>Occupancy</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: "#818cf8" }}>{point.occupancy_pct.toFixed(1)}%</p>
          <p className="text-xs whitespace-nowrap" style={{ color: "#4b5563" }}>Of seat capacity</p>
        </div>
        <div className="rounded-xl p-4 flex flex-col gap-1 min-w-0" style={{ background: "#0d0f1c", border: `1px solid ${BORDER}` }}>
          <p className="text-xs whitespace-nowrap" style={{ color: "#6b7280" }}>vs last {dayName}</p>
          {prevDiff !== null ? (
            <>
              <p className="text-2xl font-bold tabular-nums"
                style={{ color: prevDiff > 0 ? "#4ade80" : prevDiff < 0 ? "#f87171" : "#9ca3af" }}>
                {prevDiff > 0 ? "+" : ""}{prevDiff}
              </p>
              <p className="text-xs whitespace-nowrap" style={{ color: "#4b5563" }}>Prev: {prev!.attendance.toLocaleString()}</p>
            </>
          ) : <p className="text-xs mt-2" style={{ color: "#4b5563" }}>No prior data</p>}
        </div>
      </div>
      <div className="px-5 pb-5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs" style={{ color: "#6b7280" }}>vs 30-day average ({Math.round(avg).toLocaleString()})</span>
          <span className="text-xs font-semibold" style={{ color: diffPct > 0 ? "#4ade80" : diffPct < 0 ? "#f87171" : "#9ca3af" }}>
            {diffPct > 0 ? "+" : ""}{diffPct}%
          </span>
        </div>
        <div className="rounded-full overflow-hidden" style={{ height: 6, background: "#1e2235" }}>
          <div className="h-full rounded-full"
            style={{ width: `${Math.min(100,(point.attendance/(avg*1.5))*100)}%`,
                     background: diffPct > 10 ? "#4ade80" : diffPct < -10 ? "#f87171" : "#818cf8" }} />
        </div>
      </div>
    </div>
  );
}

// ─── Trend chart ──────────────────────────────────────────────────────────────
function TrendChart({ data }: { data: AttendancePoint[] }) {
  if (!data.length) return (
    <div className="rounded-2xl p-5 flex items-center justify-center" style={{ background: CARD_BG, border: `1px solid ${BORDER}`, height: 200 }}>
      <p className="text-xs" style={{ color: "#4b5563" }}>No data for selected range</p>
    </div>
  );
  const values = data.map((d) => d.attendance);
  const max = Math.max(...values, 1), min = Math.min(...values), range = max - min || 1;
  const H = 140, W = data.length;
  const pts = data.map((d, i) => `${(i/(W-1))*100},${H-((d.attendance-min)/range)*(H-20)-10}`).join(" ");
  return (
    <div className="rounded-2xl p-5" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between mb-4">
        <div><p className="text-sm font-semibold text-white">Attendance trend</p>
          <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>Last {data.length} days</p></div>
        <div className="flex items-center gap-3 text-xs" style={{ color: "#6b7280" }}>
          <span>High: <span className="text-white font-semibold">{max}</span></span>
          <span>Low: <span className="text-white font-semibold">{min}</span></span>
        </div>
      </div>
      <svg viewBox={`0 0 100 ${H}`} className="w-full" style={{ height: H }} preserveAspectRatio="none">
        <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.3"/>
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0"/>
        </linearGradient></defs>
        {[0,0.25,0.5,0.75,1].map((t) => <line key={t} x1="0" y1={H-t*(H-20)-10} x2="100" y2={H-t*(H-20)-10} stroke="#1e2235" strokeWidth="0.5"/>)}
        <polygon points={`0,${H} ${pts} 100,${H}`} fill="url(#ag)"/>
        <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      </svg>
      <div className="flex justify-between mt-2 px-0.5">
        {[0,Math.floor(W/4),Math.floor(W/2),Math.floor(3*W/4),W-1].map((i) => {
          const d = data[i]; if (!d) return null;
          const dt = parseUTC(d.timestamp);
          return <span key={i} className="text-xs" style={{ color: "#4b5563" }}>{dt.getUTCDate()}/{dt.getUTCMonth()+1}</span>;
        })}
      </div>
    </div>
  );
}

// ─── Arrival chart ────────────────────────────────────────────────────────────
function ArrivalChart({ data }: { data: HourlyBucket[] }) {
  if (!data.length) return null;
  const max  = Math.max(...data.map((d) => d.count), 1);
  const peak = data.reduce((a, b) => a.count > b.count ? a : b);
  return (
    <div className="rounded-2xl p-5" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between mb-4">
        <div><p className="text-sm font-semibold text-white">Arrival pattern</p>
          <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>Average arrivals by hour</p></div>
        <div className="text-xs" style={{ color: "#6b7280" }}>Peak: <span className="text-white font-semibold">{peak.hour}:00</span></div>
      </div>
      <div className="flex items-end gap-px" style={{ height: 80 }}>
        {data.map((b) => {
          const h = Math.max((b.count/max)*100, b.count > 0 ? 4 : 0);
          return (
            <div key={b.hour} className="flex-1 h-full flex flex-col items-center justify-end" title={`${b.hour}:00 — ${b.count} arrivals`}>
              <div className="w-full rounded-sm" style={{ height:`${h}%`, background: b.count===max?"#818cf8":b.count>max*0.2?"#4338ca":"#1e2235" }}/>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2">
        {[0,4,8,12,16,20].map((h) => <span key={h} className="text-[9px]" style={{ color:"#4b5563" }}>{h}h</span>)}
      </div>
    </div>
  );
}

// ─── Weekly breakdown ─────────────────────────────────────────────────────────
function WeeklyBreakdown({ data }: { data: AttendancePoint[] }) {
  const byDow: Record<number,number[]> = {};
  data.forEach((d) => { const dow = parseUTC(d.timestamp).getUTCDay(); if(!byDow[dow])byDow[dow]=[]; byDow[dow].push(d.attendance); });
  const labels = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const avgs   = labels.map((_,i) => { const v=byDow[i]??[]; return v.length?Math.round(v.reduce((a,b)=>a+b)/v.length):0; });
  const max    = Math.max(...avgs, 1);
  return (
    <div className="rounded-2xl p-5" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
      <p className="text-sm font-semibold text-white mb-1">Average by day</p>
      <p className="text-xs mb-4" style={{ color: "#6b7280" }}>Based on filtered range</p>
      <div className="flex flex-col gap-2">
        {labels.map((day,i) => {
          const pct = (avgs[i]/max)*100;
          return (
            <div key={day} className="flex items-center gap-3">
              <span className="text-xs w-7 shrink-0" style={{ color:"#6b7280" }}>{day}</span>
              <div className="flex-1 rounded-full overflow-hidden" style={{ height:6, background:"#1e2235" }}>
                <div className="h-full rounded-full" style={{ width:`${pct}%`, background:pct>80?"#818cf8":pct>40?"#4f46e5":"#2d3148" }}/>
              </div>
              <span className="text-xs tabular-nums w-8 text-right" style={{ color:avgs[i]>0?"#9ca3af":"#374151" }}>
                {avgs[i]>0?avgs[i]:"—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Recent sessions table ────────────────────────────────────────────────────
function RecentSessions({ data, onSelect, selectedTs }: {
  data: AttendancePoint[]; onSelect: (p: AttendancePoint) => void; selectedTs?: string;
}) {
  const recent = [...data].reverse().slice(0, 10);
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}>
      <div className="px-5 py-4" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <p className="text-sm font-semibold text-white">Recent services</p>
        <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>Click a row to see details</p>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
            {["Date","Day","Attendance","Occupancy"].map((h,i) => (
              <th key={h} className={`px-5 py-2.5 font-medium ${i>=2?"text-right":"text-left"}`} style={{ color:"#4b5563" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {recent.map((d, i) => {
            const dt  = parseUTC(d.timestamp);
            const day = dt.getUTCDate(), mon = dt.getUTCMonth()+1, yr = dt.getUTCFullYear(), dow = dt.getUTCDay();
            const sel = d.timestamp === selectedTs;
            return (
              <tr key={i} onClick={() => onSelect(d)}
                style={{ borderBottom: i<recent.length-1?`1px solid ${BORDER}`:"none",
                         background: sel?"rgba(99,102,241,0.1)":"transparent", cursor:"pointer" }}
                onMouseEnter={(e)=>{ if(!sel)(e.currentTarget as HTMLElement).style.background="#1e2235"; }}
                onMouseLeave={(e)=>{ (e.currentTarget as HTMLElement).style.background=sel?"rgba(99,102,241,0.1)":"transparent"; }}>
                <td className="px-5 py-3 font-medium" style={{ color:sel?"#818cf8":"#e5e7eb" }}>{day}/{mon}/{yr}</td>
                <td className="px-5 py-3" style={{ color:"#6b7280" }}>{DAYS_LONG[dow]}</td>
                <td className="px-5 py-3 text-right font-semibold text-white tabular-nums">{d.attendance.toLocaleString()}</td>
                <td className="px-5 py-3 text-right tabular-nums" style={{ color:"#6366f1" }}>{d.occupancy_pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const [cameraId, setCameraId] = useState(DEFAULT_CAMERA);
  const { canViewAttendance, isAuthenticated } = useAuth();
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  useEffect(() => {
    if (!hydrated || inDemoMode()) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (!canViewAttendance) router.replace("/seating");
  }, [hydrated, isAuthenticated, canViewAttendance, router]);

  const [history,     setHistory]     = useState<AttendancePoint[]>([]);
  const [summary,     setSummary]     = useState<AnalyticsSummary | null>(null);
  const [arrival,     setArrival]     = useState<HourlyBucket[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [search,      setSearch]      = useState("");
  const [fromDate,    setFromDate]    = useState("");
  const [toDate,      setToDate]      = useState("");
  const [filtered,    setFiltered]    = useState<AttendancePoint[]>([]);
  const [selectedDay, setSelectedDay] = useState<AttendancePoint | null>(null);

  const applyFilter = useCallback((data: AttendancePoint[], q: string, from: string, to: string) => {
    let r = data;
    if (from) r = r.filter((d) => parseUTC(d.timestamp) >= parseUTC(from));
    if (to)   r = r.filter((d) => parseUTC(d.timestamp) <= parseUTC(to + "T23:59:59Z"));
    if (q) {
      const lower = q.toLowerCase();
      const dow   = DAYS_LONG.findIndex((d) => d.toLowerCase().startsWith(lower));
      r = dow >= 0
        ? r.filter((d) => parseUTC(d.timestamp).getUTCDay() === dow)
        : r.filter((d) => d.timestamp.toLowerCase().includes(q.toLowerCase()));
    }
    setFiltered(r);
  }, []);

  const loadData = useCallback(() => {
    if (inDemoMode()) {
      const { history: h, arrival: arr, summary: s } = makeDemoAnalytics();
      const live = h.map((d) => ({ ...d, attendance: Math.max(0, d.attendance + Math.round((Math.random()-0.5)*12)) }));
      setHistory(live);
      setSummary({ ...(s as AnalyticsSummary), avg_attendance: Math.round(live.reduce((a,b)=>a+b.attendance,0)/live.length) });
      setArrival(arr.map((b) => ({ ...b, count: Math.max(0, b.count + Math.round((Math.random()-0.5)*5)) })));
      setFiltered(live);
      // Keep selectedDay in sync by timestamp — don't wipe it on refresh
      setSelectedDay((prev) => {
        if (!prev) return null;
        return live.find((d) => d.timestamp === prev.timestamp) ?? prev;
      });
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([analyticsApi.history(cameraId,30), analyticsApi.summary(cameraId), analyticsApi.arrival(cameraId,30)])
      .then(([h,s,arr]) => { setHistory(h); setFiltered(h); setSummary(s); setArrival(arr); })
      .catch(console.error).finally(() => setLoading(false));
  }, [cameraId]);

  useEffect(() => { loadData(); }, [loadData]);
  // Auto-refresh every 30s in real mode (demo already polls every 5s)
  useEffect(() => {
    if (inDemoMode()) {
      const t = setInterval(loadData, 5000);
      return () => clearInterval(t);
    } else {
      const t = setInterval(loadData, 30_000);
      return () => clearInterval(t);
    }
  }, [loadData]);
  useEffect(() => { applyFilter(history, search, fromDate, toDate); }, [history, search, fromDate, toDate, applyFilter]);

  const firstHalf  = filtered.slice(0,Math.floor(filtered.length/2)).reduce((s,d)=>s+d.attendance,0)/(Math.floor(filtered.length/2)||1);
  const secondHalf = filtered.slice(Math.floor(filtered.length/2)).reduce((s,d)=>s+d.attendance,0)/(Math.ceil(filtered.length/2)||1);
  const trend      = firstHalf>0?Math.round(((secondHalf-firstHalf)/firstHalf)*100):0;

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: BG }}>
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <div className="px-6 py-5 flex items-center justify-between" style={{ borderBottom:`1px solid ${BORDER}`, background:CARD_BG }}>
          <div>
            <h1 className="text-lg font-bold text-white">Analytics</h1>
            <p className="text-xs mt-0.5" style={{ color:"#6b7280" }}>
              Attendance trends and seat utilisation
              {inDemoMode() && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px]" style={{ background:"#1e2235", color:"#6366f1" }}>Live · updates every 5s</span>}
            </p>
          </div>
          <CameraSwitcher activeCameraId={cameraId} onChange={setCameraId} />
        </div>

        {/* Search bar */}
        <form onSubmit={(e)=>{ e.preventDefault(); applyFilter(history,search,fromDate,toDate); }}
          className="px-6 py-3 flex flex-wrap items-center gap-3"
          style={{ borderBottom:`1px solid ${BORDER}`, background:"#0d0f1c" }}>
          <div className="flex items-center gap-2 flex-1 min-w-48 rounded-lg px-3 py-2" style={{ background:CARD_BG, border:`1px solid ${BORDER}` }}>
            <Search size={13} style={{ color:"#6b7280" }}/>
            <input type="text" placeholder="Search by day name (e.g. Sunday) or year…"
              value={search} onChange={(e)=>{ setSearch(e.target.value); applyFilter(history,e.target.value,fromDate,toDate); }}
              className="flex-1 bg-transparent text-xs text-white focus:outline-none placeholder-gray-600"/>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs" style={{ color:"#6b7280" }}>From</label>
            <DatePicker value={fromDate} onChange={(v)=>{ setFromDate(v); if(v){const m=history.find((d)=>d.timestamp.startsWith(v));if(m)setSelectedDay(m);} }} placeholder="Start date"/>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs" style={{ color:"#6b7280" }}>To</label>
            <DatePicker value={toDate} onChange={(v)=>{ setToDate(v); if(v){const m=history.find((d)=>d.timestamp.startsWith(v));if(m)setSelectedDay(m);} }} placeholder="End date"/>
          </div>
          <button type="submit" className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-white" style={{ background:"#4f46e5" }}>
            <Search size={12}/> Search
          </button>
          {(search||fromDate||toDate) && (
            <button type="button" onClick={()=>{ setSearch(""); setFromDate(""); setToDate(""); }}
              className="text-xs px-3 py-2 rounded-lg" style={{ background:"#1e2235", color:"#9ca3af" }}>Clear</button>
          )}
          {filtered.length !== history.length && (
            <span className="text-xs" style={{ color:"#6366f1" }}>Showing {filtered.length} of {history.length} days</span>
          )}
        </form>

        <div className="p-6 flex flex-col gap-5">
          {loading && <div className="text-sm py-16 text-center" style={{ color:"#6b7280" }}>Loading…</div>}
          {!loading && <>
            {summary && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Stat label="Total services" value={summary.total_sessions} sub="Last 6 months" icon={Calendar} accent="#6366f1"/>
                <Stat label="All-time peak" value={summary.all_time_peak.toLocaleString()} sub="Single service record" icon={TrendingUp} accent="#f59e0b"/>
                <Stat label="Average attendance" value={Math.round(summary.avg_attendance).toLocaleString()}
                  sub={trend!==0?`${trend>0?"↑":"↓"} ${Math.abs(trend)}% vs prior period`:"Stable"} icon={Users} accent="#4ade80"/>
                <Stat label="Avg occupancy" value={`${summary.avg_occupancy_pct}%`} sub="Of seat capacity" icon={BarChart2} accent="#818cf8"/>
              </div>
            )}
            {selectedDay && (
              <DayDetail point={selectedDay} allData={history} onClose={()=>setSelectedDay(null)}/>
            )}
            <TrendChart data={filtered}/>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <ArrivalChart data={arrival}/>
              <WeeklyBreakdown data={filtered}/>
            </div>
            <RecentSessions data={filtered} onSelect={setSelectedDay} selectedTs={selectedDay?.timestamp}/>
          </>}
        </div>
      </main>
    </div>
  );
}
