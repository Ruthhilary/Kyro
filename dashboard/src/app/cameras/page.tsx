"use client";

import { FormEvent, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { useCameras } from "@/hooks/useCameras";
import { camerasApi } from "@/lib/api";

export default function CamerasPage() {
  const { cameras, loading, refresh } = useCameras();
  const [name, setName]         = useState("");
  const [url, setUrl]           = useState("");
  const [location, setLocation] = useState("");
  const [adding, setAdding]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      await camerasApi.create({ name, stream_url: url, location: location || undefined });
      setName(""); setUrl(""); setLocation("");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <Sidebar />
      <main className="flex-1 p-6">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Cameras</h1>
          <p className="text-sm text-gray-400">Manage camera feeds — each runs its own vision worker</p>
        </div>

        {/* Add camera form */}
        <form
          onSubmit={handleAdd}
          className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 flex flex-wrap gap-3 items-end"
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Name</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)} required
              placeholder="Main Auditorium"
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-44"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Stream URL</label>
            <input
              value={url} onChange={(e) => setUrl(e.target.value)} required
              placeholder="rtsp://… or 0"
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-56"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Location (optional)</label>
            <input
              value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="Left balcony"
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-40"
            />
          </div>
          <button
            type="submit" disabled={adding}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg px-4 py-2 font-medium"
          >
            {adding ? "Adding…" : "+ Add Camera"}
          </button>
          {error && <p className="text-red-400 text-xs w-full">{error}</p>}
        </form>

        {/* Camera list */}
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : cameras.length === 0 ? (
          <p className="text-gray-600 text-sm">No cameras registered yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {cameras.map((cam) => (
              <div
                key={cam.camera_id}
                className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-white">{cam.name}</p>
                  <p className="text-xs text-gray-500">
                    {cam.camera_id} · {cam.location ?? "No location"} ·{" "}
                    <span className="font-mono">{cam.stream_url}</span>
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    cam.is_active
                      ? "bg-green-900/30 text-green-400 border border-green-800"
                      : "bg-gray-800 text-gray-500"
                  }`}
                >
                  {cam.is_active ? "Active" : "Inactive"}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Worker run instructions */}
        <div className="mt-8 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <p className="text-xs font-semibold text-gray-400 mb-2">Starting a worker for a camera</p>
          <pre className="text-xs text-indigo-300 font-mono whitespace-pre-wrap">
{`# Basic (demo seat layout)
python -m ai.worker --camera-id <camera_id> --stream <rtsp://... or 0>

# With saved layout
python -m ai.worker --camera-id <camera_id> --stream <url> --layout-id <id> --api-key <key>

# Multiple cameras — run one worker per camera in separate terminals`}
          </pre>
        </div>
      </main>
    </div>
  );
}
