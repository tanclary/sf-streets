/* sf streets // 415 completion tracker */

const STORAGE_KEY_STATE = 'sf_streets_state_v1';
const STORAGE_KEY_STRAVA = 'sf_streets_strava_cfg_v1';
const SNAP_RADIUS_METERS = 28;
const GRID_CELL_DEG = 0.0025; // ~250m grid cells
const MOBILE_QUERY = window.matchMedia('(max-width: 768px)');

const state = {
  blocks: [],            // [{ id, s, f, t, n, c, checkpoints }]
  blockById: new Map(),
  streetsByName: new Map(), // name -> { name, neighborhoods: Set, blockIds: [] }
  spatialGrid: new Map(),   // "gx,gy" -> [{ blockId, idx, lng, lat }]
  blockHits: new Map(),     // blockId -> Set(checkpointIdx) hit by any walk
  walkedBlockIds: new Set(),
  manualBlockIds: new Set(),
  walks: [],             // [{ id, name, date, source, coords: [[lng,lat],...] }]
  selectedBlockId: null,
  selectedStreetName: null,
  highlightedStreets: new Set(),
  filterStatus: 'all',
  filterNeighborhood: 'ALL',
  searchQuery: '',
  showTraces: true,
  gpsWatchId: null,
  activeLiveWalk: null
};

let map = null;
let mapLoaded = false;

/* ---------- Geometry & Spatial Grid Engine ---------- */

function haversineMeters(lng1, lat1, lng2, lat2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function interpolateLine(coords, maxStepMeters = 18) {
  if (!coords || coords.length < 2) return coords || [];
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    const dist = haversineMeters(lng1, lat1, lng2, lat2);
    if (dist > maxStepMeters) {
      const steps = Math.ceil(dist / maxStepMeters);
      for (let s = 1; s < steps; s++) {
        const frac = s / steps;
        out.push([lng1 + (lng2 - lng1) * frac, lat1 + (lat2 - lat1) * frac]);
      }
    }
    out.push([lng2, lat2]);
  }
  return out;
}

function buildBlockCheckpoints(coords) {
  // Trim 12% off each end so intersections don't false-trigger adjacent cross streets
  const dense = interpolateLine(coords, 22);
  if (dense.length <= 2) {
    const mid = [
      (coords[0][0] + coords[coords.length - 1][0]) / 2,
      (coords[0][1] + coords[coords.length - 1][1]) / 2
    ];
    return [mid];
  }
  return dense;
}

function gridKey(lng, lat) {
  const gx = Math.floor(lng / GRID_CELL_DEG);
  const gy = Math.floor(lat / GRID_CELL_DEG);
  return `${gx},${gy}`;
}

function indexBlocksInSpatialGrid() {
  state.spatialGrid.clear();
  for (const b of state.blocks) {
    b.checkpoints = buildBlockCheckpoints(b.c);
    b.checkpoints.forEach((pt, idx) => {
      const key = gridKey(pt[0], pt[1]);
      let bucket = state.spatialGrid.get(key);
      if (!bucket) {
        bucket = [];
        state.spatialGrid.set(key, bucket);
      }
      bucket.push({ blockId: b.id, idx, lng: pt[0], lat: pt[1] });
    });
  }
}

const BLOCK_COMPLETE_FRACTION = 0.72;

// Accumulates checkpoint hits for a coordinate path; returns the block ids it touched.
function accumulateHits(coords) {
  const touched = new Set();
  const denseCoords = interpolateLine(coords, 14);
  for (const [lng, lat] of denseCoords) {
    // Quick bounding box filter for San Francisco
    if (lng < -122.53 || lng > -122.35 || lat < 37.70 || lat > 37.84) continue;

    const gx = Math.floor(lng / GRID_CELL_DEG);
    const gy = Math.floor(lat / GRID_CELL_DEG);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = state.spatialGrid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const node of bucket) {
          if (haversineMeters(lng, lat, node.lng, node.lat) > SNAP_RADIUS_METERS) continue;
          let hits = state.blockHits.get(node.blockId);
          if (!hits) {
            hits = new Set();
            state.blockHits.set(node.blockId, hits);
          }
          hits.add(node.idx);
          touched.add(node.blockId);
        }
      }
    }
  }
  return touched;
}

// Marks touched blocks that crossed the completion threshold; returns the newly walked ids.
function promoteCompletedBlocks(touched) {
  const newBlockIds = [];
  for (const blockId of touched) {
    if (state.walkedBlockIds.has(blockId)) continue;
    const block = state.blockById.get(blockId);
    const hits = state.blockHits.get(blockId);
    if (!block || !hits) continue;
    const required = Math.max(1, Math.ceil(block.checkpoints.length * BLOCK_COMPLETE_FRACTION));
    if (hits.size >= required) {
      state.walkedBlockIds.add(blockId);
      newBlockIds.push(blockId);
    }
  }
  return newBlockIds;
}

function isStreetFinished(streetName) {
  const info = state.streetsByName.get(streetName);
  return !!info && info.blockIds.every((id) => state.walkedBlockIds.has(id));
}

function streetsFinishedBy(newBlockIds) {
  const finished = [];
  const seen = new Set();
  for (const bid of newBlockIds) {
    const b = state.blockById.get(bid);
    if (!b || seen.has(b.s)) continue;
    seen.add(b.s);
    if (isStreetFinished(b.s)) finished.push(b.s);
  }
  return finished;
}

function countFinishedStreets() {
  let n = 0;
  for (const name of state.streetsByName.keys()) {
    if (isStreetFinished(name)) n++;
  }
  return n;
}

