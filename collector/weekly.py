"""Archive the current and immediately preceding ListenBrainz sitewide weeks.

This API cannot address arbitrary past weeks. Historical backfill is a separate job.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import networkx as nx

from collect import (API, DATA, affinity_edges, communities, fetch_affinity, layout,
                     ranked_artists, request_json)

UTC = timezone.utc
VERSION = 3
LAYOUT = "weekly_communities_v1"
REFERENCE = "ListenBrainz Labs session-based similar-artists index; not a weekly audience graph"


def weeks_of_iso_year(year: int) -> list[dict]:
    last = date(year, 12, 28).isocalendar().week
    return [{"id": f"{year}-W{number:02d}", "start": date.fromisocalendar(year, number, 1).isoformat(),
             "end_exclusive": (date.fromisocalendar(year, number, 1) + timedelta(days=7)).isoformat(),
             "status": "missing"} for number in range(1, last + 1)]


def source_week(payload: dict, expected_start: date, expected_range: str, now: datetime) -> tuple[str, str]:
    if payload.get("range") != expected_range:
        raise ValueError(f"Unexpected source range: {payload.get('range')}")
    start = datetime.fromtimestamp(int(payload["from_ts"]), UTC).date()
    end = datetime.fromtimestamp(int(payload["to_ts"]), UTC).date()
    updated = datetime.fromtimestamp(int(payload["last_updated"]), UTC)
    if start != expected_start or end != start + timedelta(days=7):
        raise ValueError(f"Source week mismatch for {expected_range}: {start} to {end}")
    if updated > now + timedelta(minutes=5) or updated.date() < start:
        raise ValueError("Invalid source calculation timestamp")
    if expected_range == "week" and (now.date() < end or updated.date() < end):
        raise ValueError("Previous week's source calculation predates completion")
    return start.isoformat(), end.isoformat()


def snapshot_from_api(payload: dict, affinity_rows: list[dict], expected_start: date,
                      expected_range: str, now: datetime, previous: dict | None = None) -> tuple[dict, str]:
    start, end = source_week(payload, expected_start, expected_range, now)
    if not isinstance(payload.get("artists"), list):
        raise ValueError("Missing sitewide artist rows")
    artists, quality = ranked_artists(payload["artists"])
    ids = [artist["id"] for artist in artists]
    reference_edges, reference_quality = affinity_edges(
        [row for row in affinity_rows if row.get("reference_mbid") in ids or row.get("reference_mbid") is None], ids)
    reference_edges = reference_edges[:120]
    graph = nx.Graph()
    graph.add_nodes_from(ids)
    graph.add_weighted_edges_from((edge["source"], edge["target"], edge["strength"])
                                  for edge in reference_edges)
    labels = communities(graph, previous)
    positions = layout(graph, artists, previous, labels)
    for artist in artists:
        artist["cluster_id"] = labels[artist["id"]]
        artist["x"], artist["y"] = positions[artist["id"]]
        artist["distinct_listener_count"] = None
        artist["quality_status"] = artist.get("quality_status", [])
    week_id = f"{expected_start.isocalendar().year}-W{expected_start.isocalendar().week:02d}"
    partial = expected_range == "this_week"
    signature = hashlib.sha256(json.dumps({"method": LAYOUT, "range": expected_range,
        "period": [start, end], "artists": [(a["id"], a["listen_count"]) for a in artists],
        "reference_edges": [(e["source"], e["target"], e["session_score"]) for e in reference_edges]},
        sort_keys=True).encode()).hexdigest()
    snapshot = {"schema_version": VERSION, "week_id": week_id, "start": start,
        "end_exclusive": end, "status": "partial" if partial else "complete",
        "source": {"kind": "listenbrainz_sitewide_stats", "range": expected_range,
                   "population": "ListenBrainz sitewide submissions with artist MBIDs",
                   "last_calculated_utc": datetime.fromtimestamp(int(payload["last_updated"]), UTC).isoformat().replace("+00:00", "Z"),
                   "captured_utc": now.isoformat().replace("+00:00", "Z"),
                   "exact_listen_cutoff_known": False},
        "quality": quality, "artists": artists,
        "weekly_edges": [], "weekly_relationship_status": "unavailable_from_aggregate_stats",
        "reference_edges": reference_edges,
        "reference": {"kind": "session_affinity_reference", "label": REFERENCE,
                      "retrieved_utc": now.isoformat().replace("+00:00", "Z"),
                      "matches_week": False, "shared_listener_counts_available": False,
                      **reference_quality},
        "movement": {"status": "unavailable", "observed_transitions": []}}
    return snapshot, signature


def load_manifest(path: Path, year: int) -> dict:
    if path.exists():
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("schema_version") != VERSION or manifest.get("series_id") != "sitewide_stats_api":
            raise ValueError("Unexpected weekly manifest schema or population")
    else:
        manifest = {"schema_version": VERSION, "series_id": "sitewide_stats_api",
                    "default_year": year, "years": {}}
    for selected_year in range(2026, year + 1):
        manifest["years"].setdefault(str(selected_year), {"weeks": weeks_of_iso_year(selected_year)})
    return manifest


def collect(now: datetime | None = None) -> list[str]:
    now = now or datetime.now(UTC)
    today = now.date()
    monday = today - timedelta(days=today.weekday())
    periods = [("week", monday - timedelta(days=7)), ("this_week", monday)]
    payloads = [(rng, start, request_json(f"{API}/stats/sitewide/artists",
                  {"range": rng, "count": 300})["payload"]) for rng, start in periods]
    for rng, start, payload in payloads:
        source_week(payload, start, rng, now)
    ranked = [ranked_artists(payload["artists"])[0] for _, _, payload in payloads]
    ids = list(dict.fromkeys(artist["id"] for group in ranked for artist in group))
    affinity = fetch_affinity(ids)
    manifest_path = DATA / "weekly" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest(manifest_path, monday.isocalendar().year)
    for _, start, _ in payloads:
        iso_year = start.isocalendar().year
        manifest["years"].setdefault(str(iso_year), {"weeks": weeks_of_iso_year(iso_year)})
    changed = []
    previous = None
    for rng, start, payload in payloads:
        week_id = f"{start.isocalendar().year}-W{start.isocalendar().week:02d}"
        existing = next(row for row in manifest["years"][str(start.isocalendar().year)]["weeks"]
                        if row["id"] == week_id)
        # The immediately preceding archived week anchors returning artists.
        anchor = previous
        if anchor is None:
            earlier = [entry for group in manifest["years"].values() for entry in group["weeks"]
                       if entry.get("path") and entry["start"] < start.isoformat()]
            if earlier:
                prior_path = DATA / max(earlier, key=lambda entry: entry["start"])["path"]
                anchor = json.loads(prior_path.read_text(encoding="utf-8"))
        snapshot, signature = snapshot_from_api(payload, affinity, start, rng, now, anchor)
        if existing.get("signature") == signature and existing.get("status") == snapshot["status"]:
            previous = json.loads((DATA / existing["path"]).read_text(encoding="utf-8"))
            continue
        path = DATA / "weekly" / f"{week_id}.json"
        path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        existing.update({"status": snapshot["status"], "path": f"weekly/{week_id}.json",
                         "signature": signature,
                         "source_last_calculated_utc": snapshot["source"]["last_calculated_utc"]})
        previous = snapshot
        changed.append(week_id)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return changed


if __name__ == "__main__":
    try:
        print("Updated weekly snapshots:", ", ".join(collect()) or "none; source unchanged")
    except Exception as error:
        print(f"Weekly collection failed; prior published data remains: {error}", file=sys.stderr)
        sys.exit(1)
