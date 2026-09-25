import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { interpolateRgb, select, zoom, zoomIdentity, zoomTransform } from 'd3'

const BASE = import.meta.env.BASE_URL
const WIDTH = 1400
const HEIGHT = 800
const COLORS = ['#91c1c8', '#d2aa89', '#b4a8d3', '#b6c691', '#ca9ba8', '#91add2', '#cfbd87', '#8fbbae', '#c7a7c1', '#aebbc7']
const number = new Intl.NumberFormat('en-US')
const prefersReduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false
const color = id => id === 'unlinked' ? '#94a2ad' : COLORS[(Number(id?.slice(1)) - 1 + COLORS.length) % COLORS.length]
const radius = count => 5 + 27 * Math.sqrt(count / (count + 25000)) // fixed saturating scale; area is not proportional
const weekLabel = week => `${week.id.slice(-3)} · ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(week.start + 'T00:00:00Z'))}–${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(week.end_exclusive + 'T00:00:00Z').getTime() - 86400000)}`
const readableTime = value => value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(value)) + ' UTC' : 'unknown'
const freshness = value => {
  if (!value) return 'Source calculation time unavailable'
  const age = Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000)
  return age < 24 ? 'Source calculated within the last day' : `Source last calculated ${Math.floor(age / 24)} day${Math.floor(age / 24) === 1 ? '' : 's'} ago; newer listens may be missing`
}
const graphEdges = data => data?.weekly_relationship_status === 'measured_weighted_jaccard' ? data.weekly_edges : (data?.reference_edges || [])
const graphMode = data => data?.weekly_relationship_status === 'measured_weighted_jaccard' ? 'Weekly shared audience · weighted Jaccard' : data?.reference_edges?.length ? 'Session affinity reference · not weekly overlap' : 'Audience relationships unavailable'
const edgeKey = edge => `${edge.source}:${edge.target}`