function dominantNeighborhoods(blockIds, limit = 2) {
  const counts = new Map();
  for (const bid of blockIds) {
    const b = state.blockById.get(bid);
    if (b) counts.set(b.n, (counts.get(b.n) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((e) => e[0]);
}

function applyWalkPath(coords) {
  const touched = accumulateHits(coords);
  const newBlockIds = promoteCompletedBlocks(touched);
  return { touched, newBlockIds, streetsFinished: streetsFinishedBy(newBlockIds) };
}

function walkSortKey(w) {
  return w.ts || w.date || '';
}

// Replays every walk chronologically so each one knows what it newly unlocked.
function recomputeAllWalkMatches() {
  state.blockHits = new Map();
  state.walkedBlockIds = new Set(state.manualBlockIds);
  let finishedStreets = countFinishedStreets();

  const ordered = state.walks.slice().sort((a, b) => {
    const ka = walkSortKey(a);
    const kb = walkSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  for (const walk of ordered) {
    const { touched, newBlockIds, streetsFinished } = applyWalkPath(walk.coords);
    finishedStreets += streetsFinished.length;
    walk.stats = {
      touchedBlocks: touched.size,
      newBlockIds,
      streetsFinished,
      neighborhoods: dominantNeighborhoods(newBlockIds.length ? newBlockIds : Array.from(touched)),
      cumulativeBlocks: state.walkedBlockIds.size,
      cumulativeStreets: finishedStreets
    };
  }
}

/* ---------- Polyline & GPX/TCX Parsers ---------- */

function decodeGooglePolyline(encoded) {
  if (!encoded) return [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;
  const coordinates = [];

  while (index < len) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    coordinates.push([lng * 1e-5, lat * 1e-5]);
  }
  return coordinates;
}

function parseGpxOrTcxText(xmlText, fileName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const coords = [];

  // GPX <trkpt> or <rtept>
  const trkpts = doc.querySelectorAll('trkpt, rtept');
  trkpts.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      coords.push([lon, lat]);
    }
  });

  // TCX <Position>
  if (coords.length === 0) {
    const positions = doc.querySelectorAll('Position');
    positions.forEach((pos) => {
      const latEl = pos.querySelector('LatitudeDegrees');
      const lonEl = pos.querySelector('LongitudeDegrees');
      if (latEl && lonEl) {
        const lat = parseFloat(latEl.textContent);
        const lon = parseFloat(lonEl.textContent);
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
          coords.push([lon, lat]);
        }
      }
    });
  }

  const nameEl = doc.querySelector('trk > name, rte > name, Id');
  const timeEl = doc.querySelector('trkpt > time, metadata > time, Trackpoint > Time');
  const ts = timeEl && timeEl.textContent.trim() ? timeEl.textContent.trim() : new Date().toISOString();
  const walkName = nameEl ? nameEl.textContent.trim() : fileName.replace(/\.(gpx|tcx)$/i, '');
  return {
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: walkName || 'Imported GPS Walk',
    date: ts.slice(0, 10),
    ts,
    source: 'GPX/TCX File',
    coords
  };
}

/* ---------- Storage Persistence ---------- */

function saveStateToStorage() {
  try {
    const payload = {
      manualBlockIds: Array.from(state.manualBlockIds),
      walks: state.walks.map((w) => ({
        id: w.id,
        name: w.name,
        date: w.date,
        ts: w.ts,
        source: w.source,
        stravaId: w.stravaId,
        summaryPosted: w.summaryPosted,
        summaryPostedAt: w.summaryPostedAt,
        coords: w.coords
      }))
    };
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(payload));
  } catch (err) {
    console.warn('Could not persist state to localStorage:', err);
  }
}

function loadStateFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STATE);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.manualBlockIds)) {
      state.manualBlockIds = new Set(parsed.manualBlockIds.map(String));
    }
    if (Array.isArray(parsed.walks)) {
      // Demo walks were removed from the UI; drop any that were persisted earlier.
      state.walks = parsed.walks.filter((w) => !String(w.id || '').startsWith('sample-'));
    }
  } catch (err) {
    console.warn('Could not restore state from localStorage:', err);
  }
}

/* ---------- MapLibre GL Initialization & Rendering ---------- */

function buildBlocksGeoJSON() {
  const features = [];
  for (const b of state.blocks) {
    if (state.filterNeighborhood !== 'ALL' && b.n !== state.filterNeighborhood) {
      continue;
    }
    const isWalked = state.walkedBlockIds.has(b.id);
    const isSelected =
      b.id === state.selectedBlockId ||
      (state.selectedStreetName && b.s === state.selectedStreetName) ||
      state.highlightedStreets.has(b.s.toLowerCase());

    features.push({
      type: 'Feature',
      properties: {
        id: b.id,
        s: b.s,
        f: b.f,
        t: b.t,
        n: b.n,
        walked: isWalked ? 1 : 0,
        selected: isSelected ? 1 : 0
      },
      geometry: {
        type: 'LineString',
        coordinates: b.c
      }
    });
  }
  return { type: 'FeatureCollection', features };
}

function buildWalksGeoJSON() {
  if (!state.showTraces) {
    return { type: 'FeatureCollection', features: [] };
  }
  const features = state.walks
    .filter((w) => w.coords && w.coords.length >= 2)
    .map((w) => ({
      type: 'Feature',
      properties: { id: w.id, name: w.name },
      geometry: {
        type: 'LineString',
        coordinates: w.coords
      }
    }));
  return { type: 'FeatureCollection', features };
}

