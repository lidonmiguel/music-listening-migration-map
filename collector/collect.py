"""Collect public ListenBrainz charts into honest, dated static snapshots.

No tokens, usernames, user events, or private identifiers are read or written.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
API = "https://api.listenbrainz.org/1"
USER_AGENT = "MusicListeningMigrationMap/0.1 (https://github.com/lidonmiguel/music-listening-migration-map)"
UTC = timezone.utc


def iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat().replace("+00:00", "Z")


def request_json(path: str, parameters: dict[str, str | int], attempts: int = 3) -> dict:
    url = f"{API}{path}?{urllib.parse.urlencode(parameters)}"
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
                if "json" not in response.headers.get("Content-Type", ""):
                    raise ValueError(f"Non-JSON API response for {path}")
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            status = getattr(error, "code", None)
            if status not in (429, 500, 502, 503, 504, None) or attempt + 1 == attempts:
                raise
            time.sleep(2 ** attempt * 2)
    raise RuntimeError("unreachable")


def key_for(row: dict, period_start: str) -> tuple[str, bool]:
    mbid = row.get("recording_mbid")
    if mbid:
        return f"mbid:{mbid}", False
    # A matching title alone is not proof of identity across weeks.
    fields = (row.get("artist_name", ""), row.get("track_name", ""), row.get("release_name", ""))
    value = "|".join(str(part).strip().casefold() for part in fields)
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]
    return f"unmatched:{period_start}:{digest}", True


def primary_genre(metadata: dict | None) -> tuple[str, str]:
    tags = (metadata or {}).get("tag") or {}
    for level in ("recording", "release_group", "artist"):
        options = [item for item in tags.get(level, []) if item.get("genre_mbid") and item.get("tag")]
        if options:
            chosen = sorted(options, key=lambda x: (-int(x.get("count") or 0), x["tag"].casefold()))[0]
            return chosen["tag"], level
    return "Unknown", "missing"


def unique_recordings(rows: list[dict], period_start: str, limit: int) -> tuple[list[dict], int]:
    kept: dict[str, dict] = {}
    duplicates = 0
    for row in rows:
        track_id, provisional = key_for(row, period_start)
        count = row.get("listen_count")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError(f"Invalid listen_count for {track_id}")
        candidate = {
            "track_id": track_id,
            "title": str(row.get("track_name") or "Unknown title"),
            "artist": str(row.get("artist_name") or "Unknown artist"),
            "artist_mbids": row.get("artist_mbids") or [],
            "genre": "Unknown",
            "genre_source": "missing",
            "source": "listenbrainz_sitewide_recordings",
            "play_count": count,
            "distinct_listener_count": None,
            "recording_mbid": row.get("recording_mbid"),
            "release_name": row.get("release_name"),
            "quality_status": ["provisional_id"] if provisional else ["ok"],
        }
        if track_id in kept:
            duplicates += 1
            existing = kept[track_id]
            # Source can repeat a recording MBID with conflicting counts.
            # Summing rows could double-count an upstream join.
            if count > existing["play_count"]:
                candidate["quality_status"] = ["duplicate_mbid_max_row"]
                kept[track_id] = candidate
            else:
                existing["quality_status"] = ["duplicate_mbid_max_row"]
        else:
            kept[track_id] = candidate
    ordered = sorted(kept.values(), key=lambda x: (-x["play_count"], x["track_id"]))
    if len(ordered) < limit:
        raise ValueError(f"Expected {limit} unique recordings; got {len(ordered)}")
    for rank, row in enumerate(ordered[:limit], start=1):
        row["ranking"] = rank
    return ordered[:limit], duplicates


def fetch_metadata(ids: list[str]) -> tuple[dict, str | None]:
    result: dict = {}
    try:
        for offset in range(0, len(ids), 25):
            batch = ids[offset : offset + 25]
            response = request_json("/metadata/recording/", {"recording_mbids": ",".join(batch), "inc": "tag"})
            if not isinstance(response, dict):
                raise ValueError("Unexpected metadata response")
            result.update(response)
        return result, None
    except (urllib.error.URLError, ValueError) as error:
        return result, f"Genre metadata unavailable: {type(error).__name__}"


def validate_period(payload: dict, expected_range: str, week_start: date) -> None:
    if payload.get("range") != expected_range:
        raise ValueError(f"Wrong range: expected {expected_range}, got {payload.get('range')}")
    actual_start = datetime.fromtimestamp(int(payload["from_ts"]), UTC).date()
    actual_end = datetime.fromtimestamp(int(payload["to_ts"]), UTC).date()
    if actual_start != week_start or actual_end != week_start + timedelta(days=7):
        raise ValueError(f"Source window mismatch for {expected_range}: {actual_start}..{actual_end}")
    if int(payload["last_updated"]) < int(payload["from_ts"]):
        raise ValueError("Source update timestamp precedes the period")
    if not isinstance(payload.get("recordings"), list):
        raise ValueError("Missing recording list")


def build_period(payload: dict, limit: int) -> dict:
    rows, duplicates = unique_recordings(payload["recordings"], iso(payload["from_ts"]), limit)
    return {
        "source_range": payload["range"],
        "period_start_utc": iso(payload["from_ts"]),
        "period_end_utc": iso(payload["to_ts"]),
        "source_last_updated_utc": iso(payload["last_updated"]),
        "source_rows_requested": len(payload["recordings"]),
        "duplicate_recording_rows": duplicates,
        "recordings": rows,
    }


def estimated_flows(previous: list[dict], current: list[dict], period_from: str = "previous_week", period_to: str = "current_week") -> list[dict]:
    total_a = sum(row["play_count"] for row in previous)
    total_b = sum(row["play_count"] for row in current)
    if total_a <= 0 or total_b <= 0:
        raise ValueError("Cannot estimate shares from zero play counts")
    return [
        {
            "period_from": period_from,
            "period_to": period_to,
            "source_node": source["track_id"],
            "destination_node": destination["track_id"],
            "edge_type": "chart_attention_pairing_baseline",
            "number_of_listeners": None,
            "estimated_share": round(source["play_count"] / total_a * destination["play_count"] / total_b, 10),
            "calculation_method": "independent_visible_chart_shares_v1",
            "status": "estimated",
            "population": "listenbrainz_sitewide_chart_rows",
        }
        for source in previous for destination in current
    ]


def collect(today: date | None = None) -> bool:
    now = datetime.now(UTC)
    today = today or now.date()
    monday = today - timedelta(days=today.weekday())
    previous_monday = monday - timedelta(days=7)
    week = request_json("/stats/sitewide/recordings", {"range": "week", "count": 100})["payload"]
    current = request_json("/stats/sitewide/recordings", {"range": "this_week", "count": 100})["payload"]
    validate_period(week, "week", previous_monday)
    validate_period(current, "this_week", monday)
    prior = build_period(week, 10)
    present = build_period(current, 15)
    mbids = sorted({row["recording_mbid"] for p in (prior, present) for row in p["recordings"] if row["recording_mbid"]})
    metadata, metadata_error = fetch_metadata(mbids)
    for p in (prior, present):
        for row in p["recordings"]:
            row["date"] = today.isoformat()
            row["genre"], row["genre_source"] = primary_genre(metadata.get(row["recording_mbid"]))
            if row["genre"] == "Unknown":
                row["quality_status"] = [*row["quality_status"], "missing_genre"]
    snapshot = {
        "schema_version": 1,
        "snapshot_date": today.isoformat(),
        "captured_at_utc": now.isoformat().replace("+00:00", "Z"),
        "source": "ListenBrainz sitewide recording statistics",
        "population": "ListenBrainz sitewide submissions; listener identities unavailable",
        "genre_metadata": "MusicBrainz genre tags via ListenBrainz metadata cache",
        "genre_mapping_version": "primary_recording_release_group_artist_v1",
        "previous_week": prior,
        "current_week": present,
        "flows": estimated_flows(
            prior["recordings"], present["recordings"],
            f"{prior['period_start_utc']}/{prior['period_end_utc']}",
            f"{present['period_start_utc']}/{present['period_end_utc']}",
        ),
        "data_quality_notes": [note for note in [
            "Repeated recording MBIDs were collapsed using the highest source row count; rows were not added."
            if prior["duplicate_recording_rows"] or present["duplicate_recording_rows"] else None,
            metadata_error,
        ] if note],
    }
    signature = hashlib.sha256(json.dumps({
        "prior": [(x["track_id"], x["play_count"]) for x in prior["recordings"]],
        "present": [(x["track_id"], x["play_count"]) for x in present["recordings"]],
        "updates": [prior["source_last_updated_utc"], present["source_last_updated_utc"]],
    }, sort_keys=True).encode()).hexdigest()
    DATA.mkdir(parents=True, exist_ok=True)
    manifest_path = DATA / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"schema_version": 1, "snapshots": []}
    if manifest["snapshots"] and manifest["snapshots"][-1]["source_signature"] == signature:
        print("Source chart unchanged; no new timeline date created")
        return False
    filename = f"snapshots/{today.isoformat()}.json"
    path = DATA / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest["snapshots"] = [x for x in manifest["snapshots"] if x["date"] != today.isoformat()]
    manifest["snapshots"].append({
        "date": today.isoformat(), "path": filename, "source_signature": signature,
        "source_last_updated_utc": present["source_last_updated_utc"],
    })
    manifest["snapshots"].sort(key=lambda x: x["date"])
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {path.relative_to(ROOT)}: {len(prior['recordings'])} + {len(present['recordings'])} unique recordings")
    return True


if __name__ == "__main__":
    try:
        collect()
    except Exception as exc:
        print(f"Collection failed; retaining last validated snapshot: {exc}", file=sys.stderr)
        sys.exit(1)
