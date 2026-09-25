import { useEffect, useMemo, useState } from 'react'
import { scaleSqrt } from 'd3-scale'

const BASE = import.meta.env.BASE_URL
const COLORS = ['#9eb9ff', '#f5aa85', '#b8df9c', '#d8b8fb', '#f0d783', '#8ed9d3', '#e7a9bf', '#91c3e3', '#c5c8e9', '#f4c29d']
const number = new Intl.NumberFormat('en-US')
const percent = value => `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`
const shortDate = value => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value))
const utcTime = value => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(value)) + ' UTC'
const endDay = value => shortDate(new Date(new Date(value).getTime() - 86400000).toISOString())

function genreColor(name, genres) {
  const index = genres.indexOf(name)
  return name === 'Unknown' ? '#8f99aa' : COLORS[(index < 0 ? 0 : index) % COLORS.length]
}

function Tag({ children, tone = '' }) { return <span className={`tag ${tone}`}>{children}</span> }

function Ranking({ title, period, rows, side, otherIds, selected, onSelect, genres, filterGenre, search }) {
  return <section className="ranking card" aria-label={`${title} ranking`}>
    <div className="rank-head"><span className="eyebrow">{side === 'previous' ? '01 / ORIGIN' : '03 / DESTINATION'}</span><h2>{title}</h2>
      <p>{shortDate(period.period_start_utc)} — {endDay(period.period_end_utc)} · UTC calendar week</p>
    </div>
    <div className="rank-list">
      {rows.map(row => {
        const remains = otherIds.has(row.track_id)
        const faded = (filterGenre !== 'All genres' && row.genre !== filterGenre) || (search && !`${row.title} ${row.artist}`.toLowerCase().includes(search.toLowerCase()))
        const active = selected?.side === side && selected?.id === row.track_id
        return <button className={`rank-row ${active ? 'active' : ''} ${faded ? 'dim' : ''}`} key={row.track_id} onClick={() => onSelect({ side, id: row.track_id })} aria-pressed={active}>
          <span className="rank-number">{String(row.ranking).padStart(2, '0')}</span>
          <span className="rank-marker" style={{ '--marker': genreColor(row.genre, genres) }} />
          <span className="rank-copy"><strong title={row.title}>{row.title}</strong><small>{row.artist}</small></span>
          <span className="rank-meta"><b>{number.format(row.play_count)}</b><small>{remains ? 'stays' : side === 'previous' ? 'leaves' : 'enters'}</small></span>
        </button>
      })}
    </div>
    <p className="rank-foot">Unique recording rank · node area = recorded listens</p>
  </section>
}