function refreshMapSources() {
  if (!map || !mapLoaded) return;
  const blocksSource = map.getSource('sf-blocks');
  if (blocksSource) {
    blocksSource.setData(buildBlocksGeoJSON());
  }
  const walksSource = map.getSource('sf-walks');
  if (walksSource) {
    walksSource.setData(buildWalksGeoJSON());
  }
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map-container',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [-122.436, 37.764],
    zoom: 12.2,
    minZoom: 10.5,
    maxZoom: 18,
    attributionControl: false
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  map.on('load', () => {
    mapLoaded = true;

    map.addSource('sf-blocks', {
      type: 'geojson',
      data: buildBlocksGeoJSON()
    });

    map.addSource('sf-walks', {
      type: 'geojson',
      data: buildWalksGeoJSON()
    });

    // Unwalked street blocks
    map.addLayer({
      id: 'sf-blocks-unwalked',
      type: 'line',
      source: 'sf-blocks',
      filter: ['==', ['get', 'walked'], 0],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#3e4656',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.1, 14, 2.4, 16, 4.2],
        'line-opacity': 0.72
      }
    });

    // Walked street blocks (Cypress Emerald)
    map.addLayer({
      id: 'sf-blocks-walked',
      type: 'line',
      source: 'sf-blocks',
      filter: ['==', ['get', 'walked'], 1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#24c278',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.8, 14, 3.6, 16, 6.0],
        'line-opacity': 0.95
      }
    });

    // GPS walk traces (Golden Gate Terracotta)
    map.addLayer({
      id: 'sf-walks-layer',
      type: 'line',
      source: 'sf-walks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ee5630',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.4, 14, 2.5, 16, 3.8],
        'line-opacity': 0.78,
        'line-dasharray': [2, 1.2]
      }
    });

    // Selected street or block highlight
    map.addLayer({
      id: 'sf-blocks-selected',
      type: 'line',
      source: 'sf-blocks',
      filter: ['==', ['get', 'selected'], 1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#f5b041',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3.0, 14, 5.2, 16, 8.0],
        'line-opacity': 1
      }
    });

    // Invisible wide hit target for easy tapping on mobile
    map.addLayer({
      id: 'sf-blocks-hit',
      type: 'line',
      source: 'sf-blocks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000000',
        'line-width': 14,
        'line-opacity': 0
      }
    });

    map.on('click', 'sf-blocks-hit', (e) => {
      if (!e.features || !e.features.length) return;
      const props = e.features[0].properties;
      selectBlock(props.id, false);
    });

    // Tapping the map on mobile tucks the street sheet away so the map is visible.
    map.on('click', () => {
      if (isMobile()) setSheetCollapsed(true);
    });

    map.on('mouseenter', 'sf-blocks-hit', () => {
      map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', 'sf-blocks-hit', () => {
      map.getCanvas().style.cursor = '';
    });
  });
}

/* ---------- UI Updates & Street List ---------- */

function computeStreetAggregates() {
  const results = [];
  for (const [name, info] of state.streetsByName.entries()) {
    // Filter by neighborhood if selected
    const matchingBlocks = info.blockIds.filter((bid) => {
      if (state.filterNeighborhood === 'ALL') return true;
      const b = state.blockById.get(bid);
      return b && b.n === state.filterNeighborhood;
    });

    if (matchingBlocks.length === 0) continue;

    let walkedCount = 0;
    for (const bid of matchingBlocks) {
      if (state.walkedBlockIds.has(bid)) walkedCount++;
    }

    const totalCount = matchingBlocks.length;
    const status =
      walkedCount === 0
        ? 'todo'
        : walkedCount === totalCount
        ? 'done'
        : 'partial';

    results.push({
      name,
      blockIds: matchingBlocks,
      walkedCount,
      totalCount,
      pct: Math.round((walkedCount / totalCount) * 100),
      status,
      neighborhoods: Array.from(info.neighborhoods)
    });
  }
  return results;
}

function updateDashboardStats() {
  const activeBlocks =
    state.filterNeighborhood === 'ALL'
      ? state.blocks
      : state.blocks.filter((b) => b.n === state.filterNeighborhood);

  const totalBlocks = activeBlocks.length;
  let walkedBlocks = 0;
  for (const b of activeBlocks) {
    if (state.walkedBlockIds.has(b.id)) walkedBlocks++;
  }

  const pct = totalBlocks > 0 ? ((walkedBlocks / totalBlocks) * 100).toFixed(1) : '0.0';
  document.getElementById('stat-overall-pct').textContent = `${pct}%`;
  document.getElementById('stat-blocks-count').textContent =
    `${walkedBlocks.toLocaleString()} / ${totalBlocks.toLocaleString()} blocks`;

  const streetAggs = computeStreetAggregates();
  const doneStreets = streetAggs.filter((s) => s.status === 'done').length;
  const partialStreets = streetAggs.filter((s) => s.status === 'partial').length;

  document.getElementById('stat-streets-done').textContent = doneStreets.toLocaleString();
  document.getElementById('stat-streets-partial').textContent = partialStreets.toLocaleString();
  document.getElementById('stat-walks-count').textContent = state.walks.length.toLocaleString();

  // Progress bar widths
  const completedWidth = totalBlocks > 0 ? (walkedBlocks / totalBlocks) * 100 : 0;
  let partialBlockPool = 0;
  for (const s of streetAggs) {
    if (s.status === 'partial') {
      partialBlockPool += s.totalCount - s.walkedCount;
    }
  }
  const partialWidth =
    totalBlocks > 0
      ? Math.min(100 - completedWidth, (partialBlockPool / totalBlocks) * 100)
      : 0;

  document.getElementById('bar-completed').style.width = `${completedWidth}%`;
  document.getElementById('bar-partial').style.width = `${partialWidth}%`;

  renderStreetList(streetAggs);
  updateInspectorUI();
  updateStravaUIState();
}

function renderStreetList(streetAggs) {
  const container = document.getElementById('street-list');
  const q = state.searchQuery.trim().toLowerCase();

  const filtered = streetAggs.filter((s) => {
    if (state.filterStatus !== 'all' && s.status !== state.filterStatus) return false;
    if (q && !s.name.toLowerCase().includes(q)) return false;
    return true;
  });

  // Sort: partial (highest % first), then done, then alphabetical
  filtered.sort((a, b) => {
    if (a.status !== b.status) {
      const rank = { partial: 0, done: 1, todo: 2 };
      return rank[a.status] - rank[b.status];
    }
    if (a.pct !== b.pct) return b.pct - a.pct;
    return a.name.localeCompare(b.name);
  });

  const visible = filtered.slice(0, 180);
  container.innerHTML = '';

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '24px 12px';
    empty.style.textAlign = 'center';
    empty.style.color = 'var(--text-secondary)';
    empty.style.fontSize = '0.8rem';
    empty.textContent = 'No streets match this filter.';
    container.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const st of visible) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'street-row' + (state.selectedStreetName === st.name ? ' selected' : '');
    btn.setAttribute('role', 'listitem');

    const badgeClass =
      st.status === 'done'
        ? 'badge-done'
        : st.status === 'partial'
        ? 'badge-partial'
        : 'badge-todo';

    const nhoodLabel =
      st.neighborhoods.length > 2
        ? `${st.neighborhoods.slice(0, 2).join(', ')} +${st.neighborhoods.length - 2}`
        : st.neighborhoods.join(', ');

    btn.innerHTML = `
      <div class="street-row-main">
        <span class="street-row-name">${st.name}</span>
        <span class="street-row-meta">${nhoodLabel}</span>
      </div>
      <span class="street-row-badge ${badgeClass}">${st.walkedCount}/${st.totalCount} · ${st.pct}%</span>
    `;

    btn.addEventListener('click', () => {
      selectStreetByName(st.name, st.blockIds);
      if (isMobile()) setSheetCollapsed(true);
    });
    frag.appendChild(btn);
  }
  container.appendChild(frag);
}

