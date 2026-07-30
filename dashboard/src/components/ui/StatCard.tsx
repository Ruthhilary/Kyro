import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  highlight?: boolean;
}

export function StatCard({ label, value, icon, highlight = false }: StatCardProps) {
  return (
    <div
      className={`rounded-xl border p-5 flex flex-col gap-2 ${
        highlight
          ? "bg-indigo-600 border-indigo-500 text-white"
          : "bg-gray-900 border-gray-800 text-gray-100"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${highlight ? "text-indigo-200" : "text-gray-400"}`}>
          {label}
        </span>
        {icon && <span className="opacity-70">{icon}</span>}
      </div>
      <span className="text-3xl font-bold tracking-tight">{value}</span>
    </div>
  );
}
