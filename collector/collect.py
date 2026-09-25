"""Public artist activity and session affinity. Never fetches listener identities."""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import networkx as nx

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
API = "https://api.listenbrainz.org/1"
LABS = "https://labs.api.listenbrainz.org/similar-artists/json"
ALGORITHM = "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30"
LAYOUT_VERSION = "community_neighborhood_v2"
SNAPSHOT_RULE_VERSION = "prior_calendar_date_v2"
AGENT = "MusicListeningMigrationMap/0.2 (https://github.com/lidonmiguel/music-listening-migration-map)"
UTC = timezone.utc
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat().replace("+00:00", "Z")


def request_json(url: str, params: dict | None = None, body: object | None = None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": AGENT, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=70) as response:
                if "json" not in response.headers.get("Content-Type", ""):
                    raise ValueError("Non-JSON source response")
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            if attempt == 2 or getattr(error, "code", None) not in (None, 429, 500, 502, 503, 504):
                raise
            time.sleep(2 ** attempt * 2)
    raise RuntimeError("Unreachable")


def validated_window(payload: dict, monday: date, now: datetime) -> dict:
    start, end, updated = (int(payload[key]) for key in ("from_ts", "to_ts", "last_updated"))
    if payload.get("range") != "this_week" or datetime.fromtimestamp(start, UTC).date() != monday or end - start != 604800:
        raise ValueError("Sitewide UTC week has not rolled to the expected Monday")
    if not start <= updated <= int(now.timestamp()) + 300:
        raise ValueError("Invalid source calculation timestamp")
    return {"period_start_utc": iso(start), "period_end_utc_calendar": iso(end),
            "source_last_updated_utc": iso(updated), "is_partial": now.timestamp() < end}


def ranked_artists(rows: list[dict]) -> tuple[list[dict], dict]:
    """Rank identified MBIDs only; never guess an unmatched artist's identity."""
    found = {}
    missing = duplicates = 0
    for row in rows:
        count, mbid = row.get("listen_count"), row.get("artist_mbid")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError("Invalid artist listen count")
        if not mbid:
            missing += 1
            continue
        if not isinstance(mbid, str) or len(mbid) != 36:
            raise ValueError("Invalid artist MBID")
        name = str(row.get("artist_name") or "Unknown artist").strip()
        candidate = {"id": mbid, "name": name, "listen_count": count,
                     "quality_status": ["missing_name"] if name == "Unknown artist" else []}
        if mbid in found:
            duplicates += 1
            if count > found[mbid]["listen_count"]:
                candidate["quality_status"].append("duplicate_mbid_max_row")
                found[mbid] = candidate
            elif "duplicate_mbid_max_row" not in found[mbid]["quality_status"]:
                found[mbid]["quality_status"].append("duplicate_mbid_max_row")
        else:
            found[mbid] = candidate
    ordered = sorted(found.values(), key=lambda row: (-row["listen_count"], row["id"]))
    if len(ordered) < 100:
        raise ValueError("Fewer than 100 identifiable artists in source chart")
    for rank, artist in enumerate(ordered[:100], 1):
        artist["rank"] = rank
    return ordered[:100], {"rows_examined": len(rows), "excluded_missing_mbid": missing,
                           "duplicate_mbid_rows": duplicates}


def add_daily_activity(payload: dict | None, artists: list[dict], monday: date, now: datetime) -> dict:
    """The evolution endpoint reports only some top artists; missing means unknown."""
    if payload is None:
        for artist in artists:
            artist["reported_daily_activity"] = []
        return {"status": "unavailable", "artists_with_rows": 0,
                "excluded_conflicting_artists": 0, "source_last_updated_utc": None}
    validated_window(payload, monday, now)
    if not isinstance(payload.get("artist_evolution_activity"), list):
        raise ValueError("Malformed daily artist activity")
    known = {artist["id"] for artist in artists}
    values = {}
    for row in payload["artist_evolution_activity"]:
        day, count = row.get("time_unit"), row.get("listen_count")
        if day not in WEEKDAYS or not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError("Malformed daily activity row")
        if row.get("artist_mbid") in known:
            observed = monday + timedelta(days=WEEKDAYS.index(day))
            if observed > now.date():
                raise ValueError("Future day in daily activity")
            key = (row["artist_mbid"], observed.isoformat())
            values[key] = max(values.get(key, 0), count)
    conflicting = 0
    for artist in artists:
        reported = [{"date": day, "listen_count": count}
                    for (mbid, day), count in sorted(values.items()) if mbid == artist["id"]]
        if sum(row["listen_count"] for row in reported) > artist["listen_count"]:
            artist["reported_daily_activity"] = []
            artist["quality_status"].append("daily_rows_exceed_weekly_chart")
            conflicting += 1
        else:
            artist["reported_daily_activity"] = reported
    return {"status": "partial_top_artists",
            "artists_with_rows": sum(bool(artist["reported_daily_activity"]) for artist in artists),
            "excluded_conflicting_artists": conflicting,
            "source_last_updated_utc": iso(int(payload["last_updated"]))}


def fetch_affinity(ids: list[str]) -> list[dict]:
    batches = [ids[i:i + 20] for i in range(0, 100, 20)]
    def fetch(batch):
        rows = request_json(LABS, body=[{"artist_mbids": batch, "algorithm": ALGORITHM}])
        if not isinstance(rows, list):
            raise ValueError("Malformed similar-artists response")
        return rows
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        return [row for batch in executor.map(fetch, batches) for row in batch]


def affinity_edges(rows: list[dict], ids: list[str]) -> tuple[list[dict], dict]:
    """Relative session-index affinity, NOT Jaccard or observed shared listeners."""
    known, maxima, pairs = set(ids), defaultdict(int), {}
    covered = set()
    for row in rows:
        a, b, score = row.get("reference_mbid"), row.get("artist_mbid"), row.get("score")
        # Labs may append unpaired reference rows with a null reference_mbid.
        # They cannot support a link between two selected chart artists.
        if a is None:
            continue
        if a not in known or not isinstance(score, int) or isinstance(score, bool) or score < 0:
            raise ValueError("Malformed session-affinity row")
        covered.add(a)
        maxima[a] = max(maxima[a], score)
        if b in known and b != a and score > 0:
            pair = tuple(sorted((a, b)))
            pairs[pair] = max(score, pairs.get(pair, 0))
    edges = []
    for (a, b), score in pairs.items():
        if maxima[a] and maxima[b]:
            edges.append({"source": a, "target": b,
                "strength": round(min(1, score / math.sqrt(maxima[a] * maxima[b])), 6),
                "session_score": score, "kind": "audience_affinity",
                "shared_listener_count": None, "movement_listener_count": None})
    edges.sort(key=lambda edge: (-edge["strength"], edge["source"], edge["target"]))
    return edges[:250], {"rows_received": len(rows), "seeds_with_results": len(covered),
                         "candidate_pairs": len(pairs), "published_edges": min(len(edges), 250)}


def communities(graph: nx.Graph, previous: dict | None) -> dict[str, str]:
    active = graph.subgraph([node for node in graph if graph.degree(node)])
    groups = sorted(nx.community.louvain_communities(active, seed=42, weight="weight"),
                    key=lambda group: (-len(group), sorted(group)[0])) if active else []
    older = defaultdict(set)
    for artist in (previous or {}).get("artists", []):
        if artist.get("cluster_id") != "unlinked":
            older[artist["cluster_id"]].add(artist["id"])
    labels, used = {}, set()
    for group in groups:
        matches = sorted(((len(group & members), label) for label, members in older.items() if label not in used), reverse=True)
        if matches and matches[0][0]:
            label = matches[0][1]
        else:
            index = 1
            while f"c{index:02d}" in used or f"c{index:02d}" in older:
                index += 1
            label = f"c{index:02d}"
        used.add(label)
        for node in group:
            labels[node] = label
    return {node: labels.get(node, "unlinked") for node in graph}


def layout(graph: nx.Graph, artists: list[dict], previous: dict | None,
           labels: dict[str, str]) -> dict[str, tuple[float, float]]:
    old = {artist["id"]: (float(artist["x"]), float(artist["y"])) for artist in (previous or {}).get("artists", [])
           if artist["id"] in graph and "x" in artist and "y" in artist}
    if old:
        seeds = dict(old)
        for node in graph:
            if node not in seeds:
                nearby = [old[neighbor] for neighbor in graph.neighbors(node) if neighbor in old]
                digest = hashlib.sha256(node.encode()).digest()
                center = (sum(p[0] for p in nearby) / len(nearby), sum(p[1] for p in nearby) / len(nearby)) if nearby else (.5, .5)
                seeds[node] = (center[0] + (digest[0] / 255 - .5) * .06,
                               center[1] + (digest[1] / 255 - .5) * .06)
        raw = nx.spring_layout(graph, pos=seeds, fixed=list(old), seed=42, iterations=85, weight="weight", k=.12)
        coords = {node: [float(x), float(y)] for node, (x, y) in raw.items()}
    else:
        # Each detected community gets a loose neighborhood, then its weighted
        # spring coordinates supply the non-grid arrangement inside it.
        anchors = [(.67, .37), (.32, .60), (.69, .68), (.40, .35),
                   (.52, .58), (.83, .49), (.22, .73), (.81, .74),
                   (.55, .22), (.23, .46), (.74, .24), (.47, .76)]
        groups = defaultdict(list)
        for node, label in labels.items():
            if label != "unlinked":
                groups[label].append(node)
        coords = {}
        for index, (label, nodes) in enumerate(sorted(groups.items(), key=lambda group: (-len(group[1]), group[0]))):
            center = anchors[index % len(anchors)]
            local = nx.spring_layout(graph.subgraph(nodes), seed=42 + index,
                                     iterations=180, weight="weight")
            span = max(max(abs(value[0]), abs(value[1])) for value in local.values()) or 1
            rx = min(.155, .04 + .024 * math.sqrt(len(nodes)))
            ry = min(.17, .045 + .027 * math.sqrt(len(nodes)))
            for node, value in local.items():
                coords[node] = [center[0] + rx * value[0] / span,
                                center[1] + ry * value[1] / span]
        unlinked = sorted(node for node in graph if labels[node] == "unlinked")
        for index, node in enumerate(unlinked):
            angle = 2 * math.pi * (index / max(len(unlinked), 1) + .07)
            coords[node] = [.51 + .42 * math.cos(angle), .51 + .39 * math.sin(angle)]
    maximum = max(a["listen_count"] for a in artists)
    radii = {a["id"]: 5 + 26 * math.sqrt(a["listen_count"] / maximum) for a in artists}
    ids = [a["id"] for a in artists]
    for _ in range(55):
        for index, a in enumerate(ids):
            for b in ids[index + 1:]:
                dx, dy = (coords[b][0] - coords[a][0]) * 1200, (coords[b][1] - coords[a][1]) * 760
                distance = math.hypot(dx, dy) or .001
                minimum = radii[a] + radii[b] + 7
                if distance >= minimum or (a in old and b in old):
                    continue
                if distance < .01:
                    theta = int(hashlib.sha256((a + b).encode()).hexdigest()[:4], 16) / 65535 * math.tau
                    dx, dy, distance = math.cos(theta), math.sin(theta), 1
                push = (minimum - distance) * .52
                if a not in old:
                    coords[a][0] -= dx / distance * push / 1200
                    coords[a][1] -= dy / distance * push / 760
                if b not in old:
                    coords[b][0] += dx / distance * push / 1200
                    coords[b][1] += dy / distance * push / 760
    return {node: (round(max(.035, min(.965, p[0])), 5), round(max(.045, min(.955, p[1])), 5))
            for node, p in coords.items()}


def build_snapshot(chart: dict, activity: dict | None, affinity: list[dict], today: date,
                   now: datetime, previous: dict | None = None) -> tuple[dict, str]:
    monday = today - timedelta(days=today.weekday())
    window = validated_window(chart, monday, now)
    artists, quality = ranked_artists(chart["artists"])
    daily = add_daily_activity(activity, artists, monday, now)
    ids = [artist["id"] for artist in artists]
    edges, affinity_meta = affinity_edges(affinity, ids)
    graph = nx.Graph()
    graph.add_nodes_from(ids)
    graph.add_weighted_edges_from((edge["source"], edge["target"], edge["strength"]) for edge in edges)
    labels = communities(graph, previous)
    positions = layout(graph, artists, previous, labels)
    earlier = {a["id"]: a for a in previous["artists"]} if (
        previous and previous.get("snapshot_date", "") < today.isoformat()
        and previous.get("window", {}).get("period_start_utc") == window["period_start_utc"]
    ) else {}
    for artist in artists:
        prior = earlier.get(artist["id"])
        artist["change_since_previous_snapshot"] = artist["listen_count"] - prior["listen_count"] if prior else None
        artist["previous_snapshot_date"] = previous["snapshot_date"] if prior else None
        artist["cluster_id"] = labels[artist["id"]]
        artist["x"], artist["y"] = positions[artist["id"]]
        artist["distinct_listener_count"] = None
    signature = hashlib.sha256(json.dumps({
        "layout": LAYOUT_VERSION, "rules": SNAPSHOT_RULE_VERSION,
        "week": window["period_start_utc"],
        "artists": [(a["id"], a["listen_count"], a["reported_daily_activity"]) for a in artists],
        "affinity": [(e["source"], e["target"], e["session_score"]) for e in edges],
    }, sort_keys=True).encode()).hexdigest()
    snapshot = {"schema_version": 2, "layout_version": LAYOUT_VERSION, "snapshot_date": today.isoformat(),
        "captured_at_utc": now.isoformat().replace("+00:00", "Z"),
        "population": "ListenBrainz sitewide submissions; MBID-identified artists only",
        "window": window, "artist_source": "ListenBrainz /1/stats/sitewide/artists",
        "daily_activity": daily,
        "affinity": {"source": "ListenBrainz Labs similar-artists index", "algorithm": ALGORITHM,
            "method": "seed_max_normalized_session_score_v1",
            "retrieved_at_utc": now.isoformat().replace("+00:00", "Z"),
            "window_matches_chart": False, "shared_listener_counts_available": False, **affinity_meta},
        "movement": {"status": "unavailable", "reason": "No complete consented same-user histories for both periods",
                     "observed_transitions": []},
        "quality": quality, "artists": artists, "edges": edges}
    return snapshot, signature


def collect(today: date | None = None) -> bool:
    now = datetime.now(UTC)
    today = today or now.date()
    chart = request_json(f"{API}/stats/sitewide/artists", {"range": "this_week", "count": 300})["payload"]
    if not isinstance(chart.get("artists"), list):
        raise ValueError("Missing sitewide artist chart")
    try:
        activity = request_json(f"{API}/stats/sitewide/artist-evolution-activity", {"range": "this_week"})["payload"]
    except (urllib.error.HTTPError, urllib.error.URLError, KeyError):
        activity = None
    artists, _ = ranked_artists(chart["artists"])
    affinity = fetch_affinity([artist["id"] for artist in artists])
    manifest_path = DATA / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"schema_version": 2, "snapshots": []}
    if manifest.get("schema_version") != 2:
        manifest = {"schema_version": 2, "snapshots": []}
    previous = json.loads((DATA / manifest["snapshots"][-1]["path"]).read_text()) if manifest["snapshots"] else None
    if previous and previous.get("layout_version") != LAYOUT_VERSION:
        previous = None
    snapshot, signature = build_snapshot(chart, activity, affinity, today, now, previous)
    if manifest["snapshots"] and manifest["snapshots"][-1]["source_signature"] == signature:
        print("Upstream chart, daily activity, and affinity unchanged; timeline unchanged")
        return False
    path = DATA / "snapshots" / f"{today.isoformat()}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest["snapshots"] = [item for item in manifest["snapshots"] if item["date"] != today.isoformat()]
    manifest["snapshots"].append({"date": today.isoformat(), "path": f"snapshots/{today.isoformat()}.json",
        "source_signature": signature, "source_last_updated_utc": snapshot["window"]["source_last_updated_utc"]})
    manifest["snapshots"].sort(key=lambda item: item["date"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {path.relative_to(ROOT)}: 100 artists, {len(snapshot['edges'])} affinity links")
    return True


if __name__ == "__main__":
    try:
        collect()
    except Exception as error:
        print(f"Collection failed; retaining previous validated snapshot: {error}", file=sys.stderr)
        sys.exit(1)
