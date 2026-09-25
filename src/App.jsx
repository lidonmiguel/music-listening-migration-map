import React, { useEffect, useMemo, useRef, useState } from 'react'
import { select, zoom, zoomIdentity } from 'd3'

const BASE = import.meta.env.BASE_URL
const WIDTH = 1200
const HEIGHT = 760
const COLORS = ['#86bbc5', '#d4a77d', '#aaa1cd', '#b2bf87', '#ca929c', '#8ba4d2', '#c4b478', '#91b6a2', '#c7a2b9', '#a8b8c9']
const format = new Intl.NumberFormat('en-US')
const dateLabel = value => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value))
const timeLabel = value => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(value)) + ' UTC'
const color = cluster => cluster === 'unlinked' ? '#8d99a8' : COLORS[(Number(cluster.slice(1)) - 1) % COLORS.length]
const initialPaused = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false

function useAnimatedPositions(artists, paused) {
  const [points, setPoints] = useState({})
  const last = useRef({})
  useEffect(() => {
    if (!artists.length) return
    const maximum = Math.max(...artists.map(artist => artist.listen_count), 1)
    const target = Object.fromEntries(artists.map(a => [a.id, { x: a.x * WIDTH, y: a.y * HEIGHT,
      r: 42 * Math.sqrt(a.listen_count / maximum) }]))
    if (paused || !Object.keys(last.current).length) {
      last.current = target
      setPoints(target)
      return
    }
    const start = last.current
    const began = performance.now()
    let frame
    const tick = now => {
      const t = Math.min(1, (now - began) / 850)
      const ease = 1 - Math.pow(1 - t, 3)
      const next = Object.fromEntries(Object.entries(target).map(([id, end]) => {
        const from = start[id] || { ...end, r: 0 }
        return [id, { x: from.x + (end.x - from.x) * ease,
          y: from.y + (end.y - from.y) * ease, r: from.r + (end.r - from.r) * ease }]
      }))
      last.current = next
      setPoints(next)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [artists, paused])
  return points
}

function ArtistMap({ data, selected, hovered, onSelect, onHover, search, paused, focusRef }) {
  const svgRef = useRef(null)
  const layerRef = useRef(null)
  const zoomRef = useRef(null)
  const artists = data.artists
  const points = useAnimatedPositions(artists, paused)
  const byId = useMemo(() => new Map(artists.map(a => [a.id, a])), [artists])
  const neighbors = useMemo(() => new Set(data.edges.filter(e => e.source === selected || e.target === selected)
    .map(e => e.source === selected ? e.target : e.source)), [data.edges, selected])
  const clusterGroups = useMemo(() => {
    const groups = new Map()
    artists.forEach(a => {
      if (a.cluster_id === 'unlinked') return
      if (!groups.has(a.cluster_id)) groups.set(a.cluster_id, [])
      groups.get(a.cluster_id).push(a)
    })
    return [...groups].filter(([, group]) => group.length >= 3).sort((a, b) => b[1].length - a[1].length)
  }, [artists])

  useEffect(() => {
    const behavior = zoom().scaleExtent([.68, 5]).on('zoom', event => {
      select(layerRef.current).attr('transform', event.transform)
    })
    zoomRef.current = behavior
    select(svgRef.current).call(behavior).on('dblclick.zoom', null)
    return () => select(svgRef.current).on('.zoom', null)
  }, [])
  useEffect(() => {
    focusRef.current = {
      focus: id => {
        const a = byId.get(id)
        if (!a || !zoomRef.current || !svgRef.current) return
        const scale = 1.65
        select(svgRef.current).call(zoomRef.current.transform,
          zoomIdentity.translate(WIDTH * .44 - a.x * WIDTH * scale,
            HEIGHT * .50 - a.y * HEIGHT * scale).scale(scale))
      },
      reset: () => select(svgRef.current).call(zoomRef.current.transform, zoomIdentity)
    }
  }, [byId, focusRef])

  const emphasis = selected || hovered
  const visibleEdges = selected
    ? data.edges.filter(e => e.source === selected || e.target === selected).slice(0, 28)
    : data.edges.slice(0, 165)
  const matches = a => !search || a.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  return <svg ref={svgRef} className="landscape" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    role="img" aria-label="Zoomable map of 100 ListenBrainz artists. Links show session-based affinity, not listener migration."
    onClick={() => onSelect(null)}>
    <defs>
      <filter id="haze"><feGaussianBlur stdDeviation="35" /></filter>
      <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1" fill="#889eac" opacity=".13" />
      </pattern>
    </defs>
    <g ref={layerRef}>
      <rect x="-1100" y="-900" width="3400" height="2600" fill="url(#dots)" />
      {clusterGroups.map(([id, group]) => {
        const x = group.reduce((sum, a) => sum + (points[a.id]?.x ?? a.x * WIDTH), 0) / group.length
        const y = group.reduce((sum, a) => sum + (points[a.id]?.y ?? a.y * HEIGHT), 0) / group.length
        return <circle key={id} cx={x} cy={y} r={65 + Math.sqrt(group.length) * 19}
          fill={color(id)} opacity=".095" filter="url(#haze)" pointerEvents="none" />
      })}
      {visibleEdges.map(e => {
        const a = points[e.source], b = points[e.target]
        if (!a || !b) return null
        const active = selected && (e.source === selected || e.target === selected)
        return <line key={e.source + e.target} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke={active ? color(byId.get(selected)?.cluster_id) : '#8495a9'}
          strokeWidth={active ? 1 + e.strength * 2.8 : .55 + e.strength * 1.1}
          opacity={active ? .72 : emphasis ? .075 : .18} pointerEvents="none" />
      })}
      {artists.map(a => {
        const point = points[a.id]
        if (!point) return null
        const active = a.id === selected
        const nearby = neighbors.has(a.id)
        const dim = (selected && !active && !nearby) || (search && !matches(a) && !active)
        const label = active || hovered === a.id || (!selected && !search && a.rank <= 18) || (search && matches(a))
        return <g key={a.id} className={`artist-node ${dim ? 'muted' : ''}`}
          transform={`translate(${point.x},${point.y})`}
          onClick={event => { event.stopPropagation(); onSelect(a.id) }}
          onMouseEnter={() => onHover(a.id)} onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(a.id)} onBlur={() => onHover(null)}
          role="button" tabIndex="0" aria-label={`${a.name}, rank ${a.rank}, ${format.format(a.listen_count)} recorded listens`}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(a.id) } }}>
          <circle className="node-hit" r={Math.max(15, point.r + 5)} fill="transparent" />
          {(active || hovered === a.id) && <circle r={point.r + 8} fill="none" stroke={color(a.cluster_id)} strokeWidth="1.4" opacity=".67" />}
          <circle r={point.r} fill={color(a.cluster_id)} stroke={active ? '#f5e8da' : '#d9e1e6'}
            strokeWidth={active ? 2 : .55} opacity={dim ? .24 : .89} />
          {label && <text x={point.r + 7} y="4" className={active ? 'node-label selected' : 'node-label'}>
            {a.name.length > 23 ? a.name.slice(0, 21) + '…' : a.name}</text>}
          <title>{a.name} · {format.format(a.listen_count)} this-week listens · {a.cluster_id}</title>
        </g>
      })}
    </g>
  </svg>
}

