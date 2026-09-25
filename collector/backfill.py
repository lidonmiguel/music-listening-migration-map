"""Offline, resource-intensive full-dump backfill. Not part of GitHub Actions.

Stream a verified ListenBrainz full listens archive without extracting or publishing
its raw user histories. The output is a separate population/method series.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import itertools
import json
import re
import secrets
import sqlite3
import subprocess
import tarfile
import tempfile
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import networkx as nx

from collect import DATA, communities, layout
from weekly import VERSION, weeks_of_iso_year

MONTH_FILE = re.compile(r"(?:^|/)listens/(\d{4})/(\d{1,2})\.listens$")
UTC = timezone.utc


def mbids_for_listen(record: dict) -> list[str]:
    metadata = record.get("track_metadata") or {}
    mapping = metadata.get("mbid_mapping") or {}
    info = metadata.get("additional_info") or {}
    # A full dump may only contain client-supplied IDs. Prefer server-resolved
    # credits when present, and audit every fallback to unverified client IDs.
    values = mapping.get("artist_mbids") or info.get("artist_mbids") or (
        [info["artist_mbid"]] if info.get("artist_mbid") else [])
    if not isinstance(values, list):
        return []
    found = []
    for value in values:
        try:
            artist_id = str(uuid.UUID(value))
            if artist_id not in found:
                found.append(artist_id)
        except (ValueError, AttributeError, TypeError):
            continue
    return found


def eligible_weeks(year: int, captured: date) -> list[dict]:
    return [slot for slot in weeks_of_iso_year(year) if date.fromisoformat(slot["end_exclusive"]) <= captured]


def verify_archive(path: Path, expected_digest: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise ValueError("Supply the official archive SHA-256 digest")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_digest:
        raise ValueError("Full dump archive SHA-256 mismatch")
    return digest.hexdigest()


def prepare_db(connection: sqlite3.Connection) -> None:
    connection.executescript("""
        PRAGMA journal_mode=MEMORY;
        PRAGMA synchronous=OFF;
        CREATE TABLE totals (week TEXT, artist TEXT, listens INTEGER NOT NULL,
            PRIMARY KEY (week, artist)) WITHOUT ROWID;
        CREATE TABLE audience (week TEXT, person BLOB, artist TEXT, listens INTEGER NOT NULL,
            PRIMARY KEY (week, person, artist)) WITHOUT ROWID;
        CREATE TABLE names (artist TEXT PRIMARY KEY, name TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE quality (week TEXT PRIMARY KEY, missing_id INTEGER DEFAULT 0,
            missing_user INTEGER DEFAULT 0, input_rows INTEGER DEFAULT 0,
            client_submitted_id_rows INTEGER DEFAULT 0) WITHOUT ROWID;
    """)


def scan_archive(archive: Path, conn: sqlite3.Connection, year: int,
                 allowed: set[str]) -> set[tuple[int, int]]:
    """The local SQLite file contains keyed hashes, never names or usernames."""
    key = secrets.token_bytes(32)
    months = set()
    process = subprocess.Popen(["zstd", "-dc", str(archive)], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as tar:
            for member in tar:
                match = MONTH_FILE.search(member.name)
                if not match or not member.isfile():
                    continue
                month_key = (int(match.group(1)), int(match.group(2)))
                if not 1 <= month_key[1] <= 12:
                    raise ValueError("Invalid month in full dump")
                months.add(month_key)
                file = tar.extractfile(member)
                if file is None:
                    raise ValueError("Missing listen file in archive")
                for line in file:
                    record = json.loads(line)
                    when = record.get("listened_at")
                    if type(when) is not int or when <= 0:
                        continue
                    played = datetime.fromtimestamp(when, UTC).date()
                    iso_year, number, _ = played.isocalendar()
                    week = f"{iso_year}-W{number:02d}"
                    if week not in allowed:
                        continue
                    ids = mbids_for_listen(record)
                    conn.execute("INSERT INTO quality(week,input_rows) VALUES(?,1) "
                                 "ON CONFLICT(week) DO UPDATE SET input_rows=input_rows+1", (week,))
                    if not ids:
                        conn.execute("UPDATE quality SET missing_id=missing_id+1 WHERE week=?", (week,))
                        continue
                    metadata = record.get("track_metadata") or {}
                    mapping = metadata.get("mbid_mapping") or {}
                    if not mapping.get("artist_mbids"):
                        conn.execute("UPDATE quality SET client_submitted_id_rows=client_submitted_id_rows+1 WHERE week=?", (week,))
                    username = record.get("user_name")
                    person = (hmac.digest(key, username.encode("utf-8"), "sha256")
                              if isinstance(username, str) and username else None)
                    if person is None:
                        conn.execute("UPDATE quality SET missing_user=missing_user+1 WHERE week=?", (week,))
                    mapped_names = {item.get("artist_mbid"): item.get("artist_credit_name")
                                    for item in (mapping.get("artists") or []) if isinstance(item, dict)}
                    for artist in ids:
                        conn.execute("INSERT INTO totals VALUES(?,?,1) ON CONFLICT(week,artist) "
                                     "DO UPDATE SET listens=listens+1", (week, artist))
                        if person:
                            conn.execute("INSERT INTO audience VALUES(?,?,?,1) ON CONFLICT(week,person,artist) "
                                         "DO UPDATE SET listens=listens+1", (week, person, artist))
                        name = mapped_names.get(artist) or (metadata.get("artist_name") if len(ids) == 1 else None)
                        if name and isinstance(name, str):
                            conn.execute("INSERT OR IGNORE INTO names VALUES(?,?)", (artist, name.strip()[:160]))
                conn.commit()
        if process.wait() != 0:
            raise ValueError("Decompression of full dump failed")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    return months


def audience_edges(conn: sqlite3.Connection, week: str, artists: list[dict]) -> list[dict]:
    ids = {artist["id"] for artist in artists}
    totals = {artist["id"]: artist["listen_count"] for artist in artists}
    minima, shared = defaultdict(int), defaultdict(int)
    user_counts = []
    last_user = None
    for person, artist, count in conn.execute("SELECT person,artist,listens FROM audience WHERE week=? ORDER BY person", (week,)):
        if person != last_user:
            for (a, ca), (b, cb) in itertools.combinations(user_counts, 2):
                pair = tuple(sorted((a, b)))
                minima[pair] += min(ca, cb)
                shared[pair] += 1
            user_counts, last_user = [], person
        if artist in ids:
            user_counts.append((artist, count))
    for (a, ca), (b, cb) in itertools.combinations(user_counts, 2):
        pair = tuple(sorted((a, b)))
        minima[pair] += min(ca, cb)
        shared[pair] += 1
    edges = [{"source": a, "target": b, "strength": round(common / (totals[a] + totals[b] - common), 6),
              "kind": "weekly_weighted_jaccard", "shared_listener_count": shared[(a, b)],
              "movement_listener_count": None}
             for (a, b), common in minima.items() if shared[(a, b)] >= 10 and common > 0]
    return sorted(edges, key=lambda row: (-row["strength"], row["source"], row["target"]))[:250]


def publish_year(conn: sqlite3.Connection, year: int, captured: date, digest: str,
                 archive_id: str, months: set[tuple[int, int]], output: Path) -> list[str]:
    slots = weeks_of_iso_year(year)
    eligible = eligible_weeks(year, captured)
    if not eligible:
        raise ValueError("Full dump precedes the chosen year")
    first = date.fromisoformat(eligible[0]["start"])
    last = date.fromisoformat(eligible[-1]["end_exclusive"]) - timedelta(days=1)
    required = {(y, m) for y in range(first.year, last.year + 1) for m in range(1, 13)
                if date(y, m, 1) <= last and date(y, m, 1) + timedelta(days=31) > first}
    if not required.issubset(months):
        raise ValueError(f"Full dump is missing monthly files: {sorted(required - months)}")
    output.mkdir(parents=True, exist_ok=True)
    previous, published = None, []
    for slot in slots:
        if slot not in eligible:
            continue
        week = slot["id"]
        rows = conn.execute("SELECT artist,listens FROM totals WHERE week=? ORDER BY listens DESC,artist LIMIT 100", (week,)).fetchall()
        if len(rows) < 100:
            continue
        quality_row = conn.execute("SELECT missing_id,missing_user,input_rows,client_submitted_id_rows FROM quality WHERE week=?", (week,)).fetchone()
        if quality_row is None:
            continue
        names = dict(conn.execute("SELECT artist,name FROM names WHERE artist IN (" + ",".join("?" for _ in rows) + ")",
                                  [artist for artist, _ in rows]))
        artists = [{"id": artist, "name": names.get(artist) or f"Artist {artist[:8]}",
                    "listen_count": count, "rank": index,
                    "distinct_listener_count": None,
                    "quality_status": [] if names.get(artist) else ["name_unverified"]}
                   for index, (artist, count) in enumerate(rows, 1)]
        can_overlap = quality_row[1] == 0
        edges = audience_edges(conn, week, artists) if can_overlap else []
        graph = nx.Graph()
        graph.add_nodes_from(a["id"] for a in artists)
        graph.add_weighted_edges_from((e["source"], e["target"], e["strength"]) for e in edges)
        labels = communities(graph, previous)
        coords = layout(graph, artists, previous, labels)
        for artist in artists:
            artist["cluster_id"] = labels[artist["id"]]
            artist["x"], artist["y"] = coords[artist["id"]]
        snapshot = {"schema_version": VERSION, "week_id": week, "start": slot["start"],
            "end_exclusive": slot["end_exclusive"], "status": "complete",
            "source": {"kind": "listenbrainz_full_dump", "population": "Full dump listens with valid artist MBIDs",
                       "archive_id": archive_id, "archive_sha256": digest,
                       "archive_captured_date": captured.isoformat(), "method": "each listen credited once per distinct valid artist MBID"},
            "quality": {"input_rows": quality_row[2], "excluded_missing_mbid": quality_row[0],
                        "missing_user_rows": quality_row[1],
                        "client_submitted_id_rows": quality_row[3]},
            "artists": artists, "weekly_edges": edges,
            "weekly_relationship_status": "measured_weighted_jaccard" if can_overlap else "unavailable_missing_user_ids",
            "reference_edges": [], "reference": None,
            "movement": {"status": "unavailable", "observed_transitions": []}}
        path = output / f"{week}.json"
        payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n"
        path.write_text(payload, encoding="utf-8")
        slot.update({"status": "complete", "path": f"weekly-dump/{week}.json",
                     "signature": hashlib.sha256(payload.encode()).hexdigest()})
        previous, published = snapshot, published + [week]
    manifest = {"schema_version": VERSION, "series_id": f"listenbrainz_full_dump_{archive_id}",
                "default_year": year, "years": {str(year): {"weeks": slots}}}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return published


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path, help="official full listens .tar.zst")
    parser.add_argument("--sha256", required=True, help="expected digest from the official mirror")
    parser.add_argument("--archive-id", required=True, help="published ListenBrainz full-dump ID")
    parser.add_argument("--captured", required=True, type=date.fromisoformat)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--output", type=Path, default=DATA / "weekly-dump")
    args = parser.parse_args()
    digest = verify_archive(args.archive, args.sha256)
    allowed = {slot["id"] for slot in eligible_weeks(args.year, args.captured)}
    with tempfile.TemporaryDirectory(prefix="music-map-private-") as private:
        with sqlite3.connect(Path(private) / "aggregate.db") as conn:
            prepare_db(conn)
            months = scan_archive(args.archive, conn, args.year, allowed)
            weeks = publish_year(conn, args.year, args.captured, digest, args.archive_id, months, args.output)
    print(f"Published {len(weeks)} completed full-dump weeks: {', '.join(weeks)}")


if __name__ == "__main__":
    main()