/* ---------- Block & Street Selection / Inspector ---------- */

function selectBlock(blockId, flyTo = false) {
  const b = state.blockById.get(String(blockId));
  if (!b) return;
  state.selectedBlockId = b.id;
  state.selectedStreetName = null;
  state.highlightedStreets.clear();
  refreshMapSources();
  updateInspectorUI();

  if (flyTo && map) {
    const mid = b.c[Math.floor(b.c.length / 2)];
    map.flyTo({ center: mid, zoom: Math.max(map.getZoom(), 15), duration: 750 });
  }
}

function selectStreetByName(streetName, blockIds) {
  state.selectedStreetName = streetName;
  state.selectedBlockId = blockIds && blockIds.length ? blockIds[0] : null;
  state.highlightedStreets.clear();
  refreshMapSources();
  updateDashboardStats();

  // Fit bounds around all blocks of this street
  if (map && blockIds && blockIds.length) {
    const bounds = new maplibregl.LngLatBounds();
    for (const bid of blockIds) {
      const b = state.blockById.get(bid);
      if (!b) continue;
      for (const pt of b.c) {
        bounds.extend(pt);
      }
    }
    map.fitBounds(bounds, { padding: mapFitPadding(), maxZoom: 16, duration: 850 });
  }
}

function highlightStreetListOnMap(streetNames, optionalNeighborhood) {
  if (!Array.isArray(streetNames) || streetNames.length === 0) return;
  if (optionalNeighborhood && optionalNeighborhood !== 'ALL') {
    const sel = document.getElementById('select-neighborhood');
    if (sel && Array.from(sel.options).some((o) => o.value === optionalNeighborhood)) {
      state.filterNeighborhood = optionalNeighborhood;
      sel.value = optionalNeighborhood;
    }
  }

  state.highlightedStreets = new Set(streetNames.map((s) => s.trim().toLowerCase()).filter(Boolean));
  state.selectedStreetName = null;
  state.selectedBlockId = null;
  refreshMapSources();
  updateDashboardStats();

  if (map) {
    const bounds = new maplibregl.LngLatBounds();
    let count = 0;
    for (const b of state.blocks) {
      if (state.highlightedStreets.has(b.s.toLowerCase())) {
        if (state.filterNeighborhood !== 'ALL' && b.n !== state.filterNeighborhood) continue;
        for (const pt of b.c) bounds.extend(pt);
        count++;
      }
    }
    if (count > 0) {
      map.fitBounds(bounds, { padding: mapFitPadding(), maxZoom: 15.5, duration: 900 });
    }
  }
}

function updateInspectorUI() {
  const card = document.getElementById('block-inspector-card');
  const b = state.selectedBlockId ? state.blockById.get(state.selectedBlockId) : null;
  if (!b) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  document.getElementById('inspector-street-name').textContent = b.s;
  const cross = [b.f, b.t].filter(Boolean).join(' → ') || 'Block segment';
  document.getElementById('inspector-cross-streets').textContent = `${cross} · ${b.n}`;

  const streetInfo = state.streetsByName.get(b.s);
  let streetWalked = 0;
  const streetTotal = streetInfo ? streetInfo.blockIds.length : 1;
  if (streetInfo) {
    for (const bid of streetInfo.blockIds) {
      if (state.walkedBlockIds.has(bid)) streetWalked++;
    }
  }

  document.getElementById('inspector-street-progress').textContent =
    `Street: ${streetWalked} / ${streetTotal} blocks`;

  const isWalked = state.walkedBlockIds.has(b.id);
  const statusEl = document.getElementById('inspector-block-status');
  statusEl.textContent = isWalked ? 'Walked ✓' : 'Unwalked';
  statusEl.style.color = isWalked ? 'var(--accent-emerald)' : 'var(--text-secondary)';

  const toggleBtn = document.getElementById('btn-toggle-block-walked');
  toggleBtn.textContent = isWalked ? 'Mark Unwalked' : 'Mark Block Walked';
}

/* ---------- Toast Helper ---------- */

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('status-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
  }, 4200);
}

/* ---------- Mobile Bottom Sheet ---------- */

function isMobile() {
  return MOBILE_QUERY.matches;
}

function setSheetCollapsed(collapsed) {
  const drawer = document.getElementById('sidebar-drawer');
  if (!drawer) return;
  drawer.classList.toggle('collapsed', collapsed);
  if (collapsed && document.activeElement && drawer.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}

function toggleSheet() {
  const drawer = document.getElementById('sidebar-drawer');
  if (drawer) setSheetCollapsed(!drawer.classList.contains('collapsed'));
}

// Keeps the overlay offset and the collapsed sheet height in sync with real element sizes.
function measureLayoutVars() {
  const root = document.documentElement.style;
  const topBar = document.getElementById('top-bar');
  const handle = document.getElementById('btn-mobile-sheet-toggle');
  const controls = document.getElementById('controls-section');
  if (topBar) root.setProperty('--topbar-h', `${topBar.offsetHeight}px`);
  if (handle && controls && isMobile()) {
    root.setProperty('--sheet-peek', `${handle.offsetHeight + controls.offsetHeight + 2}px`);
  }
}

// Padding that keeps fitted geometry clear of the floating UI on either layout.
function mapFitPadding() {
  const overlay = document.querySelector('.map-overlay-top-right');
  const overlayBottom = overlay ? overlay.getBoundingClientRect().bottom : 0;
  if (isMobile()) {
    const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek')) || 128;
    return { top: overlayBottom + 24, bottom: peek + 24, left: 24, right: 24 };
  }
  const column = document.querySelector('.side-column');
  const columnRight = column ? column.getBoundingClientRect().right : 0;
  return { top: Math.max(60, overlayBottom + 24), bottom: 60, left: columnRight + 40, right: 60 };
}

function wireSheetGestures() {
  const handle = document.getElementById('btn-mobile-sheet-toggle');
  if (!handle) return;
  let startY = null;

  handle.addEventListener('click', toggleSheet);
  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
  }, { passive: true });
  handle.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < -24) {
      setSheetCollapsed(false);
      startY = null;
    } else if (dy > 24) {
      setSheetCollapsed(true);
      startY = null;
    }
  }, { passive: true });
  handle.addEventListener('touchend', () => {
    startY = null;
  });

  const search = document.getElementById('input-street-search');
  if (search) {
    search.addEventListener('focus', () => {
      if (isMobile()) setSheetCollapsed(false);
    });
  }

  const ro = 'ResizeObserver' in window ? new ResizeObserver(measureLayoutVars) : null;
  const topBar = document.getElementById('top-bar');
  const controls = document.getElementById('controls-section');
  if (ro && topBar) ro.observe(topBar);
  if (ro && controls) ro.observe(controls);
  window.addEventListener('resize', measureLayoutVars);
  measureLayoutVars();
}