function Graph({ previous, current, flows, selected, onSelect, genres, filterGenre, search, paused }) {
  const sourceById = useMemo(() => new Map(previous.map(x => [x.track_id, x])), [previous])
  const targetById = useMemo(() => new Map(current.map(x => [x.track_id, x])), [current])
  const yLeft = index => 67 + index * 62
  const yRight = index => 45 + index * 44
  const radius = scaleSqrt().domain([0, Math.max(1, ...[...previous, ...current].map(row => row.play_count))]).range([3.5, 12])
  const matches = row => (filterGenre === 'All genres' || row.genre === filterGenre) && (!search || `${row.title} ${row.artist}`.toLowerCase().includes(search.toLowerCase()))
  const activeFlows = selected
    ? flows.filter(flow => selected.side === 'previous' ? flow.source_node === selected.id : flow.destination_node === selected.id)
    : [...flows].sort((a, b) => b.estimated_share - a.estimated_share).slice(0, 40)
  const edges = activeFlows.map((flow, index) => {
    const a = sourceById.get(flow.source_node), b = targetById.get(flow.destination_node)
    if (!a || !b) return null
    const ay = yLeft(a.ranking - 1), by = yRight(b.ranking - 1)
    const path = `M 26 ${ay} C 165 ${ay}, 285 ${by}, 454 ${by}`
    return { ...flow, a, b, path, index, visible: matches(a) && matches(b) }
  }).filter(Boolean)
  return <div className="network card" aria-label="Estimated song pairing network">
    <div className="network-label"><span className="eyebrow">02 / CONNECTIONS</span><strong>Modeled attention</strong><small>{selected ? 'All links for selected recording' : '40 strongest links shown'}</small></div>
    <svg viewBox="0 0 480 750" role="img" aria-label="Connections from previous chart songs on the left to current chart songs on the right. Select a song in either ranking for its connections.">
      <defs><marker id="arrow" viewBox="0 0 9 9" refX="8" refY="4.5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L9 4.5 L0 9" fill="#aab9cf" /></marker></defs>
      {edges.map(edge => <path key={`${edge.source_node}|${edge.destination_node}`} id={`edge-${edge.index}`} d={edge.path} fill="none" stroke={genreColor(edge.a.genre, genres)} strokeWidth={Math.max(1, Math.sqrt(edge.estimated_share) * 31)} opacity={edge.visible ? selected ? .63 : .23 : .025} markerEnd="url(#arrow)"><title>{edge.a.title} → {edge.b.title}: {percent(edge.estimated_share)} modeled pairing share. No listener count.</title></path>)}
      {!paused && edges.filter(e => e.visible).sort((a,b) => b.estimated_share - a.estimated_share).slice(0, 8).map(edge => <circle key={`particle-${edge.index}`} r="2.4" fill={genreColor(edge.a.genre, genres)} aria-hidden="true"><animateMotion dur={`${4.2 + edge.index % 3 * 0.8}s`} begin={`${edge.index % 8 * -.51}s`} repeatCount="indefinite" path={edge.path} /></circle>)}
      {previous.map(row => <g key={`left-${row.track_id}`} className="node" onClick={() => onSelect({ side: 'previous', id: row.track_id })} style={{ cursor: 'pointer' }} tabIndex="0" role="button" aria-label={`Previous rank ${row.ranking}, ${row.title}, ${number.format(row.play_count)} listens`} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ side: 'previous', id: row.track_id }) } }}>
        <circle cx="19" cy={yLeft(row.ranking - 1)} r={radius(row.play_count) + (selected?.id === row.track_id ? 3 : 0)} fill={genreColor(row.genre, genres)} opacity={matches(row) ? 1 : .2} stroke="#101625" strokeWidth="2" /><title>{row.title} · {number.format(row.play_count)} listens</title>
      </g>)}
      {current.map(row => <g key={`right-${row.track_id}`} className="node" onClick={() => onSelect({ side: 'current', id: row.track_id })} style={{ cursor: 'pointer' }} tabIndex="0" role="button" aria-label={`Current rank ${row.ranking}, ${row.title}, ${number.format(row.play_count)} listens`} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ side: 'current', id: row.track_id }) } }}>
        <circle cx="461" cy={yRight(row.ranking - 1)} r={radius(row.play_count) + (selected?.id === row.track_id ? 3 : 0)} fill={genreColor(row.genre, genres)} opacity={matches(row) ? 1 : .2} stroke="#101625" strokeWidth="2" /><title>{row.title} · {number.format(row.play_count)} listens</title>
      </g>)}
      <text x="20" y="730" fill="#8794ad" fontSize="11">PREVIOUS</text><text x="410" y="730" fill="#8794ad" fontSize="11">CURRENT →</text>
    </svg>
    <div className="network-foot">Width = modeled share <span>·</span> particles = direction only</div>
  </div>
}

function GenreMatrix({ previous, current, flows, genres, filterGenre, onGenre }) {
  const sourceById = new Map(previous.map(x => [x.track_id, x]))
  const targetById = new Map(current.map(x => [x.track_id, x]))
  const left = [...new Set(previous.map(x => x.genre))], right = [...new Set(current.map(x => x.genre))]
  const values = new Map()
  flows.forEach(flow => {
    const key = `${sourceById.get(flow.source_node)?.genre}|${targetById.get(flow.destination_node)?.genre}`
    values.set(key, (values.get(key) || 0) + flow.estimated_share)
  })
  return <section className="matrix card" aria-label="Estimated genre pairing matrix">
    <div className="section-top"><div><span className="eyebrow">02 / GENRE VIEW</span><h2>Within and between genres</h2></div><p>Each cell sums the same estimated song pairings. Diagonal cells pair a genre with itself.</p></div>
    <div className="matrix-scroll"><table><thead><tr><th scope="col">FROM ↓ / TO →</th>{right.map(g => <th scope="col" key={g}><span className="genre-swatch" style={{ background: genreColor(g, genres) }} />{g}</th>)}</tr></thead>
      <tbody>{left.map(a => <tr key={a}><th scope="row"><span className="genre-swatch" style={{ background: genreColor(a, genres) }} />{a}</th>{right.map(b => { const value = values.get(`${a}|${b}`) || 0; return <td key={b}><button className={`matrix-cell ${a === b ? 'diagonal' : ''} ${filterGenre !== 'All genres' && filterGenre !== a && filterGenre !== b ? 'dim' : ''}`} style={{ '--cell-opacity': Math.min(.72, .08 + value * 3) }} onClick={() => onGenre(a)} title={`${a} → ${b}: ${percent(value)} estimated share; no tracked listeners`}><b>{percent(value)}</b><small>{a === b ? 'within genre' : 'cross genre'}</small></button></td> })}</tr>)}</tbody></table></div>
  </section>
}

