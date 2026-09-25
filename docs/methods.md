# Artist landscape: data and interpretation

## What is actually measured

The nodes are the **top 100 MusicBrainz-ID-identified artists by recorded listens** in ListenBrainz's current UTC calendar week. This is the population of ListenBrainz sitewide submissions with usable artist MBIDs, not Spotify listeners or all music listeners. The collector fetches 300 source chart rows to get 100 distinct identified artists. Null-MBID credits are excluded, counted in `quality.excluded_missing_mbid`, and never merged with a similarly named identified artist. Repeated MBIDs retain the highest source row and receive a quality flag; their counts are never summed without evidence that the rows are disjoint. Sort by descending source count and MBID for ties.

Node **area** is proportional to the recorded `listen_count` in that snapshot (radius in SVG units = 42 × square root of count / 500,000). This fixed reference keeps the same count at the same visual size across dates; the scale is not recalculated from each day's largest artist. The minimum hit area is larger than the drawn node for accessibility. A listen is not a distinct listener; neither artist chart nor graph supplies a distinct-listener count.

`this_week` exposes a calendar `from_ts` and `to_ts`. The `to_ts` can lie in the future; it does **not** say that listens have been collected through that day. We show the last *calculation* timestamp separately and mark the week incomplete. The source does not expose an exact last included listen timestamp.

The separate sitewide `artist-evolution-activity?range=this_week` endpoint returns weekday artist counts for a **limited top-artist subset** (it supplied about 20 artists per day when inspected). Some returned weekday sums even **exceeded** the weekly chart count for the same MBID. We suppress those artist rows, mark `daily_rows_exceed_weekly_chart`, and record the number affected in `daily_activity.excluded_conflicting_artists`. Remaining optional rows appear in artist details. A missing or suppressed row is *unknown*, not zero. We do not manufacture 100 daily counts from this incomplete table. The main node size changes when a new, distinct sitewide artist chart result is archived. Within the same UTC week, `change_since_previous_snapshot` is the difference between source results archived on **different calendar dates**; a same-day refresh does not create a previous-day comparison. A delayed upstream run may span multiple days. A rollover to a new week resets this comparison to unavailable rather than subtracting a full and partial week.

## Affinity is not audience overlap or migration