/* ---------- Strava API Sync (Auto-Refresh, Access Token & OAuth) ---------- */

function getStravaConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_STRAVA) || '{}');
  } catch {
    return {};
  }
}

function saveStravaConfig(patch) {
  const next = { ...getStravaConfig(), ...patch };
  localStorage.setItem(STORAGE_KEY_STRAVA, JSON.stringify(next));
  updateStravaUIState();
  return next;
}

function updateStravaUIState() {
  const cfg = getStravaConfig();
  const cidInput = document.getElementById('input-strava-client-id');
  const secInput = document.getElementById('input-strava-client-secret');
  const oauthBtn = document.getElementById('btn-strava-oauth');
  const setup = document.getElementById('strava-setup');
  const connected = !!(cfg.refreshToken && cfg.clientId && cfg.clientSecret);
  const canWrite = hasStravaWriteScope();

  if (cidInput && cfg.clientId && !cidInput.value) cidInput.value = cfg.clientId;
  if (secInput && cfg.clientSecret && !secInput.value) secInput.value = cfg.clientSecret;
  if (setup && !connected) setup.open = true;

  if (oauthBtn) {
    oauthBtn.textContent = !connected
      ? 'Connect Strava'
      : canWrite
      ? 'Reconnect Strava'
      : 'Grant Write Access';
    oauthBtn.classList.toggle('btn-primary', connected && !canWrite);
  }

  const chk = document.getElementById('chk-auto-post-summary');
  if (chk) chk.checked = cfg.autoPostSummary !== false;

  const writeStatus = document.getElementById('strava-write-status');
  if (writeStatus) {
    writeStatus.textContent = !connected
      ? 'not connected'
      : canWrite
      ? 'connected ✓ · write access ✓'
      : 'connected · tap grant write access';
  }

  const pendingEl = document.getElementById('pending-summary-count');
  if (pendingEl) pendingEl.textContent = pendingSummaryWalks().length;

  const preview = document.getElementById('summary-preview');
  if (preview) {
    const latest = latestStravaWalk();
    const summary = latest ? buildProgressSummary(latest) : null;
    preview.textContent = summary
      ? `${latest.name}\n\n${summary}`
      : 'Sync a Strava walk in SF to preview its summary.';
  }
}

/* ---------- Strava Description Progress Summaries ---------- */

const MAX_SUMMARY_POSTS_PER_RUN = 15;
const SUMMARY_FOOTER = 'strange-habits.com/sf-streets';
// Matches a previously posted summary block so re-posting replaces instead of stacking.
const SUMMARY_RE =
  /[\d,]+ new blocks? walked\. \+[\d.]+%\s*\n\s*[\d,]+ of [\d,]+ sf blocks \([\d.]+%\)(?:\s*\n\s*strange-habits\.com\/sf-streets)?/gi;

function stravaIdOf(walk) {
  if (walk.stravaId) return String(walk.stravaId);
  return walk.id && walk.id.startsWith('strava-') ? walk.id.slice('strava-'.length) : null;
}

function hasStravaWriteScope() {
  const cfg = getStravaConfig();
  return typeof cfg.scope === 'string' && cfg.scope.includes('activity:write');
}

function buildProgressSummary(walk) {
  const s = walk.stats;
  const total = state.blocks.length;
  if (!s || !total) return null;
  const n = s.newBlockIds.length;
  const deltaPct = (n / total) * 100;
  const totalPct = (s.cumulativeBlocks / total) * 100;
  return [
    `${n.toLocaleString()} new block${n === 1 ? '' : 's'} walked. +${deltaPct.toFixed(2)}%`,
    `${s.cumulativeBlocks.toLocaleString()} of ${total.toLocaleString()} SF blocks (${totalPct.toFixed(1)}%)`,
    SUMMARY_FOOTER
  ].join('\n');
}

