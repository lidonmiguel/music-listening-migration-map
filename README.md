# Music Listening Migration Map · Artist Landscape

An explorable map of **100 identified artists** in ListenBrainz's current-week sitewide chart. Circle area represents recorded listens. Undirected links represent normalized, session-based artist affinity from a separate ListenBrainz Labs index. These are different measures. **Observed listener movement is unavailable and no migrating-user particles are drawn.**

[Open the GitHub Pages site](https://lidonmiguel.github.io/music-listening-migration-map/) · [Read the method and data dictionary](docs/methods.md)

## Run and verify

Requires Python 3.12 and Node.js 22. The collector makes public API requests and writes only aggregate JSON.

```bash
python -m venv .venv
.venv/bin/python -m pip install -r collector/requirements.txt
.venv/bin/python collector/collect.py
.venv/bin/python -m unittest discover -s collector -p 'test_*.py' -v
.venv/bin/python collector/validate.py
npm ci
npm run build
npm run dev
```

The workflow in `.github/workflows/pages.yml` collects, validates and deploys at 06:17 UTC daily, on a push, and on manual dispatch. Source calculation delays are shown in the page. A new date enters the timeline only if the chart, available weekday activity or session index actually changes. A failure preserves the last valid published snapshot.

The static GitHub Pages site contains no access token, raw histories, username or persistent listener ID. A later observed-movement edition needs separate consented private ingestion and privacy-suppressed aggregates; it cannot be inferred from these public chart and similar-artist endpoints.
