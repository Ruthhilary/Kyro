"use client";

import { useCameras } from "@/hooks/useCameras";
import type { Camera } from "@/types";

interface CameraSwitcherProps {
  activeCameraId: string;
  onChange: (id: string) => void;
}

export function CameraSwitcher({ activeCameraId, onChange }: CameraSwitcherProps) {
  const { cameras, loading } = useCameras();

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <span className="animate-spin">⟳</span> Loading cameras…
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 shrink-0">Camera</span>
      <select
        value={activeCameraId}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {cameras.length === 0 && (
          <option value="cam-01">cam-01 (demo)</option>
        )}
        {cameras.map((cam: Camera) => (
          <option key={cam.camera_id} value={cam.camera_id}>
            {cam.name} — {cam.location ?? cam.camera_id}
          </option>
        ))}
      </select>
    </div>
  );
}