function mergeDescription(existing, summary) {
  const kept = (existing || '')
    .replace(SUMMARY_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return kept ? `${kept}\n\n${summary}` : summary;
}

function stravaWalksNewestFirst() {
  return state.walks
    .filter((w) => stravaIdOf(w) && w.stats && w.stats.touchedBlocks > 0)
    .sort((a, b) => (walkSortKey(a) < walkSortKey(b) ? 1 : -1));
}

function pendingSummaryWalks() {
  return stravaWalksNewestFirst().filter((w) => !w.summaryPosted);
}

function latestStravaWalk() {
  return stravaWalksNewestFirst()[0] || null;
}

async function requireStravaToken() {
  try {
    const token = await getValidStravaAccessToken();
    if (token) return token;
  } catch (err) {
    showToast(`Strava auth error: ${err.message}`);
    return null;
  }
  showToast('Connect Strava via OAuth first.');
  return null;
}

async function postSummaryToStrava(accessToken, walk) {
  const id = stravaIdOf(walk);
  const summary = buildProgressSummary(walk);
  if (!id || !summary) throw new Error('nothing to post');
  const headers = { Authorization: `Bearer ${accessToken}` };
  const url = `https://www.strava.com/api/v3/activities/${id}`;

  const getRes = await fetch(url, { headers });
  if (getRes.status === 429) throw new Error('rate-limited');
  if (!getRes.ok) throw new Error(`GET ${getRes.status}`);
  const detail = await getRes.json();

  const putRes = await fetch(url, {
    method: 'PUT',
    headers,
    body: new URLSearchParams({ description: mergeDescription(detail.description, summary) })
  });
  if (putRes.status === 401 || putRes.status === 403) throw new Error('no-write-scope');
  if (putRes.status === 429) throw new Error('rate-limited');
  if (!putRes.ok) throw new Error(`PUT ${putRes.status}`);

  walk.summaryPosted = true;
  walk.summaryPostedAt = new Date().toISOString();
}

function explainSummaryError(err) {
  if (err.message === 'no-write-scope') {
    saveStravaConfig({ scope: (getStravaConfig().scope || '').replace('activity:write', '') });
    return 'Strava denied the edit — tap "Reconnect Strava OAuth" to grant write access.';
  }
  if (err.message === 'rate-limited') return 'Strava rate limit hit — try again in 15 minutes.';
  return `Could not post summary: ${err.message}`;
}

async function postPendingStravaSummaries(accessToken, onlyWalkIds = null) {
  if (!hasStravaWriteScope()) {
    showToast('Reconnect Strava OAuth once to grant write access for summaries.');
    return 0;
  }
  let queue = pendingSummaryWalks();
  if (onlyWalkIds) {
    const wanted = new Set(onlyWalkIds);
    queue = queue.filter((w) => wanted.has(w.id));
  }
  if (queue.length === 0) return 0;

  let posted = 0;
  try {
    for (const walk of queue.slice(0, MAX_SUMMARY_POSTS_PER_RUN)) {
      await postSummaryToStrava(accessToken, walk);
      posted++;
    }
  } catch (err) {
    showToast(explainSummaryError(err));
  }

  saveStateToStorage();
  updateStravaUIState();
  if (posted > 0) {
    const remaining = pendingSummaryWalks().length;
    showToast(
      `Posted progress to ${posted} Strava walk${posted === 1 ? '' : 's'}` +
        (remaining ? ` (${remaining} still pending).` : '.')
    );
  }
  return posted;
}

async function getValidStravaAccessToken() {
  const cfg = getStravaConfig();
  const nowSec = Math.floor(Date.now() / 1000);

  if (cfg.accessToken && cfg.expiresAt && cfg.expiresAt > nowSec + 120) {
    return cfg.accessToken;
  }

  if (cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken
    });
    const res = await fetch('https://www.strava.com/api/v3/oauth/token', {
      method: 'POST',
      body
    });
    if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
    const data = await res.json();
    if (data.access_token) {
      saveStravaConfig({
        accessToken: data.access_token,
        refreshToken: data.refresh_token || cfg.refreshToken,
        expiresAt: data.expires_at
      });
      return data.access_token;
    }
  }
  return null;
}

async function fetchStravaActivitiesWithToken(accessToken) {
  showToast('Syncing walks & runs from Strava...');
  let page = 1;
  const newWalks = [];
  const existingIds = new Set(state.walks.map((w) => w.id));

  try {
    while (page <= 5) {
      const res = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken.trim()}` } }
      );
      if (!res.ok) {
        throw new Error(`Strava API returned ${res.status}`);
      }
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) break;

      for (const act of items) {
        const type = (act.type || act.sport_type || '').toLowerCase();
        if (!['walk', 'run', 'hike', 'trailrun'].includes(type)) continue;
        const poly = act.map && (act.map.polyline || act.map.summary_polyline);
        if (!poly) continue;
        const coords = decodeGooglePolyline(poly);
        if (coords.length < 2) continue;

        const walkId = `strava-${act.id}`;
        if (!existingIds.has(walkId)) {
          newWalks.push({
            id: walkId,
            stravaId: String(act.id),
            name: act.name || 'Strava Activity',
            date: (act.start_date_local || '').slice(0, 10),
            ts: act.start_date || act.start_date_local || '',
            source: `Strava ${act.type || 'Walk'}`,
            summaryPosted: false,
            coords
          });
          existingIds.add(walkId);
        }
      }
      if (items.length < 100) break;
      page++;
    }

    if (newWalks.length > 0) {
      state.walks.push(...newWalks);
      const before = state.walkedBlockIds.size;
      recomputeAllWalkMatches();
      const newlyMatched = state.walkedBlockIds.size - before;
      saveStateToStorage();
      refreshMapSources();
      updateDashboardStats();
      showToast(`Synced ${newWalks.length} Strava walks (+${newlyMatched} new SF blocks)!`);

      if (getStravaConfig().autoPostSummary !== false && hasStravaWriteScope()) {
        await postPendingStravaSummaries(accessToken, newWalks.map((w) => w.id));
      }
    } else {
      showToast('Strava up to date (no new walks found).');
    }
  } catch (err) {
    showToast(`Strava sync error: ${err.message}`);
  }
}

async function checkStravaOAuthCallback() {
  updateStravaUIState();
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) {
    // Auto-sync on launch if already connected via OAuth!
    const cfg = getStravaConfig();
    if (cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
      try {
        const token = await getValidStravaAccessToken();
        if (token) await fetchStravaActivitiesWithToken(token);
      } catch (e) {
        console.warn('Auto-sync skipped:', e);
      }
    }
    return;
  }

  // Clean URL
  const grantedScope = params.get('scope') || '';
  window.history.replaceState({}, document.title, window.location.pathname);

  const cfg = getStravaConfig();
  if (!cfg.clientId || !cfg.clientSecret) return;

  try {
    showToast('Linking Strava account...');
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: 'authorization_code'
    });
    const res = await fetch('https://www.strava.com/api/v3/oauth/token', {
      method: 'POST',
      body
    });
    const data = await res.json();
    if (data.access_token) {
      saveStravaConfig({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
        scope: grantedScope
      });
      await fetchStravaActivitiesWithToken(data.access_token);
    } else {
      showToast(`Strava OAuth error: ${data.message || 'token exchange failed'}`);
    }
  } catch (err) {
    showToast(`OAuth error: ${err.message}`);
  }
}

/* ---------- Live Phone GPS Recorder ---------- */

function toggleLiveGpsRecording() {
  const btnLabel = document.getElementById('gps-btn-label');
  const dot = document.getElementById('gps-dot');

  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
    btnLabel.textContent = 'Live GPS';
    dot.classList.remove('recording');
    saveStateToStorage();
    const live = state.activeLiveWalk;
    const gained = live && live.stats ? live.stats.newBlockIds.length : 0;
    state.activeLiveWalk = null;
    showToast(`Live GPS walk saved (+${gained} new blocks).`);
    return;
  }

  if (!('geolocation' in navigator)) {
    showToast('Geolocation is not available in this browser.');
    return;
  }

  const liveTouched = new Set();
  const liveWalk = {
    id: `live-${Date.now()}`,
    name: `SF Live Walk (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
    date: new Date().toISOString().slice(0, 10),
    ts: new Date().toISOString(),
    source: 'Live Phone GPS',
    coords: [],
    stats: {
      touchedBlocks: 0,
      newBlockIds: [],
      streetsFinished: [],
      neighborhoods: [],
      cumulativeBlocks: state.walkedBlockIds.size,
      cumulativeStreets: countFinishedStreets()
    }
  };
  state.walks.push(liveWalk);
  state.activeLiveWalk = liveWalk;

  btnLabel.textContent = 'Stop GPS';
  dot.classList.add('recording');
  showToast('Recording live GPS walk — walk down any SF block!');

  state.gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const pt = [pos.coords.longitude, pos.coords.latitude];
      const coords = liveWalk.coords;
      if (coords.length > 0) {
        const last = coords[coords.length - 1];
        if (haversineMeters(last[0], last[1], pt[0], pt[1]) < 6) return;
      }
      coords.push(pt);
      // Only the newest segment needs matching; hits accumulate across updates.
      const { touched, newBlockIds, streetsFinished } = applyWalkPath(coords.slice(-2));
      touched.forEach((id) => liveTouched.add(id));
      const s = liveWalk.stats;
      s.touchedBlocks = liveTouched.size;
      s.newBlockIds.push(...newBlockIds);
      s.streetsFinished.push(...streetsFinished);
      s.cumulativeBlocks = state.walkedBlockIds.size;
      s.cumulativeStreets += streetsFinished.length;
      saveStateToStorage();
      refreshMapSources();
      updateDashboardStats();
      if (map && coords.length === 1) {
        map.flyTo({ center: pt, zoom: 16 });
      }
    },
    (err) => {
      showToast(`GPS error: ${err.message}`);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
  );
}

