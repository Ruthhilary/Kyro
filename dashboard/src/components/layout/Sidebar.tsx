"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useReviewContext } from "@/lib/ReviewContext";
import { useCameras } from "@/hooks/useCameras";
import { DEMO_MODE } from "@/lib/demo";
import {
  Radio, Armchair, ClipboardList, BarChart2,
  PencilRuler, Camera, Users, LogOut, ChevronDown, Cctv, Bell, CalendarDays,
} from "lucide-react";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

const ALL_NAV = [
  { id: "attendance",    href: "/attendance",    label: "AI Count",      Icon: Radio        },
  { id: "live-cameras",  href: "/live-cameras",  label: "Live Cameras",  Icon: Cctv         },
  { id: "seating",       href: "/seating",       label: "Seat Map",      Icon: Armchair     },
  { id: "cameras",       href: "/cameras",       label: "Cameras",       Icon: Camera       },
  { id: "rota",          href: "/rota",          label: "Rota",          Icon: CalendarDays },
  { id: "sessions",      href: "/sessions",      label: "Sessions",      Icon: ClipboardList},
  { id: "analytics",     href: "/analytics",     label: "Analytics",     Icon: BarChart2    },
  { id: "layout-editor", href: "/layout-editor", label: "Seat Editor",   Icon: PencilRuler  },
  { id: "notifications", href: "/notifications", label: "Notifications", Icon: Bell         },
  { id: "users",         href: "/users",         label: "Users",         Icon: Users        },
] as const;

type PageId = typeof ALL_NAV[number]["id"];

const ROLE_DEFAULT_PAGES: Record<string, PageId[]> = {
  admin:    ALL_NAV.map((p) => p.id),
  operator: ["attendance","live-cameras","seating","cameras","rota","sessions","analytics","notifications"],
  viewer:   ["seating","cameras"],
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator", operator: "Operator", viewer: "Viewer", usher: "Usher", counter: "Counter",
};

const BG     = "#0d0f1a";
const ACTIVE = "#3730a3";
const DIVIDER = "#1f2937";

function getStoredPages(username: string, role: string): PageId[] {
  try {
    // Demo mode: read from demo users store
    const saved = JSON.parse(localStorage.getItem("kyro_demo_users") ?? "[]");
    const match = saved.find((u: any) => u.username === username && u.is_active);
    if (match?.pages && Array.isArray(match.pages) && match.pages.length > 0) return match.pages as PageId[];
  } catch {}
  try {
    // Real mode: read from pages-by-username store (set by admin in Users page)
    const byUsername = JSON.parse(localStorage.getItem("kyro_user_pages_by_name") ?? "{}");
    if (byUsername[username]?.length > 0) return byUsername[username] as PageId[];
  } catch {}
  return (ROLE_DEFAULT_PAGES[role] as PageId[]) ?? ["seating","cameras"];
}

// ─── Global state hooks ───────────────────────────────────────────────────────

/** Count of ALL pending AI questions — live queue + unanswered backlog */
function usePendingReviews(): number {
  const { reviews } = useReviewContext();
  const [unansweredCount, setUnansweredCount] = useState(0);

  useEffect(() => {
    function readUnanswered() {
      try {
        const stored = JSON.parse(localStorage.getItem("kyro_unanswered_reviews") ?? "[]");
        setUnansweredCount(Array.isArray(stored) ? stored.length : 0);
      } catch { setUnansweredCount(0); }
    }
    readUnanswered();
    window.addEventListener("kyro_unanswered_changed", readUnanswered);
    return () => window.removeEventListener("kyro_unanswered_changed", readUnanswered);
  }, []);

  return reviews.length + unansweredCount;
}

