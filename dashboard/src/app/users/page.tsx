"use client";

import { useEffect, useState, FormEvent, useCallback } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { usersApi } from "@/lib/api";
import { DEMO_MODE, DEMO_USERS } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";
import { Eye, EyeOff, KeyRound, X, Check, Pencil } from "lucide-react";
import type { UserResponse } from "@/types";

const BG     = "#0d0f1a";
const CARD   = "#13152a";
const BORDER = "#1e2235";

// ─── All pages ────────────────────────────────────────────────────────────────

const ALL_PAGES = [
  { id: "attendance",    label: "AI Count"      },
  { id: "live-cameras",  label: "Live Cameras"  },
  { id: "seating",       label: "Seat Map"      },
  { id: "cameras",       label: "Cameras"       },
  { id: "rota",          label: "Rota"          },
  { id: "sessions",      label: "Sessions"      },
  { id: "analytics",     label: "Analytics"     },
  { id: "layout-editor", label: "Seat Editor"   },
  { id: "notifications", label: "Notifications" },
  { id: "users",         label: "Users"         },
] as const;

type PageId = typeof ALL_PAGES[number]["id"];

// Role is derived from pages — admin needs layout-editor or users, operator needs
// any "operator" page, otherwise viewer. The sidebar still uses role for nav gating.
function pagesToRole(pages: PageId[]): "admin" | "operator" | "viewer" {
  if (pages.includes("layout-editor") || pages.includes("users")) return "admin";
  const opPages: PageId[] = ["attendance","live-cameras","rota","sessions","analytics","notifications"];
  if (pages.some((p) => opPages.includes(p))) return "operator";
  return "viewer";
}

// Default pages per role (for initial state when editing an existing user)
const ROLE_DEFAULT_PAGES: Record<string, PageId[]> = {
  admin:    ALL_PAGES.map((p) => p.id),
  operator: ["attendance","live-cameras","seating","cameras","rota","sessions","analytics","notifications"],
  viewer:   ["seating","cameras"],
};

// ─── Extended user type with stored pages ─────────────────────────────────────
type DemoUser = UserResponse & { pages?: PageId[]; demo_password?: string };

// ─── Page colours ─────────────────────────────────────────────────────────────
const PAGE_COLOURS: Record<string, { bg: string; text: string }> = {
  "attendance":    { bg: "rgba(99,102,241,0.15)",  text: "#a5b4fc" },
  "live-cameras":  { bg: "rgba(34,197,94,0.12)",   text: "#86efac" },
  "seating":       { bg: "rgba(124,58,237,0.15)",  text: "#c4b5fd" },
  "cameras":       { bg: "rgba(59,130,246,0.15)",  text: "#93c5fd" },
  "rota":          { bg: "rgba(245,158,11,0.15)",  text: "#fde68a" },
  "sessions":      { bg: "rgba(16,185,129,0.12)",  text: "#6ee7b7" },
  "analytics":     { bg: "rgba(249,115,22,0.12)",  text: "#fdba74" },
  "layout-editor": { bg: "rgba(236,72,153,0.12)",  text: "#f9a8d4" },
  "notifications": { bg: "rgba(234,179,8,0.12)",   text: "#fef08a" },
  "users":         { bg: "rgba(239,68,68,0.12)",   text: "#fca5a5" },
};

// ─── Demo storage ─────────────────────────────────────────────────────────────
const DEMO_USERS_KEY = "kyro_demo_users";

function loadDemoUsers(): DemoUser[] {
  try {
    const saved = localStorage.getItem(DEMO_USERS_KEY);
    if (saved) {
      const parsed: DemoUser[] = JSON.parse(saved);
      // Back-fill pages for users that don't have them yet
      return parsed.map((u) => ({
        ...u,
        pages: u.pages ?? (ROLE_DEFAULT_PAGES[u.role] as PageId[]) ?? ["seating","cameras"],
      }));
    }
    // Seed with defaults
    const defaults: DemoUser[] = (DEMO_USERS as UserResponse[]).map((u) => ({
      ...u,
      pages: (ROLE_DEFAULT_PAGES[u.role] as PageId[]) ?? ["seating","cameras"],
    }));
    localStorage.setItem(DEMO_USERS_KEY, JSON.stringify(defaults));
    return defaults;
  } catch { return DEMO_USERS as DemoUser[]; }
}

function saveDemoUsers(users: DemoUser[]) {
  try { localStorage.setItem(DEMO_USERS_KEY, JSON.stringify(users)); } catch {}
}

