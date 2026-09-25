import unittest
from datetime import date, datetime, timezone

from collect import add_daily_activity, affinity_edges, build_snapshot, ranked_artists, validated_window


def mbid(index):
    return f"00000000-0000-0000-0000-{index:012d}"


class ArtistRules(unittest.TestCase):
    def setUp(self):
        self.today = date(2026, 9, 25)
        self.now = datetime(2026, 9, 25, 11, tzinfo=timezone.utc)
        self.chart = {
            "range": "this_week", "from_ts": 1789948800, "to_ts": 1790553600,
            "last_updated": 1790131946,
            "artists": [{"artist_mbid": mbid(i), "artist_name": f"Artist {i}",
                         "listen_count": 2000 - i} for i in range(100)]
        }

    def test_rank_excludes_unmatched_and_keeps_duplicate_max_without_summing(self):
        rows = self.chart["artists"] + [
            {"artist_mbid": None, "artist_name": "Artist 0", "listen_count": 9000},
            {"artist_mbid": mbid(1), "artist_name": "Artist 1", "listen_count": 2100}]
        artists, quality = ranked_artists(rows)
        self.assertEqual(len(artists), 100)
        self.assertEqual(artists[0]["listen_count"], 2100)
        self.assertEqual(quality["excluded_missing_mbid"], 1)
        self.assertEqual(quality["duplicate_mbid_rows"], 1)

    def test_invalid_calendar_window_fails(self):
        wrong = {**self.chart, "from_ts": 1789344000}
        with self.assertRaises(ValueError):
            validated_window(wrong, date(2026, 9, 21), self.now)

    def test_session_affinity_has_no_listener_count_or_direction(self):
        ids = [mbid(0), mbid(1), mbid(2)]
        rows = [
            {"reference_mbid": ids[0], "artist_mbid": ids[1], "score": 20},
            {"reference_mbid": ids[0], "artist_mbid": ids[2], "score": 10},
            {"reference_mbid": ids[1], "artist_mbid": ids[0], "score": 20},
            {"reference_mbid": ids[2], "artist_mbid": ids[0], "score": 10}]
        edges, _ = affinity_edges(rows, ids)
        self.assertEqual(len(edges), 2)
        self.assertEqual(edges[0]["strength"], 1)
        self.assertIsNone(edges[0]["shared_listener_count"])
        self.assertIsNone(edges[0]["movement_listener_count"])

    def test_snapshot_never_emits_movement_and_keeps_stable_positions(self):
        ids = [mbid(i) for i in range(100)]
        rows = [{"reference_mbid": ids[i], "artist_mbid": ids[(i + 1) % 100], "score": 20}
                for i in range(100)]
        first, _ = build_snapshot(self.chart, None, rows, self.today, self.now)
        second, _ = build_snapshot(self.chart, None, rows, self.today, self.now, first)
        self.assertEqual(first["movement"]["observed_transitions"], [])
        self.assertEqual(len(first["artists"]), 100)
        self.assertEqual([(a["x"], a["y"]) for a in first["artists"]],
                         [(a["x"], a["y"]) for a in second["artists"]])
        self.assertIsNone(second["artists"][0]["change_since_previous_snapshot"])
        self.assertIsNone(second["artists"][0]["previous_snapshot_date"])
        next_day = date(2026, 9, 26)
        next_now = datetime(2026, 9, 26, 11, tzinfo=timezone.utc)
        third, _ = build_snapshot(self.chart, None, rows, next_day, next_now, first)
        self.assertEqual(third["artists"][0]["change_since_previous_snapshot"], 0)
        self.assertEqual(third["artists"][0]["previous_snapshot_date"], self.today.isoformat())

    def test_inconsistent_weekday_rows_are_suppressed(self):
        artists, _ = ranked_artists(self.chart["artists"])
        activity = {key: self.chart[key] for key in ("range", "from_ts", "to_ts", "last_updated")}
        activity["artist_evolution_activity"] = [
            {"artist_mbid": mbid(0), "time_unit": "Monday", "listen_count": 1500},
            {"artist_mbid": mbid(0), "time_unit": "Tuesday", "listen_count": 1500}]
        summary = add_daily_activity(activity, artists, date(2026, 9, 21), self.now)
        self.assertEqual(summary["excluded_conflicting_artists"], 1)
        self.assertEqual(artists[0]["reported_daily_activity"], [])
        self.assertIn("daily_rows_exceed_weekly_chart", artists[0]["quality_status"])


if __name__ == "__main__":
    unittest.main()
