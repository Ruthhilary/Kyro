"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useAnimatedCounter } from "@/hooks/useAnimatedCounter";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  highlight?: boolean;
  /** Duration of the roll animation in ms. Default 700ms. */
  animationDuration?: number;
}

export function StatCard({
  label,
  value,
  icon,
  highlight = false,
  animationDuration = 700,
}: StatCardProps) {
  const isNumeric = typeof value === "number";
  const animated = useAnimatedCounter(isNumeric ? value : 0, animationDuration);

  // Track previous value to show up/down trend arrow
  const prevRef = useRef<number>(isNumeric ? value : 0);
  const trend = isNumeric
    ? value > prevRef.current
      ? "up"
      : value < prevRef.current
      ? "down"
      : "flat"
    : "flat";

  useEffect(() => {
    if (isNumeric) prevRef.current = value;
  }, [value, isNumeric]);

  const displayValue = isNumeric ? animated : value;

  return (
    <div
      className={`rounded-xl border p-5 flex flex-col gap-2 transition-colors ${
        highlight
          ? "bg-indigo-600 border-indigo-500 text-white"
          : "bg-gray-900 border-gray-800 text-gray-100"
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-sm font-medium ${
            highlight ? "text-indigo-200" : "text-gray-400"
          }`}
        >
          {label}
        </span>
        {icon && <span className="opacity-70">{icon}</span>}
      </div>

      <div className="flex items-end gap-2">
        <span className="text-3xl font-bold tracking-tight tabular-nums">
          {typeof displayValue === "number"
            ? displayValue.toLocaleString()
            : displayValue}
        </span>

        {/* Trend arrow — only for numeric values that changed */}
        {isNumeric && trend !== "flat" && (
          <span
            className={`text-sm font-semibold mb-1 transition-opacity ${
              trend === "up"
                ? highlight
                  ? "text-green-300"
                  : "text-green-400"
                : highlight
                ? "text-red-300"
                : "text-red-400"
            }`}
          >
            {trend === "up" ? "↑" : "↓"}
          </span>
        )}
      </div>
    </div>
  );
}