function Details({ selected, previous, current, flows, genres, onClose }) {
  const row = selected && (selected.side === 'previous' ? previous : current).find(x => x.track_id === selected.id)
  const previousById = new Map(previous.map(x => [x.track_id, x]))
  const currentById = new Map(current.map(x => [x.track_id, x]))
  if (!row) return <section className="detail card"><span className="eyebrow">READ THE MAP</span><h2>Follow a recording</h2><p>Choose a song on either side to inspect its chart count and the estimated links touching it.</p><div className="detail-empty"><span>↗</span><p>Every link is a modeled pairing of chart shares. No listener was tracked from one recording to another.</p></div></section>
  const counterpart = (selected.side === 'previous' ? currentById : previousById).get(row.track_id)
  const links = flows.filter(f => selected.side === 'previous' ? f.source_node === row.track_id : f.destination_node === row.track_id).sort((a,b) => b.estimated_share - a.estimated_share).slice(0, 5)
  const otherMap = selected.side === 'previous' ? currentById : previousById
  return <section className="detail card" aria-live="polite"><div className="detail-top"><span className="eyebrow">RECORDING DETAIL</span><button className="icon-button" onClick={onClose} aria-label="Close recording detail">×</button></div><div className="detail-genre"><span className="genre-swatch" style={{ background: genreColor(row.genre, genres) }} />{row.genre} · {row.genre_source.replace('_', ' ')} tags</div><h2>{row.title}</h2><p className="artist-name">{row.artist}</p><div className="detail-numbers"><div><small>{selected.side === 'previous' ? 'PREVIOUS' : 'CURRENT'} RANK</small><strong>#{row.ranking}</strong></div><div><small>RECORDED LISTENS</small><strong>{number.format(row.play_count)}</strong></div></div>
    <p className="comparison">{counterpart ? `Also visible at #${counterpart.ranking} on the ${selected.side === 'previous' ? 'current' : 'previous'} list (${number.format(counterpart.play_count)} listens).` : `Outside the ${selected.side === 'previous' ? 'current top 15' : 'previous top 10'} visible list.`} <em>Partial and full week counts are not directly comparable.</em></p>
    <div className="detail-flow-title"><strong>{selected.side === 'previous' ? 'Modeled destinations' : 'Modeled origins'}</strong><small>Share of all visible-list pairings</small></div>
    <ol className="flow-list">{links.map(flow => { const other = otherMap.get(selected.side === 'previous' ? flow.destination_node : flow.source_node); return <li key={`${flow.source_node}-${flow.destination_node}`}><span>{other?.title || 'Unknown'}</span><strong>{percent(flow.estimated_share)}</strong></li> })}</ol>
    {row.quality_status.some(x => x !== 'ok') && <p className="quality-note">Quality: {row.quality_status.filter(x => x !== 'ok').join(', ').replaceAll('_', ' ')}.</p>}
  </section>
}