/** Whether any session is currently live */
function useHasLiveSession(): boolean {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        if (inDemoMode()) {
          // Demo: read from localStorage
          const sessions = JSON.parse(localStorage.getItem("kyro_demo_sessions") ?? "[]");
          setLive(sessions.some((s: any) => !s.ended_at));
          return;
        }
        // Real mode: poll the sessions API
        const token = localStorage.getItem("kyro_token") ?? "";
        if (!token) return;
        const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
        const res = await fetch(`${API_URL}/api/v1/attendance/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const sessions = await res.json();
        setLive(Array.isArray(sessions) && sessions.some((s: any) => !s.ended_at));
      } catch { setLive(false); }
    };
    check();
    const t = setInterval(check, 10_000); // poll every 10s
    window.addEventListener("storage", check);
    return () => { clearInterval(t); window.removeEventListener("storage", check); };
  }, []);

  return live;
}

/** Live venue total from demo feed */
function useLiveTotal(): number | null {
  const { cameras } = useCameras();
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    if (!inDemoMode() || cameras.length === 0) return;
    // Subscribe to the demo pipeline stream counts via a shared key
    const poll = () => {
      try {
        const raw = localStorage.getItem("kyro_sidebar_total");
        if (raw) setTotal(parseInt(raw, 10));
      } catch {}
    };
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [cameras.length]);

  return total;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar() {
  const pathname = usePathname();
  const { logout, role, username } = useAuth();
  const initial = username?.[0]?.toUpperCase() ?? "A";

  const pendingReviews = usePendingReviews();
  const hasLiveSession = useHasLiveSession();

  const [allowedPages, setAllowedPages] = useState<PageId[]>(() =>
    (ROLE_DEFAULT_PAGES[role] as PageId[]) ?? ["seating","cameras"]
  );

  useEffect(() => {
    if (!username) return;
    setAllowedPages(getStoredPages(username, role));
  }, [username, role]);

  useEffect(() => {
    function onAccessChanged() {
      if (username) setAllowedPages(getStoredPages(username, role));
    }
    function onStorage(e: StorageEvent) {
      if (e.key === "kyro_demo_users" && username) setAllowedPages(getStoredPages(username, role));
    }
    window.addEventListener("kyro_role_changed", onAccessChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("kyro_role_changed", onAccessChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [username, role]);

  const visibleNav = ALL_NAV.filter((item) => allowedPages.includes(item.id));

  return (
    <aside className="w-56 shrink-0 flex flex-col" style={{ background: BG, borderRight: `1px solid ${DIVIDER}` }}>
      {/* Brand */}
      <div className="px-5 pt-6 pb-5 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
          style={{ background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)" }}>
          <Radio size={14} className="text-white" strokeWidth={2} />
        </div>
        <div>
          <span className="text-sm font-bold text-white tracking-tight leading-none">Kyro</span>
          <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>Vision Intelligence</p>
        </div>
      </div>

      {/* AI question alert — shown on every page when questions are pending */}
      {pendingReviews > 0 && (
        <div className="mx-3 mb-1">
          <Link href="/seating"
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all"
            style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", color: "#fde68a" }}>
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <span className="flex-1">AI has {pendingReviews} question{pendingReviews !== 1 ? "s" : ""}</span>
            <span style={{ color: "#f59e0b" }}>→</span>
          </Link>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 px-3 flex flex-col gap-0.5 mt-1">
        {visibleNav.map(({ id, href, label, Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link key={href} href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                active ? "text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}
              style={active ? { background: ACTIVE } : {}}>
              <Icon size={16} strokeWidth={1.75} />
              <span className="flex-1">{label}</span>

              {/* Sessions — live indicator */}
              {id === "sessions" && hasLiveSession && (
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
              )}

              {/* AI Count — pending review badge */}
              {id === "attendance" && pendingReviews > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full font-bold shrink-0 tabular-nums"
                  style={{ background: "#f59e0b", color: "#000" }}>
                  {pendingReviews}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* User block */}
      <div className="px-3 pb-4 pt-2 flex flex-col gap-1" style={{ borderTop: `1px solid ${DIVIDER}` }}>
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 cursor-default">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
            style={{ background: ACTIVE }}>
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white truncate">{username}</p>
            <p className="text-xs truncate" style={{ color: "#6b7280" }}>{ROLE_LABELS[role] ?? role}</p>
          </div>
          <ChevronDown size={13} className="text-gray-600 shrink-0" />
        </div>
        <button onClick={logout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors w-full text-left"
          style={{ color: "#6b7280" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#6b7280")}>
          <LogOut size={16} strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