/* ---------- Bootstrapping & Event Listeners ---------- */

async function loadInitialData() {
  try {
    const res = await fetch('./data/sf-streets.json?v=5');
    const blocks = await res.json();
    state.blocks = blocks;

    const nhoodCounts = new Map();
    for (const b of blocks) {
      state.blockById.set(b.id, b);

      let st = state.streetsByName.get(b.s);
      if (!st) {
        st = { name: b.s, neighborhoods: new Set(), blockIds: [] };
        state.streetsByName.set(b.s, st);
      }
      st.neighborhoods.add(b.n);
      st.blockIds.push(b.id);

      nhoodCounts.set(b.n, (nhoodCounts.get(b.n) || 0) + 1);
    }

    // Populate Neighborhood selector
    const selectEl = document.getElementById('select-neighborhood');
    const sortedNhoods = Array.from(nhoodCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [nhood, count] of sortedNhoods) {
      const opt = document.createElement('option');
      opt.value = nhood;
      opt.textContent = `${nhood} (${count})`;
      selectEl.appendChild(opt);
    }

    indexBlocksInSpatialGrid();
    loadStateFromStorage();
    recomputeAllWalkMatches();
    updateDashboardStats();
    refreshMapSources();
    checkStravaOAuthCallback();
    checkUrlWalkHighlight();
  } catch (err) {
    console.error('Failed to load SF street data:', err);
    showToast('Error loading SF street network.');
  }
}

function on(id, event, handler, options) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler, options);
  return el;
}

function openSyncModal() {
  const modal = document.getElementById('sync-modal-backdrop');
  if (modal) modal.classList.remove('hidden');
  updateStravaUIState();
}

function closeSyncModal() {
  const modal = document.getElementById('sync-modal-backdrop');
  if (modal) modal.classList.add('hidden');
}

function openStravaSetup() {
  const setup = document.getElementById('strava-setup');
  if (setup) setup.open = true;
}

function startStravaOAuth() {
  const cfg = getStravaConfig();
  const cidInput = document.getElementById('input-strava-client-id');
  const secInput = document.getElementById('input-strava-client-secret');
  const clientId = ((cidInput && cidInput.value) || cfg.clientId || '').trim();
  const clientSecret = ((secInput && secInput.value) || cfg.clientSecret || '').trim();
  if (!clientId || !clientSecret) {
    openStravaSetup();
    showToast('Enter your Strava Client ID & Client Secret first.');
    return;
  }
  saveStravaConfig({ clientId, clientSecret });
  const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
  window.location.href =
    `https://www.strava.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code&redirect_uri=${redirectUri}` +
    `&approval_prompt=auto&scope=read,activity:read_all,activity:write`;
}

