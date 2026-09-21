"use client";

import { useCallback, useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

type PermissionState = "default" | "granted" | "denied" | "unsupported";

export interface PushState {
  supported:   boolean;
  permission:  PermissionState;
  subscribed:  boolean;
  loading:     boolean;
  error:       string | null;
  subscribe:   (opts?: { warnThreshold?: number; critThreshold?: number; notifyOffline?: boolean }) => Promise<void>;
  unsubscribe: () => Promise<void>;
  sendTest:    () => Promise<void>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr.buffer;
}

/** Get the best available auth token — real stored token first, then demo real token. */
async function getBestToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;

  const stored = localStorage.getItem("kyro_token");
  if (stored && !stored.includes("demo_signature_not_verified")) return stored;

  // Demo mode: check cached real token
  const cached = localStorage.getItem("kyro_real_token");
  if (cached) return cached;

  // Demo mode: fetch a real token now
  const user = process.env.NEXT_PUBLIC_DEMO_USER;
  const pass = process.env.NEXT_PUBLIC_DEMO_PASS;
  if (!user || !pass) return null;

  try {
    const res = await fetch(`${API_URL}/api/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const token = data.access_token as string;
    localStorage.setItem("kyro_real_token", token);
    return token;
  } catch {
    return null;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getBestToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

async function fetchVapidKey(): Promise<string> {
  const res = await fetch(`${API_URL}/api/v1/push/vapid-public-key`);
  if (!res.ok) throw new Error("Could not fetch VAPID key");
  return (await res.json()).publicKey as string;
}

async function registerWithBackend(
  sub: PushSubscription,
  opts: { warnThreshold: number; critThreshold: number; notifyOffline: boolean },
): Promise<void> {
  const json = sub.toJSON();
  const headers = await authHeader();
  const res = await fetch(`${API_URL}/api/v1/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      endpoint:       json.endpoint,
      keys:           json.keys,
      warn_threshold: opts.warnThreshold,
      crit_threshold: opts.critThreshold,
      notify_offline: opts.notifyOffline,
    }),
  });
  if (!res.ok) {
    // If 401, token may have expired — clear cache and retry once
    if (res.status === 401) {
      localStorage.removeItem("kyro_real_token");
      const freshHeaders = await authHeader();
      const retry = await fetch(`${API_URL}/api/v1/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...freshHeaders },
        body: JSON.stringify({
          endpoint:       json.endpoint,
          keys:           json.keys,
          warn_threshold: opts.warnThreshold,
          crit_threshold: opts.critThreshold,
          notify_offline: opts.notifyOffline,
        }),
      });
      if (!retry.ok) throw new Error((await retry.json().catch(() => ({}))).detail ?? "Failed to save subscription");
      return;
    }
    throw new Error((await res.json().catch(() => ({}))).detail ?? "Failed to save subscription");
  }
}

async function unregisterFromBackend(endpoint: string): Promise<void> {
  const headers = await authHeader();
  await fetch(
    `${API_URL}/api/v1/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`,
    { method: "DELETE", headers },
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function usePushNotifications(): PushState {
  const [supported,  setSupported]  = useState(false);
  const [permission, setPermission] = useState<PermissionState>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // On mount: detect support, read permission, and check if already subscribed
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSupported(false);
      return;
    }
    setSupported(true);
    setPermission(Notification.permission as PermissionState);

    // Use navigator.serviceWorker.ready so we wait for the SW to be fully active
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((existing) => {
        if (existing) {
          setSubscribed(true);
          setPermission("granted"); // if they have a sub, permission must be granted
          // Silently re-register with backend in case it was missed
          registerWithBackend(existing, {
            warnThreshold: 0.80, critThreshold: 0.90, notifyOffline: true,
          }).catch(() => {});
        } else {
          setSubscribed(false);
        }
      })
      .catch(() => {});
  }, []);

  const subscribe = useCallback(async (opts?: {
    warnThreshold?: number; critThreshold?: number; notifyOffline?: boolean;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const reg = await getRegistration();

      const perm = await Notification.requestPermission();
      setPermission(perm as PermissionState);
      if (perm !== "granted") throw new Error("Permission denied — please allow notifications");

      const vapidKey = await fetchVapidKey();
      const pushSub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      await registerWithBackend(pushSub, {
        warnThreshold: opts?.warnThreshold ?? 0.80,
        critThreshold: opts?.critThreshold ?? 0.90,
        notifyOffline: opts?.notifyOffline ?? true,
      });

      setSubscribed(true);
      localStorage.setItem("kyro_push_subscribed", "1");

      // Fire a welcome push immediately so the user sees it works right away
      try {
        const headers = await authHeader();
        await fetch(
          `${API_URL}/api/v1/push/test?endpoint=${encodeURIComponent(pushSub.endpoint)}`,
          { method: "POST", headers },
        );
      } catch { /* non-fatal */ }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Subscribe failed";
      setError(msg);
      console.error("[Kyro Push] subscribe error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reg    = await getRegistration();
      const pushSub = await reg.pushManager.getSubscription();
      if (pushSub) {
        await unregisterFromBackend(pushSub.endpoint);
        await pushSub.unsubscribe();
      }
      setSubscribed(false);
      localStorage.removeItem("kyro_push_subscribed");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unsubscribe failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reg    = await getRegistration();
      const pushSub = await reg.pushManager.getSubscription();
      if (!pushSub) throw new Error("Not subscribed — click Turn on first");

      const headers = await authHeader();
      const res = await fetch(
        `${API_URL}/api/v1/push/test?endpoint=${encodeURIComponent(pushSub.endpoint)}`,
        { method: "POST", headers },
      );

      if (!res.ok) {
        // Retry once with fresh token
        if (res.status === 401) {
          localStorage.removeItem("kyro_real_token");
          const freshHeaders = await authHeader();
          const retry = await fetch(
            `${API_URL}/api/v1/push/test?endpoint=${encodeURIComponent(pushSub.endpoint)}`,
            { method: "POST", headers: freshHeaders },
          );
          if (!retry.ok) throw new Error((await retry.json().catch(() => ({}))).detail ?? "Test failed");
          return;
        }
        throw new Error((await res.json().catch(() => ({}))).detail ?? "Test push failed");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Test failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return { supported, permission, subscribed, loading, error, subscribe, unsubscribe, sendTest };
}
