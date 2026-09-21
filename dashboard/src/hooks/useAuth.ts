"use client";

import { useCallback, useEffect, useState } from "react";
import { authApi, ApiError } from "@/lib/api";
import { DEMO_MODE, DEMO_TOKEN } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

type Role = "admin" | "operator" | "viewer" | "usher" | "counter";

interface AuthState {
  token: string | null;
  role: Role;
  username: string;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  canViewAttendance: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
}

function decodeRole(token: string): Role {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    const r = payload.role as string;
    const valid: Role[] = ["admin","operator","viewer","usher","counter"];
    if (valid.includes(r as Role)) return r as Role;
  } catch {}
  return "viewer";
}

export function useAuth(): AuthState {
  const [token, setToken]   = useState<string | null>(null);
  const [role, setRole]     = useState<Role>("viewer");
  const [username, setUsername] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const VALID_ROLES: Role[] = ["admin","operator","viewer","usher","counter"];

  useEffect(() => {
    const signedOut = sessionStorage.getItem("kyro_signed_out");
    if (signedOut) { setHydrated(true); return; }

    const isLive = isLiveMode();

    // Check for active demo session (works regardless of DEMO_MODE env setting)
    const savedRole = localStorage.getItem("kyro_demo_role") as Role | null;
    const savedUser = localStorage.getItem("kyro_demo_last_user");

    if (inDemoMode() && !isLive && savedRole && savedUser) {
      const resolvedRole = VALID_ROLES.includes(savedRole) ? savedRole : "admin";
      // Set DEMO_TOKEN — the demo token constant
      const demoToken = DEMO_TOKEN;
      localStorage.setItem("kyro_token", demoToken);
      setToken(demoToken);
      setRole(resolvedRole);
      setUsername(savedUser);
      setHydrated(true);
      return;
    }

    // Real mode — read from a real JWT token
    const stored = localStorage.getItem("kyro_token");
    if (stored && !stored.includes("demo_signature_not_verified") && stored.split(".").length === 3) {
      try {
        const payload = JSON.parse(atob(stored.split(".")[1]));
        if (payload.sub && payload.exp && payload.exp * 1000 > Date.now()) {
          setToken(stored);
          setRole(decodeRole(stored));
          setUsername(payload.sub ?? "");
        } else {
          // Expired or invalid — clear it
          localStorage.removeItem("kyro_token");
        }
      } catch {
        localStorage.removeItem("kyro_token");
      }
    }
    setHydrated(true);
  }, []);

  // Listen for role changes (demo mode only, not when in live mode)
  useEffect(() => {
    if (!inDemoMode()) return;

    function onCustom(e: Event) {
      if (isLiveMode()) return;
      const r = (e as CustomEvent).detail?.role as Role;
      if (r && VALID_ROLES.includes(r)) setRole(r);
    }

    function onStorage(e: StorageEvent) {
      if (isLiveMode()) return;
      if (e.key === "kyro_demo_role" && e.newValue) {
        const r = e.newValue as Role;
        if (VALID_ROLES.includes(r)) setRole(r);
      }
    }

    window.addEventListener("kyro_role_changed", onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("kyro_role_changed", onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    // Check if user explicitly chose live mode from the login screen
    const forceLive = isLiveMode();

    if (inDemoMode() && !forceLive) {
      let resolvedRole: Role = "viewer";
      try {
        const saved = JSON.parse(localStorage.getItem("kyro_demo_users") ?? "[]");
        const match = saved.find((u: any) => u.username === username && u.is_active);
        if (match) {
          resolvedRole = match.role as Role;
        } else {
          const hardcoded: Record<string, Role> = {
            "admin":        "admin",
            "sarah.usher":  "operator",
            "james.viewer": "viewer",
          };
          resolvedRole = hardcoded[username] ?? "viewer";
        }
      } catch {
        resolvedRole = "admin";
      }
      localStorage.setItem("kyro_token", DEMO_TOKEN);
      localStorage.setItem("kyro_demo_role", resolvedRole);
      localStorage.setItem("kyro_demo_last_user", username);
      setToken(DEMO_TOKEN);
      setRole(resolvedRole);
      setUsername(username);
      return true;
    }

    // Real backend login — used when DEMO_MODE=false OR user chose live mode
    setIsLoading(true);
    setError(null);
    try {
      const res = await authApi.login(username, password);
      localStorage.setItem("kyro_token", res.access_token);
      // Clear any stale demo session data so it doesn't contaminate role detection
      localStorage.removeItem("kyro_demo_role");
      localStorage.removeItem("kyro_demo_last_user");
      setToken(res.access_token);
      const realRole = decodeRole(res.access_token);
      setRole(realRole);
      try {
        const payload = JSON.parse(atob(res.access_token.split(".")[1]));
        setUsername(payload.sub ?? username);
      } catch { setUsername(username); }
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Login failed");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("kyro_token");
    localStorage.removeItem("kyro_demo_role");
    localStorage.removeItem("kyro_demo_last_user");
    localStorage.removeItem("kyro_mode"); // clear mode so login screen shows fresh
    sessionStorage.removeItem("kyro_live_mode");
    sessionStorage.setItem("kyro_signed_out", "1");
    setToken(null);
    setRole("viewer");
    window.location.href = "/login";
  }, []);

  return {
    token,
    role,
    username,
    isAuthenticated: hydrated && !!token,
    isLoading,
    error,
    canViewAttendance: role === "admin" || role === "operator",
    login,
    logout,
  };
}
