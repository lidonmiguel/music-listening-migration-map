import json
import io
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

from backfill import audience_edges, mbids_for_listen, prepare_db, publish_year, scan_archive
from validate_weekly import validate_manifest
from weekly import snapshot_from_api, source_week, weeks_of_iso_year


def mbid(n):
    return f"00000000-0000-0000-0000-{n:012d}"


class WeeklyRules(unittest.TestCase):
    def test_iso_year_slots_include_gaps_and_cross_year_boundaries(self):
        weeks = weeks_of_iso_year(2026)
        self.assertEqual(len(weeks), 53)
        self.assertEqual(weeks[0]["start"], "2025-12-29")
        self.assertEqual(weeks[-1]["end_exclusive"], "2027-01-04")
        self.assertTrue(all(w["status"] == "missing" and "path" not in w for w in weeks))

    def test_api_week_uses_only_previous_or_current_period(self):
        now = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
        payload = {"range": "week", "from_ts": 1789344000, "to_ts": 1789948800,
                   "last_updated": 1790136039,
                   "artists": [{"artist_mbid": mbid(i), "artist_name": f"Artist {i}",
                                "listen_count": 1000 - i} for i in range(100)]}
        snapshot, _ = snapshot_from_api(payload, [], date(2026, 9, 14), "week", now)
        self.assertEqual(snapshot["week_id"], "2026-W38")
        self.assertEqual(snapshot["status"], "complete")
        self.assertEqual(len(snapshot["artists"]), 100)
        self.assertEqual(snapshot["weekly_edges"], [])
        self.assertFalse(snapshot["reference"]["matches_week"])
        with self.assertRaises(ValueError):
            source_week(payload, date(2026, 9, 7), "week", now)
        with self.assertRaises(ValueError):
            source_week({**payload, "last_updated": 1789900000}, date(2026, 9, 14), "week", now)

    def test_full_dump_reader_and_privacy_threshold(self):
        self.assertEqual(mbids_for_listen({"track_metadata": {"additional_info": {
            "artist_mbids": [mbid(1), mbid(1), "invalid", mbid(2)]}}}), [mbid(1), mbid(2)])
        with tempfile.TemporaryDirectory() as directory:
            with sqlite3.connect(":memory:") as db:
                prepare_db(db)
                for i in range(100):
                    db.execute("INSERT INTO totals VALUES(?,?,?)", ("2026-W01", mbid(i), 10 if i < 2 else 1))
                db.execute("INSERT INTO quality VALUES(?,?,?,?,?)", ("2026-W01", 0, 0, 120, 0))
                for user in range(10):
                    for artist in (mbid(0), mbid(1)):
                        db.execute("INSERT INTO audience VALUES(?,?,?,?)",
                                   ("2026-W01", user.to_bytes(4, "big"), artist, 1))
                artists = [{"id": mbid(i), "listen_count": 10 if i < 2 else 1} for i in range(100)]
                edges = audience_edges(db, "2026-W01", artists)
                self.assertEqual(edges[0]["shared_listener_count"], 10)
                self.assertEqual(edges[0]["strength"], 1)
                published = publish_year(db, 2026, date(2026, 1, 5), "a" * 64, "test-archive",
                                         {(2025, 12), (2026, 1)}, Path(directory) / "weekly-dump")
                self.assertEqual(published, ["2026-W01"])
                # Validator resolves snapshot paths relative to public/data in production.
                manifest = Path(directory) / "weekly-dump" / "manifest.json"
                self.assertEqual(validate_manifest(manifest), {"2026-W01": "complete"})
                snapshot = json.loads((Path(directory) / "weekly-dump" / "2026-W01.json").read_text())
                self.assertEqual(snapshot["weekly_relationship_status"], "measured_weighted_jaccard")
                self.assertEqual(snapshot["movement"]["observed_transitions"], [])

    @unittest.skipUnless(shutil.which("zstd"), "zstd needed for archive stream test")
    def test_full_dump_stream_reads_real_week_without_publishing_users(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "source.tar"
            compressed = Path(directory) / "source.tar.zst"
            listen = {"listened_at": 1767052800, "user_name": "private-listener",
                      "track_metadata": {"artist_name": "Observed artist",
                                         "additional_info": {"artist_mbids": [mbid(1)]}}}
            with tarfile.open(raw, "w") as archive:
                for name, contents in (("dump/listens/2025/12.listens", json.dumps(listen) + "\n"),
                                       ("dump/listens/2026/1.listens", "")):
                    encoded = contents.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(encoded)
                    archive.addfile(info, io.BytesIO(encoded))
            subprocess.run(["zstd", "-q", str(raw), "-o", str(compressed)], check=True)
            with sqlite3.connect(":memory:") as db:
                prepare_db(db)
                months = scan_archive(compressed, db, 2026, {"2026-W01"})
                self.assertEqual(months, {(2025, 12), (2026, 1)})
                self.assertEqual(db.execute("SELECT listens FROM totals").fetchone(), (1,))
                self.assertEqual(db.execute("SELECT client_submitted_id_rows FROM quality").fetchone(), (1,))
                self.assertNotIn("private-listener", str(db.execute("SELECT * FROM audience").fetchall()))

    def test_server_mapping_takes_precedence_over_client_ids(self):
        record = {"track_metadata": {"mbid_mapping": {"artist_mbids": [mbid(1)]},
                                     "additional_info": {"artist_mbids": [mbid(2)]}}}
        self.assertEqual(mbids_for_listen(record), [mbid(1)])


if __name__ == "__main__":
    unittest.main()
