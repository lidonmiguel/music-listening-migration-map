# Music Listening Migration Map

An interactive map of **where chart attention might go**, grounded in public ListenBrainz weekly recording statistics. The first release publishes **estimated pairings of chart shares**, not observed movements of individual listeners.

The site shows the previous week's top 10 unique recordings and the current week's top 15, including source count, genre, visible-list status, a network of estimated pairings, a genre matrix, and a timeline of snapshots that were actually collected. A partial current week is never compared to a completed week as a like-for-like count change.

## Run locally

Requires Python 3.11+ and Node.js 20.19+ or 22.12+.

```bash
python3 collector/collect.py
npm ci
npm run dev
```

The collector requests public ListenBrainz chart and MusicBrainz-derived metadata through ListenBrainz. It writes only public aggregates under `public/data/`. It uses the latest source calculation timestamp for freshness; `to_ts` is the *calendar window end*, not proof that current-week data includes every day through that date. If the source is unavailable, the prior validated snapshot stays in place.

```bash
python3 -m unittest discover -s collector -p 'test_*.py' -v
npm run build
```

## Publish

In repository **Settings → Pages**, select **GitHub Actions** as the build source. `.github/workflows/pages.yml` collects data at 06:17 UTC every day, tests it, builds the Vite site, and deploys the static artifact. It also supports manual runs. Successful runs commit new dated public snapshots to `main`; a repeated upstream result does not create a fake new date. Pages serves the static React build and has no access to private user histories.

## Method and privacy

See [methods and data dictionary](docs/methods.md). This public-data prototype has **no observed listener transitions**. Its edges have a dimensionless estimated share and `number_of_listeners: null`. Future consented histories require a secure private ingestion service and a separate, suppressed aggregate publication process.
An honest map of weekly music chart attention and estimated listening flows.