The lines use [ListenBrainz Labs' similar-artists index](https://labs.api.listenbrainz.org/similar-artists), with the public algorithm key `session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30`. Its documented parameters describe a session-based similarity index with a 300-second session parameter, maximum per-user contribution of five and score threshold of ten. The endpoint returns artist pairs and scores; it **does not** provide complete listener sets, pairwise unique-listener intersections, or a matching weekly observation window. Its index refresh timestamp is not supplied. `retrieved_at_utc` is only our fetch time.

For each reference artist `i`, let `M_i` be its largest returned score across **all** returned artists. For an unordered pair `i,j` in the visible 100, let `S_ij` be the largest returned score for either direction (duplicate rows are not added). The displayed relative session affinity is

\[
A(i,j)=\min\left(1,\frac{S_{ij}}{\sqrt{M_iM_j}}\right).
\]

Only pairs with both nonzero seed maxima qualify. The collector keeps the 250 highest scored pairs; the unselected map draws up to 165 to reduce clutter. This size normalization moderates some raw popularity effects, but it is **not a weighted Jaccard index**, not a probability, and not a count of shared people. Missing edges may mean index truncation or missing MBIDs, not absence of a relationship. No arrow is drawn on an affinity line.

For a future **fully consented, same-user cohort**, define an audience set for artist `i` in a fixed window `W` as users who recorded at least one listen to `i` during `W`. Shared audience then means the intersection of two such sets. A normalized weighted Jaccard on per-user counts `c_{u,i}` is `sum_u min(c_{u,i}, c_{u,j}) / sum_u max(c_{u,i}, c_{u,j})`, with both sums over the same eligible cohort and window. This cannot be computed for the sitewide chart from public aggregate rows or from an artist's partial top-listener list.

## Communities and coordinates

We run NetworkX Louvain community detection (version 3.4.2, weight = `strength`, resolution 1, seed 42) on the 250-edge undirected graph. Artists with no retained edges have `cluster_id: "unlinked"`. Communities are descriptive algorithmic neighborhoods, **not genre labels**. Initial positions assign neighborhoods to spread-out anchors, use a seeded weighted spring layout *inside each neighborhood*, and relax collisions; anchors are a display choice, not geographic claims. Later snapshots seed from the prior snapshot, keep returning artists' coordinates anchored, place newcomers near existing neighbors, and match community IDs to prior groups by largest member overlap. Colors use these IDs. The graph index may remain the same while weekly activity changes.

## Directional movement gate

The public endpoints used here do not give complete same-person artist histories across two weeks. `/1/stats/artist/{mbid}/listeners` provides **top listeners**, a partial list, and does not establish full audience overlap. The site therefore publishes `movement.status: "unavailable"`, an empty `observed_transitions` array and **no directional particles**. Spotify public artist followers or follower-overlap lists are not assumed.

To enable observed transitions later, use a separate secure ingestion service with explicit consent and a stated eligible cohort. For each consenting user and each complete, matched period, choose the primary artist by highest recorded listen count, breaking ties by artist MBID; exclude users below a published minimum activity rule. Count pairs of primary artists across the same users. Publish only aggregate counts at or above a threshold initially set to 10, subject to a cohort-specific privacy review and complementary suppression across dates/filters. If particles are added, a fixed small number of decorative particles per displayed aggregate edge will show **direction only**; one will not equal one person. Tokens, raw events and user identifiers remain in private storage. GitHub Pages receives suppressed aggregates only.

## Snapshot schema

`public/data/manifest.json`: `schema_version: 2`; sorted `snapshots: [{date, path, source_signature, source_last_updated_utc}]`. One actual source change creates one dated snapshot. A second change on the same date updates that date's file, rather than adding a duplicate date.

Each `public/data/snapshots/YYYY-MM-DD.json` contains:

| Field | Meaning |
| --- | --- |
| `snapshot_date`, `captured_at_utc`, `population` | Published collection date, capture time, and source population. |
| `window.period_start_utc`, `period_end_utc_calendar`, `source_last_updated_utc`, `is_partial` | UTC calendar range, upstream calculation time, and completion flag. |
| `quality.rows_examined`, `excluded_missing_mbid`, `duplicate_mbid_rows` | Rank and identity audit. |
| `artists[].id`, `name`, `rank`, `listen_count`, `distinct_listener_count` | MBID identity, display name, unique rank, recorded listens; distinct listeners are null. |
| `artists[].reported_daily_activity[]` | Only weekday source rows available for this artist, each with an ISO date and listen count. |
| `artists[].change_since_previous_snapshot`, `previous_snapshot_date` | Same-week source calculation difference, or null. |
| `artists[].cluster_id`, `x`, `y`, `quality_status` | Algorithmic community, normalized stable layout, missing/duplicate flags. |
| `affinity.source`, `algorithm`, `method`, `retrieved_at_utc`, `window_matches_chart` | Provenance and explicit mismatch with chart week. |
| `edges[].source`, `target`, `strength`, `session_score`, `kind` | Unordered artist pair and relative session score. Kind is `audience_affinity`. |
| `edges[].shared_listener_count`, `movement_listener_count` | Always null in this version. |
| `movement.status`, `observed_transitions` | `unavailable`, empty array. |

The collector runs at 06:17 UTC daily and on pushes/manual dispatch. A new date requires changed displayed counts, validated weekday rows, affinity links, or a changed calendar week; a recalculation timestamp alone does not create a date. Source outages, invalid periods or malformed chart/affinity data fail the workflow and preserve the last validated deployment. GitHub Actions schedules can be delayed; absent dates are never interpolated. The site fetches one static manifest and one snapshot; no credential or private listen is published.
