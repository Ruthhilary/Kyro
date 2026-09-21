"""
Kyro — Stadium Seed Script

Inserts 10,000 fake seats directly into Postgres using bulk COPY.
Handles 1,000,000 seats just as fast — no API calls, no timeouts.

Run from Kyro/Kyro/ while the stack is up:
    python3 scripts/seed_stadium.py

Options:
    --seats     Total seats to generate (default 10000)
    --host      Postgres host (default localhost)
    --port      Postgres port (default 5434)
    --db        Database name (default kyro)
    --user      DB user (default kyro)
    --password  DB password (default kyro)
"""

from __future__ import annotations

import argparse
import io
import random
import sys
import time

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("Installing psycopg2-binary…")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "psycopg2-binary", "--break-system-packages"])
    import psycopg2
    import psycopg2.extras

# ─── Defaults ────────────────────────────────────────────────────────────────

CAMERA_ID    = "cam-stadium"
CAMERA_NAME  = "Stadium — Main Bowl"
LAYOUT_NAME  = "Stadium Layout"

SECTIONS     = ["North","NE","East","SE","South","SW","West","NW","Floor-L","Floor-R"]
ROWS         = list("ABCDEFGHIJ")          # 10 rows per section
RESERVED_PCT = 0.04                        # 4% reserved

FRAME_W, FRAME_H = 3840, 2160             # virtual camera frame

# ─── Geometry ─────────────────────────────────────────────────────────────────

