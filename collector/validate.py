"""Fail the deployment if a public snapshot mislabels affinity as migration."""
import json
import math
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "public" / "data"


def validate():
    manifest = json.loads((DATA / "manifest.json").read_text())
    assert manifest["schema_version"] == 2
    dates = [entry["date"] for entry in manifest["snapshots"]]
    assert dates and dates == sorted(set(dates)), "Snapshots must be dated, ordered, unique"
    for entry in manifest["snapshots"]:
        snapshot = json.loads((DATA / entry["path"]).read_text())
        assert snapshot["schema_version"] == 2 and snapshot["snapshot_date"] == entry["date"]
        artists = snapshot["artists"]
        assert len(artists) == 100
        assert len({a["id"] for a in artists}) == 100
        assert [a["rank"] for a in artists] == list(range(1, 101))
        assert [a["listen_count"] for a in artists] == sorted((a["listen_count"] for a in artists), reverse=True)
        for artist in artists:
            assert len(artist["id"]) == 36 and isinstance(artist["listen_count"], int) and artist["listen_count"] >= 0
            assert artist["distinct_listener_count"] is None
            assert 0 <= artist["x"] <= 1 and 0 <= artist["y"] <= 1
            assert artist["change_since_previous_snapshot"] is None or isinstance(artist["change_since_previous_snapshot"], int)
            assert all(row["date"] <= entry["date"] and row["listen_count"] >= 0 for row in artist["reported_daily_activity"])
            assert sum(row["listen_count"] for row in artist["reported_daily_activity"]) <= artist["listen_count"]
        ids = {a["id"] for a in artists}
        edges = snapshot["edges"]
        assert 0 < len(edges) <= 250
        assert len({tuple(sorted((e["source"], e["target"]))) for e in edges}) == len(edges)
        assert all(e["source"] in ids and e["target"] in ids and e["source"] != e["target"] for e in edges)
        assert all(e["kind"] == "audience_affinity" and e["shared_listener_count"] is None
                   and e["movement_listener_count"] is None and math.isfinite(e["strength"])
                   and 0 < e["strength"] <= 1 for e in edges)
        assert snapshot["affinity"]["window_matches_chart"] is False
        assert snapshot["affinity"]["shared_listener_counts_available"] is False
        assert snapshot["movement"]["status"] == "unavailable"
        assert snapshot["movement"]["observed_transitions"] == []
        assert snapshot["window"]["period_start_utc"] < snapshot["window"]["source_last_updated_utc"] < snapshot["window"]["period_end_utc_calendar"]
        print(f"Validated {entry['date']}: 100 artists, {len(edges)} affinity links, zero observed movements")


if __name__ == "__main__":
    validate()