export default function App() {
  const [manifest, setManifest] = useState(null)
  const [date, setDate] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [view, setView] = useState('songs')
  const [genre, setGenre] = useState('All genres')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [paused, setPaused] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false)

  useEffect(() => {
    fetch(`${BASE}data/manifest.json`, { cache: 'no-store' }).then(r => { if (!r.ok) throw Error(`Manifest HTTP ${r.status}`); return r.json() }).then(json => {
      if (json.schema_version !== 1 || !Array.isArray(json.snapshots)) throw Error('Unsupported manifest')
      setManifest(json); setDate(json.snapshots.at(-1)?.date || '')
    }).catch(e => setError(`Chart manifest unavailable: ${e.message}`))
  }, [])
  useEffect(() => {
    if (!date || !manifest) return
    const entry = manifest.snapshots.find(x => x.date === date)
    if (!entry) return
    setData(null); setSelected(null); setError('')
    fetch(`${BASE}data/${entry.path}`).then(r => { if (!r.ok) throw Error(`Snapshot HTTP ${r.status}`); return r.json() }).then(json => {
      if (json.schema_version !== 1 || json.previous_week.recordings.length !== 10 || json.current_week.recordings.length !== 15 || json.flows.some(f => f.status !== 'estimated' || f.number_of_listeners !== null)) throw Error('Snapshot validation failed')
      setData(json)
    }).catch(e => setError(e.message))
  }, [date, manifest])

  const previous = data?.previous_week.recordings || []
  const current = data?.current_week.recordings || []
  const genres = [...new Set([...previous, ...current].map(x => x.genre))].sort()
  const priorIds = new Set(previous.map(x => x.track_id))
  const currentIds = new Set(current.map(x => x.track_id))
  const sharedCount = current.filter(x => priorIds.has(x.track_id)).length
  const sourceAgeHours = data ? (Date.now() - new Date(data.current_week.source_last_updated_utc).getTime()) / 3600000 : 0

  return <div className="site-shell">
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark">♫</span><span>MUSIC / MIGRATION<span className="brand-light"> MAP</span></span></a><nav aria-label="Site sections"><a href="#explore">Explore</a><a href="#method">Method</a><a href="https://github.com/lidonmiguel/music-listening-migration-map">GitHub ↗</a></nav></header>
    <main id="top">
      <section className="hero"><div className="hero-copy"><div className="overline"><span className="live-dot" /> PUBLIC DATA EXPERIMENT <span className="overline-separator">/</span> WEEKLY CHARTS</div><h1>Where does the<br /><em>music go?</em></h1><p>Two weeks of songs. One map of changing chart attention. Explore what the rankings say—and where the data stops short.</p><a className="hero-link" href="#explore">Explore the map <span>↗</span></a></div><div className="hero-orbit" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><div className="hero-center">↗</div><div className="orbit-dot dot-one" /><div className="orbit-dot dot-two" /><div className="orbit-dot dot-three" /></div></section>
      <section className="truth-banner" aria-label="Interpretation warning"><div className="truth-icon">i</div><div><strong>These lines are estimates, not listener journeys.</strong><p>They pair the shares of songs in two public charts under an independence assumption. No individual listening histories are used.</p></div><a href="#method">How it works ↗</a></section>
      <section id="explore" className="explore"><div className="explore-heading"><div><span className="eyebrow">THE LISTENING LANDSCAPE</span><h2>Follow the attention</h2></div><div className="snapshot-status">{data ? <><span className="status-dot" />Snapshot {shortDate(`${data.snapshot_date}T00:00:00Z`)} · source last calculated {utcTime(data.current_week.source_last_updated_utc)}</> : 'Loading public charts…'}</div></div>
        {error ? <div className="load-state">{error}. The site shows no invented replacement data.</div> : !data ? <div className="load-state">Loading the recorded snapshot…</div> : <>
          <div className="metric-strip"><div><small>PREVIOUS WEEK</small><strong>10 <span>recordings</span></strong><p>{shortDate(data.previous_week.period_start_utc)}–{endDay(data.previous_week.period_end_utc)} UTC</p></div><div><small>CURRENT WEEK · INCOMPLETE</small><strong>15 <span>recordings</span></strong><p>{shortDate(data.current_week.period_start_utc)}–{endDay(data.current_week.period_end_utc)} UTC calendar week</p></div><div><small>IN BOTH VISIBLE LISTS</small><strong>{sharedCount} <span>recordings</span></strong><p>Membership, not a measured listener flow</p></div></div>
          <div className="source-callout"><span className="callout-symbol">!</span><div><strong>Current week is incomplete{sourceAgeHours > 36 ? ' · upstream update is delayed' : ''}.</strong><span>Last calculated {utcTime(data.current_week.source_last_updated_utc)}. The source does not state an exact last-listen cutoff; raw counts are not comparable with a finished week.</span></div></div>
          <div className="toolbar"><div className="timeline-control"><label htmlFor="snapshot">ACTUAL SNAPSHOTS</label><select id="snapshot" value={date} onChange={e => setDate(e.target.value)}>{manifest.snapshots.map(item => <option key={item.date} value={item.date}>{item.date}</option>)}</select></div><div className="segmented" role="group" aria-label="View"><button className={view === 'songs' ? 'on' : ''} onClick={() => setView('songs')}>Songs</button><button className={view === 'genres' ? 'on' : ''} onClick={() => setView('genres')}>Genres</button></div><div className="filter-control"><label htmlFor="genre">GENRE</label><select id="genre" value={genre} onChange={e => setGenre(e.target.value)}><option>All genres</option>{genres.map(g => <option key={g}>{g}</option>)}</select></div><div className="filter-control search-control"><label htmlFor="song-search">SONG / ARTIST</label><input id="song-search" type="search" placeholder="Find a song…" value={search} onChange={e => setSearch(e.target.value)} /></div><button className="pause-button" onClick={() => setPaused(x => !x)} aria-pressed={paused}>{paused ? '▶ Resume' : 'Ⅱ Pause'} motion</button></div>
          <div className="mode-line"><span className="eyebrow">FLOW TYPE</span><Tag tone="accent">● Estimated · independence baseline</Tag><span className="disabled-mode" title="No authorized same-listener histories have been supplied">○ Observed unavailable — no consented cohort</span></div>
          {view === 'songs' ? <><div className="map-grid"><Ranking title="Last week’s top 10" period={data.previous_week} rows={previous} side="previous" otherIds={currentIds} selected={selected} onSelect={setSelected} genres={genres} filterGenre={genre} search={search} /><Graph previous={previous} current={current} flows={data.flows} selected={selected} onSelect={setSelected} genres={genres} filterGenre={genre} search={search} paused={paused} /><Ranking title="This week’s top 15" period={data.current_week} rows={current} side="current" otherIds={priorIds} selected={selected} onSelect={setSelected} genres={genres} filterGenre={genre} search={search} /></div><div className="under-map"><Details selected={selected} previous={previous} current={current} flows={data.flows} genres={genres} onClose={() => setSelected(null)} /><div className="legend card"><span className="eyebrow">HOW TO READ THIS MAP</span><h2>Marks &amp; meaning</h2><div className="legend-list"><p><span className="legend-node">●</span><strong>Node area</strong> = recorded listens for that chart row.</p><p><span className="legend-line">⟶</span><strong>Line width</strong> = share of hypothetical visible-list pairings.</p><p><span className="legend-particle">✦</span><strong>Particle</strong> = direction cue only; quantity and speed encode nothing.</p><p><span className="legend-status">↺</span><strong>Stays / enters / leaves</strong> = visible-list membership.</p></div><div className="genre-legend">{genres.map(g => <span key={g}><span className="genre-swatch" style={{ background: genreColor(g, genres) }} />{g}</span>)}</div></div></div></> : <GenreMatrix previous={previous} current={current} flows={data.flows} genres={genres} filterGenre={genre} onGenre={setGenre} />}
          {data.data_quality_notes.length > 0 && <div className="quality-banner"><strong>Data quality</strong><ul>{data.data_quality_notes.map(note => <li key={note}>{note}</li>)}</ul></div>}
        </>}
      </section>
      <section id="method" className="method"><div className="method-intro"><span className="eyebrow">THE METHOD</span><h2>What we know.<br /><em>What we model.</em></h2><p>The source gives aggregate listen counts, not links between people across weeks. Keeping that boundary visible is the point of the project.</p></div><div className="method-cards"><article><span className="method-index">01 / OBSERVED CHART</span><h3>Real rankings</h3><p>ListenBrainz supplies sitewide recording rows and listen counts for the two calendar weeks. Node size uses those counts. A play is not a unique listener.</p></article><article><span className="method-index">02 / ESTIMATED LINK</span><h3>Independent shares</h3><p>For each connection, multiply a song’s share of the previous visible top 10 by a song’s share of the current visible top 15. The result is a modeled percentage, never a number of people.</p></article><article><span className="method-index">03 / FUTURE COHORT</span><h3>Observed movement</h3><p>Only consented, same-user histories could count weekly favorite changes. There is no such cohort in this prototype. This view will stay unavailable until one exists and privacy thresholds are met.</p></article></div><div className="method-footer"><a href="https://github.com/lidonmiguel/music-listening-migration-map/blob/main/docs/methods.md">Read the full data dictionary ↗</a><span>Source: <a href="https://listenbrainz.org/statistics/">ListenBrainz</a> · Genres: MusicBrainz tags</span></div></section>
    </main><footer><span>♫ MUSIC LISTENING MIGRATION MAP</span><span>Public aggregates · estimated flow · UTC weeks</span><a href="#top">Back to top ↑</a></footer>
  </div>
}
