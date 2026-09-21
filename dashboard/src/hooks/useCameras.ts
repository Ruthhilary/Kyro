"use client";

// useCameras is now a thin wrapper around the shared CameraContext
// so all pages see the same camera list and updates persist across navigation.
import { useCameraContext } from "@/lib/CameraContext";

export function useCameras() {
  return useCameraContext();
}
