import type { SeatDefinition } from "@/types";

/**
 * Auto-generates a seat layout grid from a capacity number.
 * Creates rows and seats that approximate a real auditorium layout.
 * Used when a camera is first registered so the seat map works immediately.
 */
export function generateSeatsFromCapacity(capacity: number): SeatDefinition[] {
  if (capacity <= 0) return [];

  // Typical church row sizes
  const seatsPerRow =
    capacity <= 50  ? 10 :
    capacity <= 150 ? 13 :
    capacity <= 400 ? 14 : 16;

  const numRows = Math.ceil(capacity / seatsPerRow);
  const alpha   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const seats: SeatDefinition[] = [];
  let count = 0;

  // Frame dimensions — matches the camera frame the AI uses
  const W = 1280, H = 720;
  const stageH    = 80;          // space reserved for stage at top
  const usableH   = H - stageH - 40;
  const rowSpacing = Math.floor(usableH / (numRows + 1));
  const seatW     = Math.floor((W - 80) / seatsPerRow);
  const seatH     = Math.min(30, rowSpacing - 6);

  for (let r = 0; r < numRows && count < capacity; r++) {
    const rowLabel    = r < 26 ? alpha[r] : alpha[Math.floor(r / 26) - 1] + alpha[r % 26];
    const seatsThisRow = Math.min(seatsPerRow, capacity - count);
    const rowX        = Math.floor((W - seatsThisRow * seatW) / 2);
    const rowY        = stageH + rowSpacing * (r + 1);

    for (let n = 1; n <= seatsThisRow; n++) {
      const x1 = rowX + (n - 1) * seatW + 2;
      const y1 = rowY;
      seats.push({
        seat_id: `${rowLabel}${n}`,
        row:     rowLabel,
        number:  n,
        section: "Main",
        bbox:    [x1, y1, x1 + seatW - 4, y1 + seatH],
      });
      count++;
    }
  }

  return seats;
}
