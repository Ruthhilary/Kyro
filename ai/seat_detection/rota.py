"""
Kyro — Service Rota

The rota tells the AI who is scheduled to be on stage and when.
While a person is on the rota for a given time window:
  - Their seat is held as ROTA_HOLD — it won't flip to available
  - They ARE still counted for overall attendance (they're in the building)
  - Once their window ends, normal vacancy timeout resumes

Example rota entries:
  - Choir on stage: 10:00–10:20, rows B-D held
  - Pastor preaching: 10:30–11:30, seat "D7" held
  - Welcome team at front: 09:45–10:05, rows A held

The rota is loaded from JSON (stored in Redis / DB) and checked every frame.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RotaEntry:
    """
    A single scheduled stage appearance.

    Attributes:
        entry_id:       Unique ID for this rota slot
        label:          Description, e.g. "Choir", "Pastor John"
        start_epoch:    Unix timestamp when the person goes on stage
        end_epoch:      Unix timestamp when they return to their seat
        seat_ids:       Specific seat IDs to hold (e.g. ["D7", "D8"])
        rows:           Entire rows to hold (e.g. ["B", "C", "D"] for choir)
        section:        Section name to hold (overrides rows if set)
    """
    entry_id:    str
    label:       str
    start_epoch: float
    end_epoch:   float
    seat_ids:    list[str] = field(default_factory=list)
    rows:        list[str] = field(default_factory=list)
    section:     Optional[str] = None

    @property
    def is_active(self) -> bool:
        now = time.time()
        return self.start_epoch <= now <= self.end_epoch

    @property
    def is_upcoming(self) -> bool:
        return time.time() < self.start_epoch

    @property
    def has_ended(self) -> bool:
        return time.time() > self.end_epoch

    def affects_seat(self, seat_id: str, row: str, section: Optional[str]) -> bool:
        """True if this rota entry should hold the given seat."""
        if seat_id in self.seat_ids:
            return True
        if row in self.rows:
            return True
        if self.section and section and self.section == section:
            return True
        return False

    def to_dict(self) -> dict:
        return {
            "entry_id":    self.entry_id,
            "label":       self.label,
            "start_epoch": self.start_epoch,
            "end_epoch":   self.end_epoch,
            "seat_ids":    self.seat_ids,
            "rows":        self.rows,
            "section":     self.section,
            "is_active":   self.is_active,
        }


class RotaManager:
    """
    Manages the service rota for one camera/zone.

    Usage:
        rota = RotaManager()
        rota.load([RotaEntry(...), ...])

        # Every frame — call before seat occupancy update
        held_seats = rota.get_held_seat_ids()  # set of seat_ids to hold
        held_rows  = rota.get_held_rows()       # set of row labels to hold
    """

    def __init__(self) -> None:
        self._entries: list[RotaEntry] = []

    def load(self, entries: list[RotaEntry]) -> None:
        self._entries = entries

    def add(self, entry: RotaEntry) -> None:
        # Replace if same entry_id exists
        self._entries = [e for e in self._entries if e.entry_id != entry.entry_id]
        self._entries.append(entry)

    def remove(self, entry_id: str) -> None:
        self._entries = [e for e in self._entries if e.entry_id != entry_id]

    @property
    def active_entries(self) -> list[RotaEntry]:
        return [e for e in self._entries if e.is_active]

    def get_held_seat_ids(self) -> set[str]:
        held: set[str] = set()
        for entry in self.active_entries:
            held.update(entry.seat_ids)
        return held

    def get_held_rows(self) -> set[str]:
        held: set[str] = set()
        for entry in self.active_entries:
            held.update(entry.rows)
        return held

    def get_held_sections(self) -> set[str]:
        held: set[str] = set()
        for entry in self.active_entries:
            if entry.section:
                held.add(entry.section)
        return held

    def seat_is_held(self, seat_id: str, row: str, section: Optional[str]) -> bool:
        """True if any active rota entry holds this seat."""
        return any(e.affects_seat(seat_id, row, section) for e in self.active_entries)

    def all_entries(self) -> list[dict]:
        return [e.to_dict() for e in self._entries]
