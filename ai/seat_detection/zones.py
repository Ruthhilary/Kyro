"""
Kyro — Exclusion Zones

Exclusion zones define areas in the camera frame where detected persons
should NOT affect seat availability — e.g. the stage, the front area
people rush to when the pastor arrives, or the choir area.

When any person is detected inside an exclusion zone:
  - Seats that overlap the zone stay in their current state (no vacancy transition)
  - People in the zone are still counted for attendance (they ARE present)
  - But their seat back in the main seating area is NOT freed

Usage:
    zones = [ExclusionZone("stage", bbox=[100, 0, 1180, 200], label="Stage")]
    engine = SeatOccupancyEngine(seats, cfg, exclusion_zones=zones)
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Zone *behavior* is driven by this explicit type, never by the free-text
# label. The label ("Choir", "Altar", "Toilet", whatever the operator types)
# is display-only — Kyro does not parse it for meaning.
#
#   hold_seats — seats overlapping the zone (or in hold_seats_in_rows) stay
#                held while anyone is detected inside it. Use for the stage,
#                altar, choir loft, or any area near seating where people
#                gather without actually leaving their seat for good.
#   ignore     — the zone is purely informational. People detected inside it
#                never hold or affect any seat, regardless of overlap. Use
#                for exits, doorways, toilets, walkways — places where a
#                detection should NOT be interpreted as "still in their seat".
ZONE_TYPES = ("hold_seats", "ignore")
DEFAULT_ZONE_TYPE = "hold_seats"

# Convenience presets an editor UI can offer instead of a raw label field.
# Each preset pins BOTH a sensible default label and the zone_type that
# actually controls behavior, so picking "Toilet / break area" can't
# accidentally end up with hold_seats behavior just because someone typed
# a different word.
ZONE_PRESETS: dict[str, dict[str, str]] = {
    "stage":     {"label": "Stage",              "zone_type": "hold_seats"},
    "altar":     {"label": "Altar",               "zone_type": "hold_seats"},
    "choir":     {"label": "Choir",                "zone_type": "hold_seats"},
    "entrance_exit": {"label": "Entrance / Exit",  "zone_type": "ignore"},
    "toilet":    {"label": "Toilet / break area",  "zone_type": "ignore"},
    "custom":    {"label": "Zone",                 "zone_type": "hold_seats"},
}


@dataclass
class ExclusionZone:
    """
    A rectangular region in the camera frame.

    Attributes:
        zone_id:   Unique identifier, e.g. "stage", "front-rush", "choir"
        bbox:      [x1, y1, x2, y2] in frame pixels
        label:     Human-readable name shown in UI. Display only — does NOT
                   drive behavior. Two zones named identically can have
                   different zone_type, and two zones with different names
                   can behave identically.
        zone_type: One of ZONE_TYPES. This — not the label — decides what
                   the zone actually does. Defaults to "hold_seats" (the
                   original/legacy behavior) for backward compatibility.
        hold_seats_in_rows: Optional list of row labels whose seats should be
                            held even when the person's seat is NOT physically
                            inside the zone bbox. Used for e.g. choir rows.
                            Only meaningful when zone_type == "hold_seats".
    """
    zone_id: str
    bbox: np.ndarray          # shape (4,)
    label: str = ""
    zone_type: str = DEFAULT_ZONE_TYPE
    hold_seats_in_rows: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.zone_type not in ZONE_TYPES:
            # Unknown/legacy value — fail safe to the original behavior
            # rather than silently dropping the zone's effect.
            self.zone_type = DEFAULT_ZONE_TYPE

    @property
    def holds_seats(self) -> bool:
        """True if this zone should hold overlapping/row-matched seats."""
        return self.zone_type == "hold_seats"

    def contains_point(self, x: float, y: float) -> bool:
        """True if (x, y) falls inside this zone."""
        x1, y1, x2, y2 = self.bbox
        return x1 <= x <= x2 and y1 <= y <= y2

    def contains_bbox(self, bbox: np.ndarray, overlap_threshold: float = 0.3) -> bool:
        """
        True if bbox overlaps this zone by at least overlap_threshold (IoU).
        Used to tag seats as in_exclusion_zone at layout-load time.
        """
        bx1, by1, bx2, by2 = bbox
        zx1, zy1, zx2, zy2 = self.bbox

        ix1 = max(bx1, zx1); iy1 = max(by1, zy1)
        ix2 = min(bx2, zx2); iy2 = min(by2, zy2)
        inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
        if inter == 0:
            return False

        area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
        # Use seat area as denominator — any significant overlap of the seat counts
        return (inter / area_b) >= overlap_threshold if area_b > 0 else False

    def any_person_inside(self, person_bboxes: list[np.ndarray]) -> bool:
        """True if at least one tracked person's centre is inside this zone."""
        for bbox in person_bboxes:
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            if self.contains_point(cx, cy):
                return True
        return False

    def to_dict(self) -> dict:
        return {
            "zone_id":             self.zone_id,
            "bbox":                self.bbox.tolist(),
            "label":               self.label,
            "zone_type":           self.zone_type,
            "hold_seats_in_rows":  self.hold_seats_in_rows,
        }