function useScene(data, reduced) {
  const [scene, setScene] = useState({ artists: [], edges: [] })
  const previous = useRef(null)
  useEffect(() => {
    if (!data) {
      previous.current = null
      setScene({ artists: [], edges: [] })
      return
    }
    const target = {
      artists: data.artists.map(a => ({ ...a, px: 30 + a.x * (WIDTH - 60), py: 18 + a.y * (HEIGHT - 36),
        r: radius(a.listen_count), opacity: 1, fill: color(a.cluster_id) })),
      edges: graphEdges(data).map(e => ({ ...e, opacity: 1 })),
      week_id: data.week_id, status: data.status, end_exclusive: data.end_exclusive
    }
    const start = previous.current
    const adjacentCompleted = start?.status === 'complete' && target.status === 'complete' &&
      Math.abs(new Date(target.end_exclusive) - new Date(start.end_exclusive)) === 7 * 86400000
    if (reduced || !adjacentCompleted) {
      previous.current = target
      setScene(target)
      return
    }
    const oldNodes = new Map(start.artists.map(a => [a.id, a]))
    const newNodes = new Map(target.artists.map(a => [a.id, a]))
    const oldEdges = new Map(start.edges.map(e => [edgeKey(e), e]))
    const newEdges = new Map(target.edges.map(e => [edgeKey(e), e]))
    const began = performance.now()
    let frame
    const tick = now => {
      const t = Math.min(1, (now - began) / 1050)
      const ease = t * t * (3 - 2 * t)
      const artists = [...new Set([...oldNodes.keys(), ...newNodes.keys()])].map(id => {
        const from = oldNodes.get(id) || { ...newNodes.get(id), r: 2, opacity: 0 }
        const to = newNodes.get(id) || { ...from, r: 2, opacity: 0 }
        return { ...to, px: from.px + (to.px - from.px) * ease,
          py: from.py + (to.py - from.py) * ease, r: from.r + (to.r - from.r) * ease,
          opacity: from.opacity + (to.opacity - from.opacity) * ease,
          fill: interpolateRgb(from.fill, to.fill)(ease) }
      })
      const edges = [...new Set([...oldEdges.keys(), ...newEdges.keys()])].map(id => {
        const from = oldEdges.get(id) || { ...newEdges.get(id), opacity: 0, strength: 0 }
        const to = newEdges.get(id) || { ...from, opacity: 0, strength: 0 }
        return { ...to, opacity: from.opacity + (to.opacity - from.opacity) * ease,
          strength: from.strength + (to.strength - from.strength) * ease }
      })
      previous.current = { artists, edges }
      setScene(previous.current)
      if (t < 1) frame = requestAnimationFrame(tick)
      else previous.current = target
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  // Do not restart the transition for each animation frame.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, reduced])
  return scene
}

function ArtistMap({ data, scene, selected, selectedEdge, search, onSelect, onEdge, focusRef }) {
  const svg = useRef(null)
  const layer = useRef(null)
  const behavior = useRef(null)
  const [hovered, setHovered] = useState(null)
  const nodes = useMemo(() => new Map(scene.artists.map(a => [a.id, a])), [scene.artists])
  const currentEdges = graphEdges(data)
  const neighborEdges = selected ? currentEdges.filter(e => e.source === selected || e.target === selected)
    .sort((a, b) => b.strength - a.strength).slice(0, 5) : []
  const neighbors = new Set(neighborEdges.map(e => e.source === selected ? e.target : e.source))
  const meaningful = scene.edges.filter(edge => {
    if (selected) return neighborEdges.some(e => edgeKey(e) === edgeKey(edge))
    if (selectedEdge) return edgeKey(edge) === edgeKey(selectedEdge)
    return edge.strength >= (data?.weekly_relationship_status === 'measured_weighted_jaccard' ? .012 : .22)
  }).sort((a, b) => b.strength - a.strength)
  const degree = new Map()
  const visible = meaningful.filter(edge => {
    if (selected || selectedEdge) return true
    if ((degree.get(edge.source) || 0) >= 4 || (degree.get(edge.target) || 0) >= 4) return false
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
    return true
  }).slice(0, selected ? 9 : 65)
  const clusters = Object.entries(Object.groupBy(scene.artists.filter(a => a.opacity > .5 && a.cluster_id !== 'unlinked'), a => a.cluster_id))
    .filter(([, group]) => group.length >= 3)

  useEffect(() => {
    const move = zoom().scaleExtent([.7, 5]).on('zoom', event => select(layer.current).attr('transform', event.transform))
    behavior.current = move
    select(svg.current).call(move).on('dblclick.zoom', null)
    return () => select(svg.current).on('.zoom', null)
  }, [])
  useEffect(() => {
    focusRef.current = {
      reveal: id => {
        const a = nodes.get(id), element = svg.current
        if (!a || !element) return
        const current = zoomTransform(element)
        const x = a.px * current.k + current.x, y = a.py * current.k + current.y
        // Leave room for the node label as well as the desktop detail sheet.
        const dx = x > WIDTH * .58 ? WIDTH * .52 - x : 0
        const dy = window.innerWidth <= 700 && y > HEIGHT * .52 ? HEIGHT * .52 - y : 0
        if (dx || dy) select(element).call(behavior.current.transform,
          zoomIdentity.translate(current.x + dx, current.y + dy).scale(current.k))
      },
      focus: id => {
        const a = nodes.get(id)
        if (!a) return
        const scale = 1.18
        select(svg.current).call(behavior.current.transform,
          zoomIdentity.translate(WIDTH * .46 - a.px * scale, HEIGHT * .43 - a.py * scale).scale(scale))
      },
      reset: () => select(svg.current).call(behavior.current.transform, zoomIdentity)
    }
  }, [nodes, focusRef])

  return <svg ref={svg} className="landscape" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid slice"
    aria-label="Zoomable weekly artist landscape; lines show their stated affinity source, never listener movement"
    role="img" onClick={() => { onSelect(null); onEdge(null) }}>
    <defs><filter id="haze"><feGaussianBlur stdDeviation="36" /></filter>
      <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".8" fill="#8ea4af" opacity=".17" /></pattern></defs>
    <g ref={layer}>
      <rect x="-1500" y="-900" width="4500" height="2600" fill="url(#dots)" />
      {clusters.map(([id, members]) => {
        const x = members.reduce((sum, a) => sum + a.px, 0) / members.length
        const y = members.reduce((sum, a) => sum + a.py, 0) / members.length
        return <g key={id} pointerEvents="none"><circle cx={x} cy={y} r={65 + 17 * Math.sqrt(members.length)}
          fill={color(id)} opacity=".10" filter="url(#haze)" />
          {members.length >= 5 && <text className="community-label" x={x} y={y - 62 - 14 * Math.sqrt(members.length)}>
            COMMUNITY {id.slice(1)} · {members.length} ARTISTS</text>}</g>
      })}
      {visible.map(edge => {
        const a = nodes.get(edge.source), b = nodes.get(edge.target)
        if (!a || !b) return null
        const emphasis = selected || selectedEdge
        const active = selectedEdge ? edgeKey(edge) === edgeKey(selectedEdge) : selected && (edge.source === selected || edge.target === selected)
        return <line key={edgeKey(edge)} x1={a.px} y1={a.py} x2={b.px} y2={b.py}
          className="map-connection" stroke={active ? color(data?.artists.find(x => x.id === (selected || edge.source))?.cluster_id) : '#93aeb8'}
          strokeWidth={(active ? 1.5 : .75) + edge.strength * (active ? 3 : 1.9)}
          opacity={edge.opacity * (active ? .9 : emphasis ? .24 : .32)}
          onClick={event => { event.stopPropagation(); onEdge(edge) }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdge(edge) } }}
          role="button" tabIndex="0"
          aria-label={`Inspect ${data?.artists.find(x => x.id === edge.source)?.name || 'artist'} and ${data?.artists.find(x => x.id === edge.target)?.name || 'artist'} connection`} />
      })}
      {scene.artists.map(a => {
        if (a.opacity <= .005) return null
        const active = selected === a.id
        const dim = (selected && !active && !neighbors.has(a.id)) || (search && !a.name.toLowerCase().includes(search.toLowerCase()) && !active)
        const label = active || neighbors.has(a.id) || hovered === a.id || (a.rank <= 10 && !selected) || (search && a.name.toLowerCase().includes(search.toLowerCase()))
        return <g key={a.id} className={`artist-node ${dim ? 'muted' : ''}`}
          transform={`translate(${a.px},${a.py})`} opacity={a.opacity}
          role="button" tabIndex="0" aria-label={`${a.name}, rank ${a.rank}, ${number.format(a.listen_count)} listens`}
          onClick={event => { event.stopPropagation(); onSelect(a.id) }}
          onMouseEnter={() => setHovered(a.id)} onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered(a.id)} onBlur={() => setHovered(null)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(a.id) } }}>
          <circle className="node-hit" r={Math.max(17, a.r + 5)} fill="transparent" />
          {(active || hovered === a.id) && <circle r={a.r + 7} fill="none" stroke={a.fill} strokeWidth="1.4" />}
          <circle r={a.r} fill={a.fill} opacity={dim ? .65 : .88} stroke={active ? '#fff0df' : '#d8e2e5'} strokeWidth={active ? 2 : .55} />
          {label && <text className="node-label" x={a.r + 7} y="4">{a.name.length > 22 ? a.name.slice(0, 21) + '…' : a.name}</text>}
          <title>{a.name} · {number.format(a.listen_count)} listens · {a.cluster_id}</title>
        </g>
      })}
    </g>
  </svg>
}

