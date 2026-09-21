"use client";

import { useReviewContext } from "@/lib/ReviewContext";
import { ReviewPanel } from "@/components/ui/ReviewPanel";

/**
 * Mounted once in the root layout.
 * Always rendered — ReviewPanel manages its own visibility.
 * The unanswered panel persists even when no new live questions are active.
 */
export function GlobalReviewOverlay() {
  const { reviews, dismissReview, activeCameraId } = useReviewContext();

  return (
    <ReviewPanel
      reviews={reviews}
      cameraId={activeCameraId}
      onDismiss={dismissReview}
    />
  );
}