function ArtistDetail({ artist, data, onClose, onNeighbor }) {
  const byId = new Map(data.artists.map(a => [a.id, a]))
  const links = data.edges.filter(e => e.source === artist.id || e.target === artist.id)
    .sort((a, b) => b.strength - a.strength).slice(0, 6)
  const peers = data.artists.filter(a => a.cluster_id === artist.cluster_id)
  const leaders = peers.sort((a, b) => a.rank - b.rank).slice(0, 3).map(a => a.name).join(' · ')
  return <aside className="detail-panel" aria-label="Selected artist details">
    <div className="detail-head"><span className="micro">ARTIST / {String(artist.rank).padStart(3, '0')}</span>
      <button className="icon-button" onClick={onClose} aria-label="Close artist details">×</button></div>
    <div className="artist-avatar" style={{ '--artist-color': color(artist.cluster_id) }}>{artist.name.slice(0, 1).toLocaleUpperCase()}</div>
    <h2>{artist.name}</h2>
    <p className="community-caption"><i style={{ background: color(artist.cluster_id) }} />
      {artist.cluster_id === 'unlinked' ? 'No published affinity links' : `Community ${artist.cluster_id.slice(1)} · ${leaders}`}</p>
    <div className="detail-stats">
      <div><small>RECORDED LISTENS · THIS WEEK</small><strong>{format.format(artist.listen_count)}</strong></div>
      <div><small>CHANGE SINCE PRIOR SNAPSHOT</small><strong>{artist.change_since_previous_snapshot === null ? '—' :
        `${artist.change_since_previous_snapshot >= 0 ? '+' : '−'}${format.format(Math.abs(artist.change_since_previous_snapshot))}`}</strong></div>
    </div>
    <p className="detail-explain">{artist.previous_snapshot_date
      ? `Chart-count difference since ${artist.previous_snapshot_date}, within the same UTC week; source calculations may cover more than one day.`
      : 'No comparable prior source calculation for this artist and UTC week yet.'}</p>
    <div className="detail-section"><div className="detail-section-title"><span>NEAREST IN THIS MAP</span><small>relative session affinity</small></div>
      {links.length ? links.map(link => {
        const neighbor = byId.get(link.source === artist.id ? link.target : link.source)
        return <button key={link.source + link.target} className="neighbor" onClick={() => onNeighbor(neighbor.id)}>
          <span><i style={{ background: color(neighbor.cluster_id) }} />{neighbor.name}</span>
          <strong>{Math.round(link.strength * 100)}<small> / 100</small></strong>
        </button>
      }) : <p className="detail-explain">No strong session-affinity link among these 100 artists.</p>}
    </div>
    <div className="detail-section"><div className="detail-section-title"><span>REPORTED DAYS</span><small>subset of top artists</small></div>
      {artist.reported_daily_activity.length ? <div className="daily-bars">{artist.reported_daily_activity.map(day => {
        const maximum = Math.max(...artist.reported_daily_activity.map(d => d.listen_count), 1)
        return <div key={day.date} title={`${day.date}: ${format.format(day.listen_count)} listens`}>
          <span style={{ height: `${Math.max(4, day.listen_count / maximum * 62)}px`, background: color(artist.cluster_id) }} />
          <small>{dateLabel(day.date + 'T00:00:00Z')}</small>
        </div>
      })}</div> : <p className="detail-explain">Per-day artist rows are unavailable here; absence does not mean zero listens.</p>}
    </div>
    <div className="movement-empty"><span>↗</span><p><b>Listener movement unavailable.</b> These undirected links do not show people switching artists. No particles or incoming/outgoing counts are displayed.</p></div>
    <p className="detail-source">Source: ListenBrainz sitewide submissions · MBID {artist.id}</p>
  </aside>
}

