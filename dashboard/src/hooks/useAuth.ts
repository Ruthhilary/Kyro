"use client";

import { useCallback, useEffect, useState } from "react";
import { authApi, ApiError } from "@/lib/api";

interface AuthState {
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

export function useAuth(): AuthState {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rehydrate token from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("kyro_token");
    if (stored) setToken(stored);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await authApi.login(username, password);
      localStorage.setItem("kyro_token", res.access_token);
      setToken(res.access_token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Login failed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("kyro_token");
    setToken(null);
  }, []);

  return {
    token,
    isAuthenticated: !!token,
    isLoading,
    error,
    login,
    logout,
  };
}