function wireEvents() {
  wireSheetGestures();

  on('input-street-search', 'input', (e) => {
    state.searchQuery = e.target.value;
    updateDashboardStats();
  });

  on('select-neighborhood', 'change', (e) => {
    state.filterNeighborhood = e.target.value;
    refreshMapSources();
    updateDashboardStats();

    if (map && state.filterNeighborhood !== 'ALL') {
      const bounds = new maplibregl.LngLatBounds();
      let count = 0;
      for (const b of state.blocks) {
        if (b.n === state.filterNeighborhood) {
          for (const pt of b.c) bounds.extend(pt);
          count++;
        }
      }
      if (count > 0) {
        map.fitBounds(bounds, { padding: mapFitPadding(), maxZoom: 15, duration: 800 });
      }
      if (isMobile()) setSheetCollapsed(true);
    }
  });

  document.querySelectorAll('.status-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.status-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.filterStatus = tab.dataset.filter;
      updateDashboardStats();
      if (isMobile()) setSheetCollapsed(false);
    });
  });

  // Inspector actions
  on('btn-close-inspector', 'click', () => {
    state.selectedBlockId = null;
    state.selectedStreetName = null;
    state.highlightedStreets.clear();
    refreshMapSources();
    updateInspectorUI();
  });

  on('btn-toggle-block-walked', 'click', () => {
    const bid = state.selectedBlockId;
    if (!bid) return;
    if (state.walkedBlockIds.has(bid)) {
      state.walkedBlockIds.delete(bid);
      state.manualBlockIds.delete(bid);
    } else {
      state.walkedBlockIds.add(bid);
      state.manualBlockIds.add(bid);
    }
    saveStateToStorage();
    refreshMapSources();
    updateDashboardStats();
  });

  on('btn-focus-full-street', 'click', () => {
    const b = state.selectedBlockId ? state.blockById.get(state.selectedBlockId) : null;
    if (!b) return;
    const info = state.streetsByName.get(b.s);
    if (info) selectStreetByName(b.s, info.blockIds);
  });

  on('btn-record-gps', 'click', toggleLiveGpsRecording);

  // Sync modal
  on('btn-open-sync-modal', 'click', openSyncModal);
  on('btn-close-sync-modal', 'click', closeSyncModal);
  on('sync-modal-backdrop', 'click', (e) => {
    if (e.target.id === 'sync-modal-backdrop') closeSyncModal();
  });

  // File import (.gpx, .tcx, .json)
  on('input-file-upload', 'change', async (e) => {
    await handleUploadedFiles(e.target.files);
    e.target.value = '';
  });

  const dropzone = document.getElementById('file-dropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent-orange)';
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = '';
    });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '';
      if (e.dataTransfer && e.dataTransfer.files) {
        await handleUploadedFiles(e.dataTransfer.files);
      }
    });
  }

  // Strava
  on('btn-sync-now', 'click', async () => {
    const token = await requireStravaToken();
    if (!token) {
      openStravaSetup();
      return;
    }
    await fetchStravaActivitiesWithToken(token);
  });

  on('btn-sync-strava-token', 'click', async () => {
    const input = document.getElementById('input-strava-token');
    const manualToken = input ? input.value.trim() : '';
    if (!manualToken) {
      showToast('Paste an Access Token, or use Connect Strava above.');
      return;
    }
    await fetchStravaActivitiesWithToken(manualToken);
  });

  on('btn-strava-oauth', 'click', startStravaOAuth);

  on('chk-auto-post-summary', 'change', (e) => {
    saveStravaConfig({ autoPostSummary: e.target.checked });
    if (e.target.checked && getStravaConfig().refreshToken && !hasStravaWriteScope()) {
      showToast('Tap "Grant Write Access" once so summaries can be posted.');
    }
  });

  on('btn-post-latest-summary', 'click', async () => {
    const latest = latestStravaWalk();
    if (!latest) {
      showToast('No synced Strava walks in SF yet.');
      return;
    }
    if (!hasStravaWriteScope()) {
      showToast('Tap "Grant Write Access" once first.');
      return;
    }
    const token = await requireStravaToken();
    if (!token) return;
    try {
      await postSummaryToStrava(token, latest);
      saveStateToStorage();
      updateStravaUIState();
      showToast(`Posted progress to "${latest.name}"!`);
    } catch (err) {
      showToast(explainSummaryError(err));
    }
  });

  on('btn-post-pending-summaries', 'click', async () => {
    if (pendingSummaryWalks().length === 0) {
      showToast('Every synced SF walk already has a summary.');
      return;
    }
    const token = await requireStravaToken();
    if (!token) return;
    await postPendingStravaSummaries(token);
  });

  on('btn-export-backup', 'click', () => {
    const data = {
      exportedAt: new Date().toISOString(),
      walkedBlockCount: state.walkedBlockIds.size,
      manualBlockIds: Array.from(state.manualBlockIds),
      walks: state.walks
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sf-streets-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function checkUrlWalkHighlight() {
  const params = new URLSearchParams(window.location.search);
  const streetsParam = params.get('streets');
  if (!streetsParam) return;
  const nhoodParam = params.get('nhood') || '';
  const list = streetsParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length > 0) {
    setTimeout(() => {
      highlightStreetListOnMap(list, nhoodParam);
      showToast(`Showing planned walk route (${list.length} streets)`);
    }, 600);
  }
}

async function handleUploadedFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const importedWalks = [];

  for (const file of fileList) {
    const text = await file.text();
    if (file.name.toLowerCase().endsWith('.json')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.walks)) {
          importedWalks.push(...parsed.walks);
        } else if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.coords) {
              importedWalks.push(item);
            } else if (item.map && (item.map.polyline || item.map.summary_polyline)) {
              importedWalks.push({
                id: `strava-json-${item.id || Math.random()}`,
                name: item.name || file.name,
                date: (item.start_date_local || '').slice(0, 10),
                source: 'Strava JSON',
                coords: decodeGooglePolyline(item.map.polyline || item.map.summary_polyline)
              });
            }
          }
        }
        if (Array.isArray(parsed.manualBlockIds)) {
          parsed.manualBlockIds.forEach((id) => state.manualBlockIds.add(String(id)));
        }
      } catch (err) {
        showToast(`Could not parse ${file.name}`);
      }
    } else {
      const walk = parseGpxOrTcxText(text, file.name);
      if (walk.coords.length >= 2) {
        importedWalks.push(walk);
      }
    }
  }

  if (importedWalks.length > 0) {
    state.walks.push(...importedWalks);
    recomputeAllWalkMatches();
    saveStateToStorage();
    refreshMapSources();
    updateDashboardStats();
    closeSyncModal();
    showToast(`Imported ${importedWalks.length} file(s) — ${state.walkedBlockIds.size} SF blocks matched!`);
  } else {
    showToast('No GPS track points found in selected file(s).');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (
    window.location.protocol === 'http:' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1'
  ) {
    window.location.replace(window.location.href.replace(/^http:/, 'https:'));
    return;
  }

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js?v=7');
      await reg.update();
    } catch {}
  }

  initMap();
  wireEvents();
  loadInitialData();
});