export default function App() {
  const [manifest, setManifest] = useState(null)
  const [date, setDate] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const [hovered, setHovered] = useState(null)
  const [search, setSearch] = useState('')
  const [paused, setPaused] = useState(initialPaused)
  const [help, setHelp] = useState(false)
  const focusRef = useRef(null)

  useEffect(() => {
    fetch(`${BASE}data/manifest.json`, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw Error(`Manifest HTTP ${r.status}`); return r.json() })
      .then(json => {
        if (json.schema_version !== 2 || !json.snapshots?.length) throw Error('No artist snapshots')
        setManifest(json)
        setDate(json.snapshots.at(-1).date)
      }).catch(e => setError(e.message))
  }, [])
  useEffect(() => {
    if (!manifest || !date) return
    const entry = manifest.snapshots.find(item => item.date === date)
    if (!entry) return
    setError('')
    fetch(`${BASE}data/${entry.path}`)
      .then(r => { if (!r.ok) throw Error(`Snapshot HTTP ${r.status}`); return r.json() })
      .then(json => {
        if (json.schema_version !== 2 || json.artists?.length !== 100 ||
            json.movement?.status !== 'unavailable' || json.edges?.some(e => e.kind !== 'audience_affinity')) {
          throw Error('Artist snapshot validation failed')
        }
        setData(json)
        setSelected(current => json.artists.some(a => a.id === current) ? current : null)
      }).catch(e => setError(e.message))
  }, [date, manifest])

  const selectedArtist = data?.artists.find(a => a.id === selected)
  const matches = data?.artists.filter(a => a.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).slice(0, 8) || []
  const clusterGroups = data ? Object.entries(Object.groupBy(data.artists.filter(a => a.cluster_id !== 'unlinked'), a => a.cluster_id))
    .sort((a, b) => b[1].length - a[1].length).slice(0, 6) : []
  const age = data ? (Date.now() - new Date(data.window.source_last_updated_utc).getTime()) / 3600000 : 0
  const choose = id => { setSelected(id); setSearch(''); focusRef.current?.focus(id) }
  return <div className="site">
    <header className="topbar">
      <a className="wordmark" href="#top" onClick={() => focusRef.current?.reset()}><span className="logo-mark">◉</span> MUSIC / MIGRATION MAP</a>
      <span className="edition">THE ARTIST LANDSCAPE <b>01</b></span>
      <div className="top-actions"><a href="https://github.com/lidonmiguel/music-listening-migration-map" target="_blank" rel="noreferrer">SOURCE ↗</a><button onClick={() => setHelp(x => !x)} aria-expanded={help}>ABOUT THE DATA <span>↗</span></button></div>
    </header>
    <main id="top" className="map-page">
      <div className="map-intro"><span className="micro">LISTENBRAINZ · SITEWIDE SUBMISSIONS</span>
        <h1>A map of what<br /><em>we listen to.</em></h1>
        <p>100 identified artists. A landscape shaped by session affinity, sized by recorded listens. Explore who sits near whom.</p>
      </div>
      <div className="map-controls">
        <div className="search-wrap"><label htmlFor="artist-search" className="sr-only">Find an artist</label>
          <span className="search-icon">⌕</span><input id="artist-search" type="search" value={search}
            onChange={e => setSearch(e.target.value)} placeholder="Find an artist" autoComplete="off" />
          {search && <div className="search-results">{matches.length ? matches.map(a => <button key={a.id} onClick={() => choose(a.id)}>
            <i style={{ background: color(a.cluster_id) }} />{a.name}<small>#{a.rank}</small></button>) : <p>No artist in this top 100</p>}</div>}</div>
        <div className="zoom-buttons"><button onClick={() => focusRef.current?.reset()} aria-label="Reset map zoom">⌖</button>
          <button onClick={() => focusRef.current?.focus(selected || data?.artists[0]?.id)} aria-label="Zoom to selected artist">＋</button></div>
      </div>
      {error ? <div className="error-state">Unable to load the recorded artist snapshot: {error}. No substitute data is shown.</div> :
        !data ? <div className="loading-state"><span className="loading-ring" />Mapping the recorded landscape…</div> :
        <>
          <ArtistMap data={data} selected={selected} hovered={hovered} onSelect={setSelected}
            onHover={setHovered} search={search} paused={paused} focusRef={focusRef} />
          {selectedArtist && <ArtistDetail artist={selectedArtist} data={data} onClose={() => setSelected(null)} onNeighbor={choose} />}
          <div className="map-side-note"><span className="note-line" />DRAG TO MOVE<br />SCROLL TO EXPLORE</div>
          <div className="legend-inline"><span><i className="size-symbol" /> circle area = this-week listens</span>
            <span><i className="link-symbol" /> line = session affinity</span>
            <span>NO MOVEMENT PARTICLES · UNMEASURED</span></div>
          <div className="map-footer">
            <div className="date-control"><span className="micro">01 / RECORDED DATE</span>
              <select aria-label="Recorded snapshot date" value={date} onChange={e => setDate(e.target.value)}>
                {manifest.snapshots.map(item => <option key={item.date} value={item.date}>{item.date}</option>)}
              </select>
              <span className="date-count">{manifest.snapshots.length} actual snapshot{manifest.snapshots.length === 1 ? '' : 's'}</span>
            </div>
            <div className="source-window"><span className="micro">02 / SOURCE WINDOW</span><strong>{dateLabel(data.window.period_start_utc)}–{dateLabel(new Date(new Date(data.window.period_end_utc_calendar).getTime() - 86400000).toISOString())} UTC · {data.window.is_partial ? 'incomplete week' : 'complete week'}</strong>
              <small>Last calculated {timeLabel(data.window.source_last_updated_utc)}{age > 36 ? ' · delayed upstream' : ''}</small></div>
            <div className="mode-status"><span className="micro">03 / WHAT THE MAP SHOWS</span>
              <div><span className="status-active">● MEASURED ACTIVITY</span><span className="status-affinity">◌ SESSION AFFINITY</span><span className="status-off">↗ MOVEMENT UNAVAILABLE</span></div></div>
            <button className="motion-button" onClick={() => setPaused(x => !x)} aria-pressed={paused}>
              {paused ? '▶' : 'Ⅱ'} <span>{paused ? 'RESUME' : 'PAUSE'} MOTION</span></button>
          </div>
          <div className="cluster-key"><span className="micro">AFFINITY COMMUNITIES</span>
            {clusterGroups.map(([id, members]) => <span key={id}><i style={{ background: color(id) }} />
              {members.slice().sort((a, b) => a.rank - b.rank)[0].name} <small>+{members.length - 1}</small></span>)}
          </div>
          <div className="source-disclosure">Sitewide top 100 among artists with MusicBrainz IDs; unmatched credits excluded ({data.quality.excluded_missing_mbid} of {data.quality.rows_examined} chart rows).
            Affinity uses a separately updated session index, not this week's shared-listener counts. No observed listener migrations.</div>
        </>}
    </main>
    {help && <div className="help-scrim" onClick={() => setHelp(false)}><section className="help-sheet" onClick={e => e.stopPropagation()} aria-label="Map data explanation">
      <button className="icon-button" onClick={() => setHelp(false)} aria-label="Close explanation">×</button>
      <span className="micro">HOW TO READ THE LANDSCAPE</span><h2>Three different things.</h2>
      <p><b>Measured activity.</b> Circle area follows the artist's recorded ListenBrainz listens in the current UTC week. On a new source calculation, circles change size. A daily collection with unchanged source data adds no new date.</p>
      <p><b>Session affinity.</b> Lines are undirected normalized scores from ListenBrainz's separate similar-artist session index. Communities use Louvain detection on that graph. Lines are not exact shared audiences this week.</p>
      <p><b>Listener movement.</b> Unavailable. Counting switches requires the same consented users' chronological histories across defined periods. This site has no such dataset and shows no migrating-user particles.</p>
      <p>Weekday artist rows are supplied for a subset of popular artists only. Counts are listens, not distinct listeners; the index's observation horizon does not match the chart week.</p>
      <a href="https://github.com/lidonmiguel/music-listening-migration-map/blob/main/docs/methods.md" target="_blank" rel="noreferrer">FULL METHOD & DATA DICTIONARY ↗</a>
    </section></div>}
  </div>
}
