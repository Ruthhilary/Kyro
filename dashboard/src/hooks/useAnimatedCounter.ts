"use client";

/**
 * useAnimatedCounter
 *
 * Smoothly animates a numeric value rolling up or down to a target.
 * Uses requestAnimationFrame for silky 60fps animation.
 *
 * @param target   - The number to animate toward
 * @param duration - Animation duration in ms (default 600ms)
 */

import { useEffect, useRef, useState } from "react";

export function useAnimatedCounter(
  target: number,
  duration = 600
): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // If target hasn't changed meaningfully, skip
    if (Math.abs(target - fromRef.current) < 0.001) return;

    const from = fromRef.current;
    startTimeRef.current = null;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }

    function easeOutCubic(t: number): number {
      return 1 - Math.pow(1 - t, 3);
    }

    function tick(timestamp: number) {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      const current = from + (target - from) * eased;

      setDisplay(Math.round(current));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        setDisplay(target);
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [target, duration]);

  return display;
}
