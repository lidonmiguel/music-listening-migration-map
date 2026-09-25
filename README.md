# Music Listening Migration Map

[Live weekly artist map](https://lidonmiguel.github.io/music-listening-migration-map/)

An explorable 100-artist landscape built from **recorded ListenBrainz listens**, with a real ISO-week timeline. Press Play on an observed week to move to the next adjacent observed week. Missing weeks remain gaps. Node movement and size animation are a visual transition between measurements; they are **not** migrating listeners.

## What is available now

- **2026-W38**, September 14–20 UTC: completed top-100 sitewide artist chart.
- **2026-W39**, September 21–27 UTC: incomplete current-week top-100 chart, last calculated September 23. It cannot be compared like for like with the complete prior week.
- **2026-W01 through W37:** missing. No historic rankings have been copied or estimated. W40–W53 are future weeks as of the first publication.
- Lines in these API snapshots are a **nonweekly session-affinity reference** from ListenBrainz Labs. They are not weekly shared-listener counts. No observed listener movement, arrows or directional particles are published.

The [weekly methods and data dictionary](docs/weekly-methods.md) specify population, boundary rules, size function, relationship methods, gaps, backfill, and privacy. The older [daily prototype methods](docs/methods.md) and files remain for provenance but the website and scheduled collection use weekly schema v3.

## Local development

```sh
python -m venv .venv
.venv/bin/pip install -r collector/requirements.txt
npm ci
.venv/bin/python collector/weekly.py
.venv/bin/python -m unittest discover -s collector -p 'test_*.py' -v
.venv/bin/python collector/validate_weekly.py
npm run dev
npm run build
```

The scheduled GitHub Actions job runs at 06:17 UTC daily, fetches only the current and immediately previous ISO weeks, validates data and deploys static files to GitHub Pages. It does not run a large historical job. If ListenBrainz has not recalculated after a week boundary, collection fails and the previously deployed site remains in place. Same-week rechecks overwrite the same weekly file only when counts or the separately identified reference graph change. When a formerly partial week becomes the previous completed week, its completed result replaces the partial result.

## Historical full-dump backfill

An **offline batch** processor exists at `collector/backfill.py`. It streams an official full listens `.tar.zst`, verifies its supplied SHA-256, uses private temporary hashed user keys for weekly aggregation, and writes an isolated `public/data/weekly-dump/` series. It must run on a capable private machine with `zstd`, substantial scratch storage and enough time to read an archive currently measured in hundreds of gigabytes. This machine, archive and official checksum are not available to the normal Pages workflow. See [instructions and limitations](docs/weekly-methods.md#offline-historical-backfill). Do not commit raw archives, extracted listening events, usernames or temporary SQLite files.

The live API series and a dump-derived historical series use separate selectors because their identity coverage and counting methods can differ. The frontend reads the dump manifest only if the batch result has been validated and deliberately published. Neither series is silently spliced into the other.