function ArtistDetail({ id, data, weeks, cache, series, onClose, onFollow, playing }) {
  const known = weeks.flatMap(w => cache[`${series}:${w.id}`]?.artists || []).find(a => a.id === id)
  const current = data?.artists.find(a => a.id === id)
  const artist = current || known
  if (!artist) return <aside className="detail-panel"><button onClick={onClose}>Close</button><p>Loading this artist’s recorded weeks…</p></aside>
  const history = weeks.map((week, index) => {
    const snap = cache[`${series}:${week.id}`]
    const a = snap?.artists.find(item => item.id === id)
    const before = cache[`${series}:${weeks[index - 1]?.id}`]
    const prior = before?.artists.some(item => item.id === id)
    let event = ''
    if (before?.status === 'complete' && snap?.status === 'complete') {
      if (a && !prior) event = 'Entered visible 100'
      if (!a && prior) event = 'Left visible 100'
    }
    const neighbors = snap && a ? graphEdges(snap).filter(edge => edge.source === id || edge.target === id)
      .sort((x, y) => y.strength - x.strength).slice(0, 2)
      .map(edge => snap.artists.find(other => other.id === (edge.source === id ? edge.target : edge.source))?.name).filter(Boolean) : []
    return { week, snap, a, event, neighbors }
  }).filter(row => row.week.status !== 'missing' && row.snap)
  const completedHistory = history.filter(row => row.week.status === 'complete')
  const preview = history.find(row => row.week.status === 'partial')
  const currentNeighbors = current ? graphEdges(data).filter(edge => edge.source === id || edge.target === id)
    .sort((x, y) => y.strength - x.strength).slice(0, 5)
    .map(edge => ({ name: data.artists.find(other => other.id === (edge.source === id ? edge.target : edge.source))?.name,
      strength: edge.strength })).filter(edge => edge.name) : []
  return <aside className="detail-panel" aria-label="Selected artist details">
    <div className="detail-head"><span className="micro">ARTIST / {current ? `#${current.rank}` : 'OUTSIDE TOP 100'}</span>
      <button className="icon-button" aria-label="Close artist details" onClick={onClose}>×</button></div>
    <div className="artist-avatar" style={{ '--artist-color': color(artist.cluster_id) }}>{artist.name.slice(0, 1)}</div>
    <h2>{artist.name}</h2>
    <p className="community-caption">{current ? `Community ${artist.cluster_id === 'unlinked' ? 'unlinked' : artist.cluster_id.slice(1)} · algorithmic group` : 'Not in this week’s visible top 100'}</p>
    <div className="detail-stats"><div><small>THIS WEEK’S RECORDED LISTENS</small><strong>{current ? number.format(current.listen_count) : '—'}</strong></div>
      <div><small>WEEKLY RANK</small><strong>{current ? `#${current.rank}` : '—'}</strong></div></div>
    <p className="detail-explain">{current ? `${data.status === 'partial' ? 'Incomplete week. ' : ''}Exact count from the stated source; circle size uses a fixed saturating scale.` : 'Outside the published top 100 is not zero listens.'}</p>
    {currentNeighbors.length > 0 && <div className="detail-section"><div className="detail-section-title">CLOSEST {data.weekly_relationship_status === 'measured_weighted_jaccard' ? 'WEEKLY AUDIENCES' : 'REFERENCE AFFINITIES'}</div>
      <div className="neighbor-list">{currentNeighbors.map(edge => <span key={edge.name}>{edge.name} <small>{Math.round(edge.strength * 100)} / 100</small></span>)}</div>
      <p className="detail-explain">{data.weekly_relationship_status === 'measured_weighted_jaccard' ? 'Same-week shared audience, not listener migration.' : 'Nonweekly session affinity, not measured listener migration.'}</p></div>}
    <button className="follow-button" disabled={!playing && !weeks.some((w, n) => n > weeks.findIndex(x => x.id === data?.week_id) && w.status === 'complete' && weeks[n - 1]?.status === 'complete')}
      onClick={onFollow}>{playing ? 'Ⅱ Pause artist journey' : '▶ Follow completed weeks'}</button>
    <div className="detail-section"><div className="detail-section-title">COMPLETED WEEK HISTORY <small>{completedHistory.length} loaded</small></div>
      <div className="history-list">{completedHistory.map(row => <div key={row.week.id} className="history-row">
        <span>{row.week.id.slice(-3)}</span>
        <strong>{row.a ? number.format(row.a.listen_count) : 'Outside 100'}</strong>
        {row.event && <small>{row.event}</small>}
        {row.neighbors.length > 0 && <small>{row.snap.weekly_relationship_status === 'measured_weighted_jaccard' ? 'Weekly audience: ' : 'Reference affinity: '}{row.neighbors.join(' · ')}</small>}
      </div>)}</div>
    </div>
    {preview && <div className="preview-history"><span>LIVE PREVIEW · {preview.week.id.slice(-3)}</span><strong>{preview.a ? number.format(preview.a.listen_count) : 'Outside 100'}</strong><small>Incomplete; excluded from completed-week playback and change calculations.</small></div>}
    <p className="detail-explain">Entry and exit labels require adjacent completed observations. Outside the top 100 does not mean zero listens.</p>
    <p className="detail-source">MusicBrainz artist ID · {id}</p>
  </aside>
}

