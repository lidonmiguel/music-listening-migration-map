import unittest
from datetime import date, datetime, timezone

from collect import estimated_flows, primary_genre, unique_recordings, validate_period


def timestamp(day):
    return int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp())


class PublicDataRules(unittest.TestCase):
    def test_duplicate_mbid_keeps_highest_row_without_summing(self):
        base = {"recording_mbid": "abc", "track_name": "Song", "artist_name": "Artist"}
        rows, duplicates = unique_recordings([{**base, "listen_count": 8}, {**base, "listen_count": 7}], "2026-09-21T00:00:00Z", 1)
        self.assertEqual(rows[0]["play_count"], 8)
        self.assertEqual(rows[0]["quality_status"], ["duplicate_mbid_max_row"])
        self.assertEqual(duplicates, 1)

    def test_estimate_has_no_listener_count(self):
        prior = [{"track_id": "a", "play_count": 30}, {"track_id": "b", "play_count": 70}]
        now = [{"track_id": "c", "play_count": 20}, {"track_id": "d", "play_count": 80}]
        flows = estimated_flows(prior, now)
        self.assertAlmostEqual(flows[0]["estimated_share"], 0.06)
        self.assertAlmostEqual(sum(x["estimated_share"] for x in flows), 1.0)
        self.assertTrue(all(x["number_of_listeners"] is None and x["status"] == "estimated" for x in flows))

    def test_genre_uses_genre_tags_not_other_tags(self):
        metadata = {"tag": {"recording": [{"tag": "dance", "count": 7}, {"tag": "rock", "genre_mbid": "id", "count": 2}], "artist": [{"tag": "pop", "genre_mbid": "id", "count": 10}]}}
        self.assertEqual(primary_genre(metadata), ("rock", "recording"))

    def test_period_verifies_calendar_window_without_using_last_updated_as_end(self):
        payload = {"range": "this_week", "from_ts": timestamp("2026-09-21"), "to_ts": timestamp("2026-09-28"), "last_updated": timestamp("2026-09-23"), "recordings": []}
        validate_period(payload, "this_week", date(2026, 9, 21))
        with self.assertRaises(ValueError):
            validate_period(payload, "this_week", date(2026, 9, 28))


if __name__ == "__main__":
    unittest.main()
