"use client";

import { useEffect, useState } from "react";
import { camerasApi } from "@/lib/api";
import type { Camera } from "@/types";

export function useCameras() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      setCameras(await camerasApi.list());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  return { cameras, loading, error, refresh };
}
