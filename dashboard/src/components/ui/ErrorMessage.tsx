"use client";

import { AlertTriangle, RefreshCw, Wifi, WifiOff } from "lucide-react";

interface ErrorMessageProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

/**
 * Visible error state — replaces blank screens when API calls fail.
 * Shows what went wrong and gives the user an action to take.
 */
export function ErrorMessage({ title = "Something went wrong", message, onRetry }: ErrorMessageProps) {
  const isNetwork = message.toLowerCase().includes("networkerror")
    || message.toLowerCase().includes("failed to fetch")
    || message.toLowerCase().includes("fetch");

  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-4">
      <div className="w-12 h-12 rounded-xl flex items-center justify-center"
        style={{ background: "rgba(239,68,68,0.12)" }}>
        {isNetwork
          ? <WifiOff size={22} className="text-red-400" />
          : <AlertTriangle size={22} className="text-red-400" />}
      </div>
      <div>
        <p className="text-sm font-semibold text-white mb-1">{title}</p>
        <p className="text-xs text-gray-500 max-w-xs leading-relaxed">
          {isNetwork
            ? "Can't reach the backend. Make sure the server is running on port 8000."
            : message}
        </p>
      </div>
      {onRetry && (
        <button onClick={onRetry}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors">
          <RefreshCw size={12} /> Try again
        </button>
      )}
    </div>
  );
}