// ─── Page toggle picker ───────────────────────────────────────────────────────
function PagePicker({ selected, onChange }: {
  selected: PageId[];
  onChange: (s: PageId[]) => void;
}) {
  function toggle(id: PageId) {
    if (selected.includes(id)) onChange(selected.filter((p) => p !== id));
    else onChange([...selected, id]);
  }
  return (
    <div className="flex flex-wrap gap-2">
      {ALL_PAGES.map(({ id, label }) => {
        const on = selected.includes(id);
        const col = PAGE_COLOURS[id];
        return (
          <button key={id} type="button" onClick={() => toggle(id)}
            className="text-xs px-3 py-1.5 rounded-full border transition-all font-medium"
            style={on
              ? { background: col.bg, color: col.text, borderColor: col.text + "60" }
              : { background: "transparent", color: "#4b5563", borderColor: "#1e2235" }}>
            {on && "✓ "}{label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Role badge ───────────────────────────────────────────────────────────────
function RoleBadge({ role }: { role: string }) {
  const s: Record<string, { bg: string; text: string }> = {
    admin:    { bg: "rgba(139,92,246,0.2)",  text: "#c4b5fd" },
    operator: { bg: "rgba(59,130,246,0.2)",  text: "#93c5fd" },
    viewer:   { bg: "rgba(107,114,128,0.2)", text: "#9ca3af" },
  };
  const { bg, text } = s[role] ?? s.viewer;
  return <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: bg, color: text }}>{role}</span>;
}

// ─── Reveal password dialog ───────────────────────────────────────────────────
function RevealPasswordDialog({ username, onClose }: { username: string; onClose: () => void }) {
  const [showPw, setShowPw] = useState(false);
  function getPassword() {
    if (!inDemoMode()) return "Stored as encrypted hash — cannot be retrieved";
    const hardcoded: Record<string, string> = { admin: "Kharis2024!", "sarah.usher": "Sarah@2024!", "james.viewer": "James@2024!" };
    if (hardcoded[username]) return hardcoded[username];
    try {
      const u = loadDemoUsers().find((u) => u.username === username);
      return u?.demo_password ?? "Demo@1234";
    } catch { return "Demo@1234"; }
  }
  const pw = getPassword();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.75)" }}>
      <div className="rounded-2xl p-6 w-96 shadow-2xl" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <KeyRound size={16} style={{ color: "#818cf8" }} />
            <h3 className="text-sm font-semibold text-white">Password — {username}</h3>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 rounded-lg px-3 py-3 mb-4" style={{ background: "#0d0f1a", border: "1px solid #374151" }}>
          <span className="flex-1 text-sm font-mono text-white tracking-wider select-all">
            {showPw ? pw : "•".repeat(Math.min(pw.length, 16))}
          </span>
          <button onClick={() => setShowPw((p) => !p)} className="text-gray-500 hover:text-white flex-shrink-0">
            {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        <button onClick={onClose} className="w-full py-2 rounded-lg text-sm font-medium text-white" style={{ background: "#1e2235" }}>Close</button>
      </div>
    </div>
  );
}

// ─── Inline access editor ─────────────────────────────────────────────────────
function AccessEditor({ user, onSaved, onCancel }: {
  user: DemoUser;
  onSaved: (updated: DemoUser) => void;
  onCancel: () => void;
}) {
  const initial = user.pages ?? (ROLE_DEFAULT_PAGES[user.role] as PageId[]) ?? ["seating","cameras"];
  const [selected, setSelected] = useState<PageId[]>(initial);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState<string | null>(null);
  const derivedRole = pagesToRole(selected);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const updated: DemoUser = { ...user, pages: selected, role: derivedRole };
      if (inDemoMode()) {
        onSaved(updated);
      } else {
        const res = await usersApi.update(user.id, { role: derivedRole });
        onSaved({ ...res, pages: selected });
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-4 py-4 flex flex-col gap-3" style={{ background: "#0a0c18", borderTop: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-white">Edit access for {user.display_name || user.username}</p>
        <span className="text-xs px-2 py-0.5 rounded-full"
          style={{ background: derivedRole === "admin" ? "rgba(139,92,246,0.2)" : derivedRole === "operator" ? "rgba(59,130,246,0.2)" : "rgba(107,114,128,0.2)",
                   color: derivedRole === "admin" ? "#c4b5fd" : derivedRole === "operator" ? "#93c5fd" : "#9ca3af" }}>
          Role: {derivedRole}
        </span>
      </div>
      <PagePicker selected={selected} onChange={setSelected} />
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
          style={{ background: "#4f46e5" }}>
          <Check size={12} />{saving ? "Saving…" : "Save access"}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white" style={{ background: "#1e2235" }}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function UsersPage() {
  const [users, setUsers]               = useState<DemoUser[]>([]);
  const [loading, setLoading]           = useState(true);
  const [status, setStatus]             = useState<{ ok: boolean; msg: string } | null>(null);
  const [revealingFor, setRevealingFor] = useState<string | null>(null);
  const [editingId, setEditingId]       = useState<number | null>(null);

  const [creating, setCreating]   = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplay,  setNewDisplay]  = useState("");
  const [newPages, setNewPages]   = useState<PageId[]>(["seating","cameras"]);
  const newRole = pagesToRole(newPages);

  const loadUsers = useCallback(() => {
    if (inDemoMode()) {
      setUsers(loadDemoUsers().filter((u) => u.is_active));
      setLoading(false);
      return;
    }
    usersApi.list()
      .then((us) => setUsers(us.map((u) => {
        // Restore saved page access for this user if admin set it
        try {
          const byName = JSON.parse(localStorage.getItem("kyro_user_pages_by_name") ?? "{}");
          if (byName[u.username]?.length > 0) return { ...u, pages: byName[u.username] as PageId[] };
        } catch {}
        return { ...u, pages: (ROLE_DEFAULT_PAGES[u.role] as PageId[]) ?? ["seating","cameras"] };
      })))
      .catch((e: any) => setStatus({ ok: false, msg: e.message }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true); setStatus(null);
    if (inDemoMode()) {
      const newUser: DemoUser = {
        id: Date.now(), username: newUsername,
        display_name: newDisplay || newUsername,
        role: newRole, pages: newPages,
        is_active: true, created_at: new Date().toISOString(),
        demo_password: newPassword || "Demo@1234",
      };
      const all = [...loadDemoUsers(), newUser];
      saveDemoUsers(all);
      setUsers(all.filter((u) => u.is_active));
      setNewUsername(""); setNewPassword(""); setNewDisplay(""); setNewPages(["seating","cameras"]);
      setStatus({ ok: true, msg: `"${newUsername}" created` });
      setCreating(false);
      return;
    }
    try {
      await usersApi.create({ username: newUsername, password: newPassword, display_name: newDisplay || undefined, role: newRole });
      setNewUsername(""); setNewPassword(""); setNewDisplay(""); setNewPages(["seating","cameras"]);
      setStatus({ ok: true, msg: "User created" });
      loadUsers();
    } catch (err: any) { setStatus({ ok: false, msg: err.message }); }
    finally { setCreating(false); }
  }

  async function handleDeactivate(id: number, username: string) {
    if (!confirm(`Remove ${username}?`)) return;
    if (inDemoMode()) {
      const all = loadDemoUsers().map((u) => u.id === id ? { ...u, is_active: false } : u);
      saveDemoUsers(all);
      setUsers(all.filter((u) => u.is_active));
      setStatus({ ok: true, msg: `${username} removed` });
      return;
    }
    try { await usersApi.deactivate(id); setStatus({ ok: true, msg: `${username} deactivated` }); loadUsers(); }
    catch (err: any) { setStatus({ ok: false, msg: err.message }); }
  }

  function handleAccessSaved(updated: DemoUser) {
    if (inDemoMode()) {
      const all = loadDemoUsers().map((u) => u.id === updated.id ? { ...u, role: updated.role, pages: updated.pages } : u);
      saveDemoUsers(all);
      setUsers(all.filter((u) => u.is_active));
      const lastUser = localStorage.getItem("kyro_demo_last_user");
      if (lastUser === updated.username) {
        localStorage.setItem("kyro_demo_role", updated.role);
      }
      window.dispatchEvent(new CustomEvent("kyro_role_changed", { detail: { role: updated.role, username: updated.username } }));
    } else {
      // Real mode: persist page list to localStorage keyed by user ID
      // (backend stores role only; pages are a frontend UI concept)
      try {
        const pagesStore = JSON.parse(localStorage.getItem("kyro_user_pages") ?? "{}");
        pagesStore[updated.id] = updated.pages ?? [];
        localStorage.setItem("kyro_user_pages", JSON.stringify(pagesStore));
        // Also store by username so the sidebar can look it up
        const byUsername = JSON.parse(localStorage.getItem("kyro_user_pages_by_name") ?? "{}");
        byUsername[updated.username] = updated.pages ?? [];
        localStorage.setItem("kyro_user_pages_by_name", JSON.stringify(byUsername));
      } catch {}
      setUsers((prev) => prev.map((u) => u.id === updated.id ? updated : u));
    }
    setEditingId(null);
    setStatus({ ok: true, msg: `Access updated for ${updated.display_name || updated.username}` });
  }

  return (
    <div className="flex min-h-screen text-gray-100" style={{ background: BG }}>
      <Sidebar />
      <main className="flex-1 p-6 overflow-auto max-w-4xl">

        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Users</h1>
          <p className="text-sm text-gray-400 mt-0.5">Create accounts and control exactly which sections each person can access</p>
        </div>

        {status && (
          <div className={`mb-5 text-sm px-4 py-3 rounded-xl border ${status.ok ? "border-green-800 text-green-300" : "border-red-800 text-red-300"}`}
            style={{ background: status.ok ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)" }}>
            {status.msg}
          </div>
        )}

        {/* Create form */}
        <form onSubmit={handleCreate} className="rounded-2xl overflow-hidden mb-8" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
          <div className="px-5 py-4" style={{ borderBottom: `1px solid ${BORDER}` }}>
            <p className="text-sm font-semibold text-white">Add a new user</p>
            <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>Toggle the pages they can access</p>
          </div>
          <div className="p-5 flex flex-col gap-5">
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Username</label>
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} required placeholder="john.doe"
                  className="bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-40" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Display name</label>
                <input value={newDisplay} onChange={(e) => setNewDisplay(e.target.value)} placeholder="John Doe"
                  className="bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-40" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Password</label>
                <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required={!inDemoMode()}
                  type="password" minLength={8} placeholder="min 8 chars"
                  className="bg-gray-900 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-40" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <label className="text-xs text-gray-500">Page access</label>
                <span className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: newRole === "admin" ? "rgba(139,92,246,0.2)" : newRole === "operator" ? "rgba(59,130,246,0.2)" : "rgba(107,114,128,0.2)",
                           color: newRole === "admin" ? "#c4b5fd" : newRole === "operator" ? "#93c5fd" : "#9ca3af" }}>
                  → {newRole}
                </span>
              </div>
              <PagePicker selected={newPages} onChange={setNewPages} />
            </div>
            <button type="submit" disabled={creating}
              className="self-start px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "#4f46e5" }}>
              {creating ? "Creating…" : "Create user"}
            </button>
          </div>
        </form>

        {/* Users list */}
        {loading ? (
          <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-gray-600 py-8 text-center">No users yet.</p>
        ) : (
          <div className="rounded-2xl overflow-hidden" style={{ background: CARD, border: `1px solid ${BORDER}` }}>
            <div className="px-5 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{users.length} user{users.length !== 1 ? "s" : ""}</p>
            </div>
            {users.map((u, i) => {
              const pages = u.pages ?? (ROLE_DEFAULT_PAGES[u.role] as PageId[]) ?? [];
              const isEditing = editingId === u.id;
              return (
                <div key={u.id} style={i > 0 ? { borderTop: `1px solid ${BORDER}` } : {}}>
                  <div className="px-5 py-4 flex items-start gap-4">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                      style={{ background: u.role === "admin" ? "#4f46e5" : u.role === "operator" ? "#0369a1" : "#374151" }}>
                      {(u.display_name || u.username)[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <p className="text-sm font-semibold text-white">{u.display_name || u.username}</p>
                        <p className="text-xs font-mono text-gray-600">{u.username}</p>
                        <RoleBadge role={u.role} />
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {ALL_PAGES.filter((p) => pages.includes(p.id)).map((p) => {
                          const col = PAGE_COLOURS[p.id];
                          return (
                            <span key={p.id} className="text-xs px-2 py-0.5 rounded-full" style={{ background: col.bg, color: col.text }}>
                              {p.label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <p className="text-xs text-gray-600">{new Date(u.created_at).toLocaleDateString()}</p>
                      <button onClick={() => setRevealingFor(u.username)}
                        className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                        <KeyRound size={11} /> Password
                      </button>
                      <button onClick={() => setEditingId(isEditing ? null : u.id)}
                        className="flex items-center gap-1 text-xs hover:text-white transition-colors"
                        style={{ color: isEditing ? "#818cf8" : "#6b7280" }}>
                        <Pencil size={11} /> {isEditing ? "Cancel" : "Edit access"}
                      </button>
                      <button onClick={() => handleDeactivate(u.id, u.username)}
                        className="text-xs text-red-500 hover:text-red-400 transition-colors">Remove</button>
                    </div>
                  </div>
                  {isEditing && (
                    <AccessEditor user={u} onSaved={handleAccessSaved} onCancel={() => setEditingId(null)} />
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-gray-700 mt-5">The built-in admin account always has full access.</p>
      </main>
      {revealingFor && <RevealPasswordDialog username={revealingFor} onClose={() => setRevealingFor(null)} />}
    </div>
  );
}
