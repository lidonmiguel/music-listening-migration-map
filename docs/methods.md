# Method, sources, and data dictionary

## What the prototype answers

This site asks where attention **might be paired** between two visible ListenBrainz charts. It cannot answer which person switched songs. The previous list has 10 unique recordings and the current list has 15. They are chart slices from **ListenBrainz sitewide submissions**, not a representative sample of every music listener.

The chart API reports a calendar `from_ts` and `to_ts`, and a `last_updated` calculation time. The calendar end of `this_week` lies in the future while the week is in progress. We display the **week's calendar dates**, the **calculation time**, and the **snapshot capture date** separately. We do not claim that the last included listen was played exactly at `last_updated`.

The source is [ListenBrainz sitewide recording statistics](https://listenbrainz.readthedocs.io/en/latest/users/api/statistics.html). Genre tags come from the [ListenBrainz MusicBrainz metadata cache](https://listenbrainz.readthedocs.io/en/latest/users/api/metadata.html). Tags are contributed metadata, not an objective property of a song.

## Rankings and identity

The collector requests the first 100 rows per week and selects 10 or 15 **unique MusicBrainz recording IDs**, sorted by descending `listen_count` with ID as a tie break. If there are insufficient unique recordings, it fails rather than inventing entries. Repeated MBIDs occur in the source response. We keep the *highest* source row and flag `duplicate_mbid_max_row`; we **do not add** those counts because the rows may be duplicated by an upstream join. Thus our displayed rank is a **derived unique-recording rank**, and a flagged count is a conservative row value, not a reconstructed unique total. If a tie falls beyond the fetched 100 rows, that boundary has not been fully audited.

Missing MBIDs receive a provisional key scoped to their week, based on normalized artist, title, and release. We do not assert that two such keys across weeks are the same recording. Different verified recording MBIDs remain separate, including live/remastered versions. A shared track is labeled “stays”; a track in the current visible list only “enters”; a previous-list-only track “leaves.” These words refer to **visible-list membership**, not first-ever appearance on ListenBrainz.

For each recording, choose a primary MusicBrainz-tagged genre from recording tags if present, otherwise release-group tags, then artist tags. At each level use the highest community tag count; tie break alphabetically. Only tags with a `genre_mbid` qualify. Missing genre is `Unknown`. Store genre source and a rule version so a future metadata update is auditable.

## Estimated connections

Let `a_i = play_count_i / sum(previous visible 10 counts)` and `b_j = play_count_j / sum(current visible 15 counts)`. Every edge stores `estimated_share = a_i * b_j`. This is an **independence baseline** over the two *visible lists*. It is dimensionless and says what a hypothetical pairing of chart attention shares would produce. It does not estimate a number of people. For example, 30% × 20% gives a 6% modeled share. A diagonal edge is **not observed retention**. Outside-list attention is excluded by construction.

Node area represents the displayed source **listen count**, not distinct listeners. Edge thickness represents **estimated share**. Particles are decorative direction cues with a fixed, capped quantity, not tracked users or quantitative markers. The genre matrix groups these same estimated edges by the assigned primary genres; diagonal cells show within-genre pairings.

No percentage count change compares the partial current week against the complete previous week. A future same-elapsed-day comparison requires two previously archived chart snapshots with appropriately matching calculation cutoffs; a week's `to_ts` alone cannot establish that. The timeline lists only saved dates for which the upstream payload changed.

## Published schema

`public/data/manifest.json`: `schema_version: integer`, `snapshots: [{date: YYYY-MM-DD, path: string, source_signature: SHA-256, source_last_updated_utc: ISO8601}]`.

`public/data/snapshots/YYYY-MM-DD.json`:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version`, `snapshot_date`, `captured_at_utc` | integer, date, timestamp | Format version and when we captured the published payload. |
| `source`, `population`, `genre_metadata`, `genre_mapping_version` | strings | Data provenance and taxonomy rule. |
| `previous_week`, `current_week` | objects | Source range, calendar start/end, `source_last_updated_utc`, raw row count requested, repeated-MBID count, and ranked recording array. |
| `recordings[].track_id`, `title`, `artist`, `genre`, `genre_source` | strings | Recording identity and display metadata. |
| `recordings[].source`, `date`, `ranking`, `play_count` | string, date, positive integer, nonnegative integer | ListenBrainz sitewide source, snapshot date, derived unique rank, and chosen source-row listen count. |
| `recordings[].distinct_listener_count` | null | **Unavailable** from the sitewide chart. Never infer it from listens. |
| `recordings[].recording_mbid`, `release_name` | nullable strings | Matching and provenance. |
| `recordings[].quality_status` | string array | `ok`, `provisional_id`, `duplicate_mbid_max_row`, or `missing_genre`. |
| `flows[].period_from`, `period_to`, `source_node`, `destination_node` | strings | Exact UTC period bounds in `start/end` form and the recording IDs joined. |
| `flows[].edge_type`, `calculation_method`, `status`, `population` | strings | Method provenance. Every first-release edge is `estimated`. |
| `flows[].estimated_share`, `number_of_listeners` | number, null | Modeled visible-list share; no measured listener count. |

No raw user history, credential, username, or persistent person identifier is stored or deployed. The first release has no consented population. A later observed-flow release requires explicit consent, secure private ingestion, same-user matching across periods, minimum activity rules, a minimum distinct-listener threshold (initially 10), and complementary suppression against differencing across published files. It must label the consented cohort separately from sitewide rankings.

## Update behavior

The daily workflow runs at 06:17 UTC and can be started manually. It validates that the API's period matches the intended week. It writes a new dated snapshot only when source calculation times or displayed chart rows change. API errors, calendar mismatches, invalid counts, or insufficient rows fail the run and retain the last valid public snapshot. GitHub Actions schedules can be delayed or missed; missing dates are never synthesized. The site reads a small manifest followed by one static JSON file.