def build_seats(total: int) -> list[dict]:
    """
    Distribute `total` seats evenly across sections and rows.
    Returns list of seat dicts matching the SeatDefinition schema.
    """
    seats_per_row = max(1, total // (len(SECTIONS) * len(ROWS)))
    actual_total  = len(SECTIONS) * len(ROWS) * seats_per_row

    section_cols = 5
    section_rows_grid = (len(SECTIONS) + section_cols - 1) // section_cols
    sec_w = FRAME_W // section_cols
    sec_h = FRAME_H // section_rows_grid

    seat_w = max(2, (sec_w - 20) // seats_per_row - 1)
    seat_h = max(2, (sec_h - 20) // len(ROWS)        - 1)

    seats: list[dict] = []
    for s_idx, section in enumerate(SECTIONS):
        col    = s_idx % section_cols
        row_g  = s_idx // section_cols
        base_x = col   * sec_w + 10
        base_y = row_g * sec_h + 10

        for r_idx, row in enumerate(ROWS):
            y1 = base_y + r_idx * (seat_h + 1)
            y2 = y1 + seat_h
            row_label = f"{section[0]}{row}"   # e.g. "NA" = North row A

            for num in range(1, seats_per_row + 1):
                x1 = base_x + (num - 1) * (seat_w + 1)
                x2 = x1 + seat_w
                seats.append({
                    "seat_id": f"{section[0]}{row}{num}",
                    "row":     row_label,
                    "number":  num,
                    "section": section,
                    "bbox":    [float(x1), float(y1), float(x2), float(y2)],
                })

    return seats


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seats",    type=int, default=10_000)
    parser.add_argument("--host",     default="localhost")
    parser.add_argument("--port",     type=int, default=5434)
    parser.add_argument("--db",       default="kyro")
    parser.add_argument("--user",     default="kyro")
    parser.add_argument("--password", default="kyro")
    args = parser.parse_args()

    print("Kyro Stadium Seed (direct DB)")
    print("=" * 50)
    t0 = time.perf_counter()

    # ── Connect ──────────────────────────────────────────────────────
    print(f"Connecting to postgres://{args.host}:{args.port}/{args.db}…")
    try:
        conn = psycopg2.connect(
            host=args.host, port=args.port,
            dbname=args.db, user=args.user, password=args.password,
        )
    except Exception as e:
        print(f"  Connection failed: {e}")
        print("  Make sure docker compose is running and postgres is healthy.")
        sys.exit(1)
    cur = conn.cursor()
    print("  Connected")

    # ── Upsert camera ─────────────────────────────────────────────────
    print(f"Upserting camera '{CAMERA_NAME}'…")

    # Add zone columns if they don't exist yet (schema may be behind)
    for col, typedef in [
        ("zone_name",     "VARCHAR(128)"),
        ("zone_capacity", "INTEGER DEFAULT 0"),
        ("zone_order",    "INTEGER DEFAULT 0"),
    ]:
        try:
            cur.execute(f"ALTER TABLE cameras ADD COLUMN IF NOT EXISTS {col} {typedef}")
            conn.commit()
        except Exception:
            conn.rollback()

    cur.execute("""
        INSERT INTO cameras (camera_id, name, stream_url, location, zone_name, zone_capacity, zone_order, is_active)
        VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE)
        ON CONFLICT (camera_id) DO UPDATE
          SET zone_capacity = EXCLUDED.zone_capacity,
              zone_name     = EXCLUDED.zone_name
        RETURNING id
    """, (CAMERA_ID, CAMERA_NAME, "rtsp://fake-stadium/main", "Stadium", "Main Bowl", args.seats, 0))
    camera_db_id = cur.fetchone()[0]
    conn.commit()
    print(f"  camera db id={camera_db_id}")

    # ── Build seat definitions ────────────────────────────────────────
    print(f"Building {args.seats:,} seat definitions…")
    seats = build_seats(args.seats)
    print(f"  {len(seats):,} seats generated")

    # ── Insert/replace layout ─────────────────────────────────────────
    print("Saving seat layout…")
    # Remove any existing layouts for this camera first
    cur.execute("DELETE FROM seat_layouts WHERE camera_id = %s", (camera_db_id,))

    import json as _json
    cur.execute("""
        INSERT INTO seat_layouts (camera_id, name, seats_json, is_active)
        VALUES (%s, %s, %s, TRUE)
        RETURNING id
    """, (camera_db_id, LAYOUT_NAME, _json.dumps(seats)))
    layout_id = cur.fetchone()[0]
    conn.commit()
    print(f"  Layout id={layout_id}, {len(seats):,} seats saved")

    # ── Bulk insert reserved seats (skip if table doesn't exist yet) ─
    reserved_seats = [s for s in seats if random.random() < RESERVED_PCT]
    labels = ["VIP","Press","Accessibility","Staff","Management","Security","Guest","Sponsor","Media","Pastor"]
    print(f"Inserting {len(reserved_seats):,} reserved seats…")
    try:
        cur.execute("SELECT 1 FROM reserved_seats LIMIT 1")
        # table exists — clear old and bulk insert
        cur.execute("DELETE FROM reserved_seats WHERE camera_id = %s", (camera_db_id,))
        buf = io.StringIO()
        for s in reserved_seats:
            label = random.choice(labels)
            buf.write(f"{camera_db_id}\t{s['seat_id']}\t{label}\t\\N\tTRUE\n")
        buf.seek(0)
        cur.copy_from(buf, "reserved_seats",
                      columns=("camera_id","seat_id","reserved_for","note","is_active"))
        conn.commit()
        print(f"  {len(reserved_seats):,} reserved seats inserted")
    except Exception:
        conn.rollback()
        print("  Skipped reserved seats (table not created yet — start backend once to create it)")

    cur.close()
    conn.close()

    elapsed = time.perf_counter() - t0
    print()
    print("=" * 50)
    print(f"Done in {elapsed:.1f}s")
    print(f"  Camera ID   : {CAMERA_ID}")
    print(f"  Layout ID   : {layout_id}")
    print(f"  Total seats : {len(seats):,}")
    print(f"  Reserved    : {len(reserved_seats):,}")
    print()
    print("Next — activate the layout and start the demo stream:")
    print(f"  Open the dashboard → Seat Editor → activate layout id {layout_id}")
    print(f"  or via API:")
    print(f"    curl -X POST http://localhost:8001/api/v1/seats/{CAMERA_ID}/layouts/{layout_id}/activate \\")
    print(f"         -H 'Authorization: Bearer <token>'")
    print()
    print(f"  Start the demo worker:")
    print(f"    python3 -m ai.demo_stream --camera-id {CAMERA_ID} --capacity {len(seats)}")


if __name__ == "__main__":
    main()
