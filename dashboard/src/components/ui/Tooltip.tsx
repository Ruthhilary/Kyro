"use client";

import { useState } from "react";
import { Info } from "lucide-react";

export function InfoTooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        className="text-gray-600 hover:text-gray-300 transition-colors focus:outline-none"
        aria-label="More information"
      >
        <Info size={13} />
      </button>

      {visible && (
        <span
          style={{ right: 0, bottom: "calc(100% + 8px)", width: "260px" }}
          className="absolute z-50 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2.5 text-xs text-gray-200 shadow-xl pointer-events-none normal-case tracking-normal font-normal leading-relaxed whitespace-normal"
        >
          {text}
          <span
            style={{ right: "8px", top: "100%" }}
            className="absolute border-4 border-transparent border-t-gray-700"
          />
        </span>
      )}
    </span>
  );
}
