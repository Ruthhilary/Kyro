"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { DEMO_MODE } from "@/lib/demo";

function isLiveMode(): boolean { if (typeof window === "undefined") return false; return localStorage.getItem("kyro_mode") === "live"; }
const inDemoMode = () => typeof window !== "undefined" && localStorage.getItem("kyro_mode") === "demo";

export default function RootPage() {
  const { canViewAttendance, isAuthenticated } = useAuth();
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => { setHydrated(true); }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (inDemoMode()) { router.replace("/attendance"); return; }
    if (!isAuthenticated) { router.replace("/login"); return; }
    router.replace(canViewAttendance ? "/attendance" : "/seating");
  }, [hydrated, isAuthenticated, canViewAttendance, router]);

  return null;
}
