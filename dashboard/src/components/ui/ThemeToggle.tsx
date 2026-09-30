"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

interface Props {
  /** Compact icon-only button for the sidebar; full button with label otherwise. */
  compact?: boolean;
  className?: string;
}

export function ThemeToggle({ compact = false, className = "" }: Props) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  const label  = isDark ? "Light mode" : "Dark mode";
  const Icon   = isDark ? Sun : Moon;

  if (compact) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${className}`}
        style={{ background: "var(--bg-hover)", color: "var(--text-primary)" }}
      >
        <Icon size={16} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${className}`}
      style={{ background: "var(--bg-hover)", color: "var(--text-primary)", border: "1px solid var(--border-subtle)" }}
    >
      <Icon size={15} />
      <span>{label}</span>
    </button>
  );
}