function ConnectionDetail({ edge, data, onClose }) {
  const a = data?.artists.find(x => x.id === edge.source)
  const b = data?.artists.find(x => x.id === edge.target)
  const weekly = edge.kind === 'weekly_weighted_jaccard'
  return <aside className="detail-panel" aria-label="Selected connection details">
    <div className="detail-head"><span className="micro">RELATIONSHIP / UNDIRECTED</span>
      <button className="icon-button" aria-label="Close connection details" onClick={onClose}>×</button></div>
    <h2>{a?.name || 'Artist'} <span className="ampersand">&</span> {b?.name || 'artist'}</h2>
    <p className="detail-explain">{weekly ? 'Measured audience overlap within this complete dump week.' : 'Session-based affinity from a separate, nonweekly ListenBrainz index.'}</p>
    <div className="detail-stats"><div><small>{weekly ? 'WEIGHTED JACCARD' : 'RELATIVE SESSION SCORE'}</small><strong>{Math.round(edge.strength * 100)} / 100</strong></div>
      <div><small>SHARED LISTENERS</small><strong>{weekly ? number.format(edge.shared_listener_count) : 'Unknown'}</strong></div></div>
    <div className="movement-empty">This undirected connection does not show listeners moving from one artist to the other.</div>
  </aside>
}

