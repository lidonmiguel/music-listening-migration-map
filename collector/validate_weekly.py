"""Fail publication if a weekly snapshot misstates its period or provenance."""
import hashlib
import json
import re
import sys
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

from weekly import DATA, VERSION, weeks_of_iso_year


def validate_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != VERSION or not manifest.get("years"):
        raise ValueError("Invalid weekly manifest version or year index")
    available = {}
    for year, group in manifest["years"].items():
        expected = weeks_of_iso_year(int(year))
        weeks = group["weeks"]
        if len(weeks) != len(expected):
            raise ValueError(f"Missing week slots for {year}")
        for entry, slot in zip(weeks, expected):
            if any(entry.get(key) != slot[key] for key in ("id", "start", "end_exclusive")):
                raise ValueError(f"Wrong ISO boundaries in {entry.get('id')}")
            if entry.get("status") == "missing":
                if entry.get("path") or entry.get("signature"):
                    raise ValueError("Missing week points to a fabricated snapshot")
                continue
            if entry.get("status") not in ("complete", "partial"):
                raise ValueError("Unknown week state")
            if not re.fullmatch(r"[0-9a-f]{64}", entry.get("signature", "")):
                raise ValueError("Invalid source signature")
            snapshot_path = path.parent.parent / entry["path"]
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
            if snapshot.get("schema_version") != VERSION or any(snapshot.get(k) != entry.get(k)
                for k in ("status",)) or snapshot.get("week_id") != entry["id"] or snapshot.get("start") != entry["start"] or snapshot.get("end_exclusive") != entry["end_exclusive"]:
                raise ValueError(f"Snapshot and manifest disagree for {entry['id']}")
            artists = snapshot.get("artists", [])
            if len(artists) != 100:
                raise ValueError(f"Not 100 artists in {entry['id']}")
            ids = set()
            for rank, artist in enumerate(artists, 1):
                artist_id = artist["id"]
                if str(uuid.UUID(artist_id)) != artist_id or artist_id in ids:
                    raise ValueError("Duplicate or invalid artist MBID")
                ids.add(artist_id)
                if artist["rank"] != rank or type(artist["listen_count"]) is not int or artist["listen_count"] < 0:
                    raise ValueError("Invalid rank or listen count")
                if rank > 1 and artists[rank - 2]["listen_count"] < artist["listen_count"]:
                    raise ValueError("Counts not ordered")
                if not 0 <= artist["x"] <= 1 or not 0 <= artist["y"] <= 1:
                    raise ValueError("Node outside map")
            if snapshot["source"]["kind"] == "listenbrainz_sitewide_stats":
                if snapshot["weekly_edges"] or snapshot["reference"]["matches_week"]:
                    raise ValueError("Reference affinity masquerades as weekly overlap")
                if snapshot["source"]["range"] != ("this_week" if entry["status"] == "partial" else "week"):
                    raise ValueError("Wrong API source range")
                calculated = datetime.fromisoformat(snapshot["source"]["last_calculated_utc"].replace("Z", "+00:00"))
                if entry.get("source_last_calculated_utc") != snapshot["source"]["last_calculated_utc"]:
                    raise ValueError("Manifest and API freshness disagree")
                if calculated > datetime.now(timezone.utc) or calculated.date() < date.fromisoformat(entry["start"]):
                    raise ValueError("Invalid source calculation time")
                if entry["status"] == "complete" and calculated.date() < date.fromisoformat(entry["end_exclusive"]):
                    raise ValueError("Completed week has an incomplete source calculation")
            elif snapshot["source"]["kind"] == "listenbrainz_full_dump":
                if entry["status"] != "complete" or snapshot.get("reference_edges"):
                    raise ValueError("Dump graph and source status conflict")
                source = snapshot["source"]
                if not source.get("archive_id") or not re.fullmatch(r"[0-9a-f]{64}", source.get("archive_sha256", "")):
                    raise ValueError("Dump source is missing an archive identity or digest")
                if date.fromisoformat(source["archive_captured_date"]) < date.fromisoformat(entry["end_exclusive"]):
                    raise ValueError("Dump capture predates this complete week")
                if hashlib.sha256(snapshot_path.read_bytes()).hexdigest() != entry["signature"]:
                    raise ValueError("Dump snapshot content differs from manifest digest")
                quality = snapshot["quality"]
                if any(type(quality.get(k)) is not int or quality[k] < 0 for k in
                       ("input_rows", "excluded_missing_mbid", "missing_user_rows", "client_submitted_id_rows")):
                    raise ValueError("Invalid dump quality counts")
                if quality["excluded_missing_mbid"] + quality["client_submitted_id_rows"] > quality["input_rows"]:
                    raise ValueError("Dump quality counts exceed input rows")
                if snapshot["weekly_relationship_status"] == "measured_weighted_jaccard" and quality["missing_user_rows"]:
                    raise ValueError("Weekly overlap claimed without complete user coverage")
            else:
                raise ValueError("Unknown snapshot source")
            pair_keys = set()
            for edge in snapshot.get("weekly_edges", []) + snapshot.get("reference_edges", []):
                if edge["source"] not in ids or edge["target"] not in ids or edge["source"] == edge["target"]:
                    raise ValueError("Relationship references an absent artist")
                pair = tuple(sorted((edge["source"], edge["target"])))
                if pair in pair_keys or not 0 <= edge["strength"] <= 1:
                    raise ValueError("Duplicate or invalid relationship")
                pair_keys.add(pair)
                if edge in snapshot.get("weekly_edges", []) and (edge.get("kind") != "weekly_weighted_jaccard" or edge.get("shared_listener_count", 0) < 10):
                    raise ValueError("Unsuppressed small audience relationship")
                if edge in snapshot.get("reference_edges", []) and (edge.get("kind") != "audience_affinity" or edge.get("shared_listener_count") is not None):
                    raise ValueError("Reference relationship contains a fabricated audience count")
            if snapshot["movement"]["observed_transitions"] or snapshot["movement"]["status"] != "unavailable":
                raise ValueError("No movement source approved for publication")
            available[entry["id"]] = entry["status"]
    return available


if __name__ == "__main__":
    try:
        found = validate_manifest(Path(sys.argv[1]) if len(sys.argv) > 1 else DATA / "weekly" / "manifest.json")
        print("Validated weekly snapshots:", found)
    except Exception as error:
        print(f"Weekly validation failed: {error}", file=sys.stderr)
        sys.exit(1)
