"""Validate every published public snapshot before a Pages deployment."""

import json
import math
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "public" / "data"


def validate():
    manifest = json.loads((DATA / "manifest.json").read_text())
    assert manifest["schema_version"] == 1
    dates = [entry["date"] for entry in manifest["snapshots"]]
    assert dates and dates == sorted(set(dates)), "Dates must be real, ordered, unique snapshots"
    for entry in manifest["snapshots"]:
        snapshot = json.loads((DATA / entry["path"]).read_text())
        assert snapshot["schema_version"] == 1 and snapshot["snapshot_date"] == entry["date"]
        previous, current = (snapshot[name] for name in ("previous_week", "current_week"))
        assert len(previous["recordings"]) == 10 and len(current["recordings"]) == 15
        for period in (previous, current):
            rows = period["recordings"]
            assert len({row["track_id"] for row in rows}) == len(rows)
            assert [row["ranking"] for row in rows] == list(range(1, len(rows) + 1))
            assert [row["play_count"] for row in rows] == sorted((row["play_count"] for row in rows), reverse=True)
            assert all(row["date"] == entry["date"] and row["distinct_listener_count"] is None for row in rows)
            assert all(isinstance(row["play_count"], int) and row["play_count"] >= 0 for row in rows)
            assert period["period_start_utc"] < period["period_end_utc"]
        ids_a = {row["track_id"] for row in previous["recordings"]}
        ids_b = {row["track_id"] for row in current["recordings"]}
        flows = snapshot["flows"]
        assert len(flows) == 150
        assert len({(flow["source_node"], flow["destination_node"]) for flow in flows}) == 150
        assert all(flow["source_node"] in ids_a and flow["destination_node"] in ids_b for flow in flows)
        assert all(flow["status"] == "estimated" and flow["number_of_listeners"] is None for flow in flows)
        assert all(math.isfinite(flow["estimated_share"]) and 0 <= flow["estimated_share"] <= 1 for flow in flows)
        assert abs(sum(flow["estimated_share"] for flow in flows) - 1) < 1e-7
        assert all(flow["period_from"] == previous["period_start_utc"] + "/" + previous["period_end_utc"] for flow in flows)
        assert all(flow["period_to"] == current["period_start_utc"] + "/" + current["period_end_utc"] for flow in flows)
        print(f"Validated {entry['date']}: 25 rankings, 150 estimated edges, no listener counts")


if __name__ == "__main__":
    validate()