export default function App() {
  const [manifests, setManifests] = useState({})
  const [series, setSeries] = useState('live')
  const [year, setYear] = useState(2026)
  const [index, setIndex] = useState(0)
  const [cache, setCache] = useState({})
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1.8)
  const [reduced, setReduced] = useState(prefersReduced)
  const [selected, setSelected] = useState(null)
  const [selectedEdge, setSelectedEdge] = useState(null)
  const [search, setSearch] = useState('')
  const [help, setHelp] = useState(false)
  const focusRef = useRef(null)
  const inflight = useRef(new Map())
  const cacheRef = useRef({})

  useEffect(() => {
    async function start() {
      try {
        const response = await fetch(`${BASE}data/weekly/manifest.json`, { cache: 'no-store' })
        if (!response.ok) throw Error(`Weekly manifest HTTP ${response.status}`)
        const live = await response.json()
        if (live.schema_version !== 3) throw Error('Unsupported weekly manifest')
        let dump = null
        const optional = await fetch(`${BASE}data/weekly-dump/manifest.json`, { cache: 'no-store' })
        if (optional.ok) dump = await optional.json()
        setManifests({ live, ...(dump?.schema_version === 3 ? { dump } : {}) })
        setYear(live.default_year)
        const slots = live.years[String(live.default_year)]?.weeks || []
        setIndex(Math.max(0, slots.findIndex(w => w.status === 'complete')))
      } catch (cause) { setError(cause.message) }
    }
    start()
  }, [])

  const manifest = manifests[series]
  const years = manifest ? Object.keys(manifest.years).map(Number).sort((a, b) => b - a) : []
  const weeks = manifest?.years[String(year)]?.weeks || []
  const week = weeks[index]
  const key = week && `${series}:${week.id}`
  const data = key && week.status !== 'missing' ? cache[key] : null
  const scene = useScene(data, reduced)

  const loadWeek = useCallback((entry, selectedSeries) => {
    if (!entry?.path || entry.status === 'missing') return Promise.resolve(null)
    const identity = `${selectedSeries}:${entry.id}`
    if (cacheRef.current[identity]) return Promise.resolve(cacheRef.current[identity])
    if (inflight.current.has(identity)) return inflight.current.get(identity)
    const task = fetch(`${BASE}data/${entry.path}?v=${entry.signature}`, { cache: 'no-store' })
      .then(response => { if (!response.ok) throw Error(`Week ${entry.id}: HTTP ${response.status}`); return response.json() })
      .then(snapshot => {
        if (snapshot.schema_version !== 3 || snapshot.week_id !== entry.id || snapshot.artists?.length !== 100 ||
            snapshot.status !== entry.status || snapshot.movement?.observed_transitions?.length) {
          throw Error(`Week ${entry.id}: invalid snapshot`)
        }
        setCache(current => {
          const next = { ...current, [identity]: snapshot }
          cacheRef.current = next
          return next
        })
        return snapshot
      }).finally(() => inflight.current.delete(identity))
    inflight.current.set(identity, task)
    return task
  }, [])
  useEffect(() => {
    if (!week || week.status === 'missing') return
    loadWeek(week, series).catch(cause => setError(cause.message))
    const next = weeks[index + 1]
    if (next?.status !== 'missing') loadWeek(next, series).catch(() => {})
  }, [week, index, weeks, series, loadWeek])
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    async function fillHistory() {
      for (const entry of weeks) {
        if (cancelled) return
        if (entry.status !== 'missing') await loadWeek(entry, series).catch(() => {})
      }
    }
    fillHistory()
    return () => { cancelled = true }
  }, [selected, weeks, series, loadWeek])
  useEffect(() => {
    if (!playing) return
    const next = weeks[index + 1]
    if (weeks[index]?.status !== 'complete' || next?.status !== 'complete') { setPlaying(false); return }
    const timer = window.setTimeout(() => { setIndex(index + 1); if (weeks[index + 2]?.status !== 'complete') setPlaying(false) }, speed * 1000)
    return () => window.clearTimeout(timer)
  }, [playing, index, weeks, speed])

  const chooseWeek = value => { setPlaying(false); setSelectedEdge(null); setIndex(Math.max(0, Math.min(weeks.length - 1, value))) }
  const chooseArtist = id => { setPlaying(false); setSelected(id); setSelectedEdge(null); setSearch(''); if (id) focusRef.current?.reveal(id); else focusRef.current?.reset() }
  const chooseEdge = edge => { setPlaying(false); setSelectedEdge(edge); setSelected(null) }
  const available = weeks.filter(item => item.status !== 'missing')
  const completed = weeks.map((item, n) => ({ ...item, index: n })).filter(item => item.status === 'complete')
  const preview = weeks.findIndex(item => item.status === 'partial')
  const completedPosition = completed.findIndex(item => item.index === index)
  const canPlay = week?.status === 'complete' && weeks[index + 1]?.status === 'complete'
  const previousCompleted = completed.filter(item => item.index < index).at(-1)
  const nextCompleted = completed.find(item => item.index > index)
  const knownArtists = data?.artists || available.flatMap(item => cache[`${series}:${item.id}`]?.artists || [])
  const results = [...new Map(knownArtists.filter(a => a.name.toLowerCase().includes(search.toLowerCase())).map(a => [a.id, a])).values()].slice(0, 8)
  const isFuture = week && new Date(week.start + 'T00:00:00Z') > new Date()
  return <div className="site">
    <header className="topbar"><a className="wordmark" href="#top" onClick={() => focusRef.current?.reset()}><span className="logo-mark">◉</span> MUSIC / MIGRATION MAP</a>
      <span className="edition">THE WEEKLY ARTIST LANDSCAPE</span>
      <div className="top-actions"><a href="https://github.com/lidonmiguel/music-listening-migration-map" target="_blank" rel="noreferrer">SOURCE ↗</a>
        <button onClick={() => setHelp(true)}>ABOUT THE DATA ↗</button></div></header>
    <main id="top" className="map-page">
      <div className="map-intro"><span className="micro">LISTENBRAINZ · WEEKLY LANDSCAPE</span>
        <h1>A landscape <em>in motion.</em></h1>
        <p>100 artists each observed week. Watch recorded activity change; the map’s motion is not tracked listeners.</p></div>
      <div className="map-controls"><div className="search-wrap"><label className="sr-only" htmlFor="artist-search">Find an artist</label>
        <span className="search-icon">⌕</span><input id="artist-search" type="search" value={search} placeholder="Find an artist"
          onChange={event => setSearch(event.target.value)} />
        {search && <div className="search-results">{results.length ? results.map(a => <button key={a.id} onClick={() => chooseArtist(a.id)}>{a.name}<small>#{a.rank}</small></button>) : <p>No recorded artist matches</p>}</div>}</div>
        <div className="zoom-buttons"><button aria-label="Reset zoom" onClick={() => focusRef.current?.reset()}>⌖</button>
          <button aria-label="Zoom to selected artist" onClick={() => focusRef.current?.focus(selected || data?.artists[0]?.id)}>＋</button></div></div>
      {error ? <div className="error-state">Recorded data could not load: {error}</div> : !manifest ? <div className="loading-state">Loading measured weeks…</div> : <>
        <ArtistMap data={data} scene={scene} selected={selected} selectedEdge={selectedEdge} search={search}
          onSelect={chooseArtist} onEdge={chooseEdge} focusRef={focusRef} />
        {week?.status === 'missing' && <div className="gap-state"><span className="micro">NO OBSERVED SNAPSHOT</span>
          <h2>{isFuture ? 'This week has not happened yet.' : 'This week is missing.'}</h2>
          <p>No ranking or audience graph has been invented for {week.id}.</p>
          <button onClick={() => chooseWeek(completed[0]?.index ?? preview)}>Jump to recorded week</button></div>}
        {week?.status !== 'missing' && !data && <div className="loading-state">Loading {week?.id}…</div>}
        {selected && <ArtistDetail id={selected} data={data} weeks={weeks} cache={cache} series={series}
          playing={playing} onClose={() => chooseArtist(null)} onFollow={() => { if (canPlay || playing) setPlaying(value => !value) }} />}
        {selectedEdge && data && <ConnectionDetail edge={selectedEdge} data={data} onClose={() => setSelectedEdge(null)} />}
        <div className="legend-inline"><span><i className="size-symbol" /> circle = recorded listens · saturating scale</span>
          <span><i className="link-symbol" /> {graphMode(data)}</span><span>NO LISTENER-MOVEMENT PARTICLES</span></div>
        <div className="timeline"><div className="timeline-head"><div><span className="micro">{week?.status === 'partial' ? 'LIVE PREVIEW' : 'COMPLETED WEEK'} · {year}</span>
            <h2>{week ? weekLabel(week) : 'No week'} <small>UTC · {week?.status === 'partial' ? 'WEEK IN PROGRESS' : week?.status === 'complete' ? 'COMPLETE' : 'MISSING'}</small></h2></div>
            <div className="timeline-source">{data ? <><strong>{data.source.population}</strong><small>{data.source.last_calculated_utc ? `Source calculated ${readableTime(data.source.last_calculated_utc)} · ${freshness(data.source.last_calculated_utc)}` : `Archive captured ${data.source.archive_captured_date}; historical batch, not a live update`}</small></> : <span>Only genuine weeks appear as observations.</span>}</div></div>
          <div className="timeline-row"><div className="transport"><button aria-label="Previous completed week" disabled={!previousCompleted} onClick={() => chooseWeek(previousCompleted.index)}>‹</button>
            <button className="play-button" aria-label={playing ? 'Pause playback' : 'Play weekly snapshots'}
              disabled={!playing && !canPlay}
              onClick={() => setPlaying(value => !value)}>{playing ? 'Ⅱ PAUSE' : '▶ PLAY'}</button>
            <button aria-label="Next completed week" disabled={!nextCompleted} onClick={() => chooseWeek(nextCompleted.index)}>›</button></div>
            <div className={`week-track ${completed.length < 3 ? 'short-track' : ''}`}>
              {completed.length < 3 ? <div className="short-weeks">{completed.map(item => <button key={item.id}
                aria-pressed={index === item.index} onClick={() => chooseWeek(item.index)}>{item.id}</button>)}</div> : <>
                <div className="week-marks">{completed.map(item => <span key={item.id} title={`${item.id}: completed`}
                  className={item.index === index ? 'complete chosen' : 'complete'} />)}</div>
                <input type="range" min="0" max={completed.length - 1} value={Math.max(0, completedPosition)}
                  aria-label="Select completed week" onChange={event => chooseWeek(completed[Number(event.target.value)].index)} />
                <div className="track-labels"><span>{completed[0]?.id}</span><span>{completed.at(-1)?.id}</span></div></>}
            </div>
            {preview >= 0 && <button className="preview-button" aria-pressed={index === preview} onClick={() => chooseWeek(preview)}>LIVE PREVIEW · {weeks[preview].id.slice(-3)}</button>}
            <label className="speed-control">SPEED <select value={speed} onChange={event => setSpeed(Number(event.target.value))}>
              <option value="3.2">0.5×</option><option value="1.8">1×</option><option value=".9">2×</option></select></label>
            <button className="reduce-button" aria-pressed={reduced} onClick={() => setReduced(value => !value)}>{reduced ? 'INSTANT' : 'MOTION ON'}</button>
            {Object.keys(manifests).length > 1 && <select className="series-control" aria-label="Data series" value={series} onChange={event => {
              setPlaying(false); setSeries(event.target.value); const next = manifests[event.target.value]; setYear(next.default_year)
              setIndex(Math.max(0, next.years[String(next.default_year)].weeks.findIndex(w => w.status === 'complete')))
            }}><option value="live">Sitewide stats</option><option value="dump">Historical full dump</option></select>}
            {years.length > 1 && <select className="year-control" aria-label="Year" value={year} onChange={event => {
              const next = Number(event.target.value); setYear(next); setIndex(Math.max(0, manifest.years[String(next)].weeks.findIndex(w => w.status === 'complete')))
            }}>{years.map(item => <option key={item}>{item}</option>)}</select>}
          </div>
          <div className="timeline-note"><span>{completed.length} completed week{completed.length === 1 ? '' : 's'} available{preview >= 0 ? ' · current week is a separate preview' : ''}. {completed.length < 2 ? 'Play needs two adjacent completed weeks.' : !canPlay && week?.status === 'complete' ? 'Play stops here until the next completed week.' : ''}</span>
            <span>Missing weeks stay missing. Frames between completed weeks are visual animation, not observations.</span></div>
        </div>
      </>}
    </main>
    {help && <div className="help-scrim" onClick={() => setHelp(false)}><section className="help-sheet" onClick={event => event.stopPropagation()} aria-label="Map explanation">
      <button className="icon-button" aria-label="Close explanation" onClick={() => setHelp(false)}>×</button>
      <span className="micro">HOW TO READ THE MAP</span><h2>Three different measures.</h2>
      <p><b>Recorded activity:</b> Each node is a MusicBrainz-identified artist in the top 100 for that UTC ISO week. Size uses a fixed saturating function, not area proportional to listens. Exact measured counts are in the artist details. The current week is incomplete.</p>
      <p><b>Audience relationship:</b> A line from the live API series is a nonweekly, session-based affinity reference. It is not a count of people who listened to both artists that week. A separately processed full-dump series can display measured weekly weighted Jaccard relationships when complete user coverage has been verified.</p>
      <p><b>Listener movement:</b> No directional particles appear. Position, circle and line animation illustrates changes between archived snapshots; each in-between frame is visual interpolation. This project has not calculated aggregated primary-artist transitions for the same listeners between weeks.</p>
      <p>Earlier missing weeks are gaps, not zero listening. The full 2026 backfill requires a separate, very large ListenBrainz full-dump batch job and is never run inside the Pages update workflow.</p>
      <a href="https://github.com/lidonmiguel/music-listening-migration-map/blob/main/docs/weekly-methods.md" target="_blank" rel="noreferrer">FULL METHOD & DATA DICTIONARY ↗</a>
    </section></div>}
  </div>
}
