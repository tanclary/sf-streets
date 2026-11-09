/* sf streets // 415 completion tracker */

const STORAGE_KEY_STATE = 'sf_streets_state_v1';
const STORAGE_KEY_STRAVA = 'sf_streets_strava_cfg_v1';
const SNAP_RADIUS_METERS = 28;
const GRID_CELL_DEG = 0.0025; // ~250m grid cells

const state = {
  blocks: [],            // [{ id, s, f, t, n, c, checkpoints }]
  blockById: new Map(),
  streetsByName: new Map(), // name -> { name, neighborhoods: Set, blockIds: [] }
  spatialGrid: new Map(),   // "gx,gy" -> [{ blockId, idx, lng, lat }]
  walkedBlockIds: new Set(),
  manualBlockIds: new Set(),
  walks: [],             // [{ id, name, date, source, coords: [[lng,lat],...] }]
  selectedBlockId: null,
  selectedStreetName: null,
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

function matchWalksAgainstBlocks(walksToMatch) {
  // Track which checkpoints of each block have been hit
  const hitMap = new Map(); // blockId -> Set(checkpointIdx)

  for (const walk of walksToMatch) {
    const denseCoords = interpolateLine(walk.coords, 14);
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
            const d = haversineMeters(lng, lat, node.lng, node.lat);
            if (d <= SNAP_RADIUS_METERS) {
              let hits = hitMap.get(node.blockId);
              if (!hits) {
                hits = new Set();
                hitMap.set(node.blockId, hits);
              }
              hits.add(node.idx);
            }
          }
        }
      }
    }
  }

  let newlyMatched = 0;
  for (const [blockId, hits] of hitMap.entries()) {
    const block = state.blockById.get(blockId);
    if (!block) continue;
    const required = Math.max(1, Math.ceil(block.checkpoints.length * 0.72));
    if (hits.size >= required && !state.walkedBlockIds.has(blockId)) {
      state.walkedBlockIds.add(blockId);
      newlyMatched++;
    }
  }
  return newlyMatched;
}

function recomputeAllWalkMatches() {
  state.walkedBlockIds = new Set(state.manualBlockIds);
  matchWalksAgainstBlocks(state.walks);
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
  const walkName = nameEl ? nameEl.textContent.trim() : fileName.replace(/\.(gpx|tcx)$/i, '');
  return {
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: walkName || 'Imported GPS Walk',
    date: new Date().toISOString().slice(0, 10),
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
        source: w.source,
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
      state.walks = parsed.walks;
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
      (state.selectedStreetName && b.s === state.selectedStreetName);

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
    map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 850 });
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
  const syncBtn = document.getElementById('btn-open-sync-modal');
  const oauthBtn = document.getElementById('btn-strava-oauth');

  if (cidInput && cfg.clientId && !cidInput.value) cidInput.value = cfg.clientId;
  if (secInput && cfg.clientSecret && !secInput.value) secInput.value = cfg.clientSecret;

  if (cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
    if (syncBtn) syncBtn.textContent = '↻ Sync Strava';
    if (oauthBtn) oauthBtn.textContent = 'Reconnect Strava OAuth (Connected ✓)';
  }
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
            name: act.name || 'Strava Activity',
            date: (act.start_date_local || '').slice(0, 10),
            source: `Strava ${act.type || 'Walk'}`,
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
      const newlyMatched = matchWalksAgainstBlocks(newWalks);
      saveStateToStorage();
      refreshMapSources();
      updateDashboardStats();
      showToast(`Synced ${newWalks.length} Strava walks (+${newlyMatched} new SF blocks)!`);
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
        expiresAt: data.expires_at
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
    dot.style.background = '#ee5630';
    saveStateToStorage();
    showToast('Live GPS walk saved.');
    return;
  }

  if (!('geolocation' in navigator)) {
    showToast('Geolocation is not available in this browser.');
    return;
  }

  const liveWalk = {
    id: `live-${Date.now()}`,
    name: `SF Live Walk (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
    date: new Date().toISOString().slice(0, 10),
    source: 'Live Phone GPS',
    coords: []
  };
  state.walks.push(liveWalk);
  state.activeLiveWalk = liveWalk;

  btnLabel.textContent = 'Stop GPS';
  dot.style.background = '#24c278';
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
      matchWalksAgainstBlocks([liveWalk]);
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
    const res = await fetch('./data/sf-streets.json');
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
  } catch (err) {
    console.error('Failed to load SF street data:', err);
    showToast('Error loading SF street network.');
  }
}

async function loadSampleWalks() {
  try {
    const res = await fetch('./data/sample-walks.json');
    const samples = await res.json();
    const existingIds = new Set(state.walks.map((w) => w.id));
    let added = 0;
    for (const s of samples) {
      if (!existingIds.has(s.id)) {
        state.walks.push(s);
        added++;
      }
    }
    recomputeAllWalkMatches();
    saveStateToStorage();
    refreshMapSources();
    updateDashboardStats();
    document.getElementById('sync-modal-backdrop').classList.add('hidden');
    showToast(
      added > 0
        ? `Loaded 5 sample SF walks (${state.walkedBlockIds.size} blocks snapped)!`
        : 'Sample SF walks already loaded.'
    );
  } catch (err) {
    showToast('Could not load sample SF walks.');
  }
}

function wireEvents() {
  // Mobile bottom sheet toggle
  document.getElementById('btn-mobile-sheet-toggle').addEventListener('click', () => {
    document.getElementById('sidebar-drawer').classList.toggle('minimized');
  });

  // Search input
  document.getElementById('input-street-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    updateDashboardStats();
  });

  // Neighborhood filter
  document.getElementById('select-neighborhood').addEventListener('change', (e) => {
    state.filterNeighborhood = e.target.value;
    refreshMapSources();
    updateDashboardStats();

    // Fit map to selected neighborhood blocks
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
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 800 });
      }
    }
  });

  // Status filter tabs
  document.querySelectorAll('.status-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.status-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.filterStatus = tab.dataset.filter;
      updateDashboardStats();
    });
  });

  // Quick action buttons
  document.getElementById('btn-load-sample-walks').addEventListener('click', loadSampleWalks);
  document.getElementById('btn-load-samples-from-modal').addEventListener('click', loadSampleWalks);

  document.getElementById('btn-toggle-traces').addEventListener('click', (e) => {
    state.showTraces = !state.showTraces;
    e.currentTarget.textContent = state.showTraces ? 'Hide GPS Traces' : 'Show GPS Traces';
    refreshMapSources();
  });

  document.getElementById('btn-reset-progress').addEventListener('click', () => {
    state.walks = [];
    state.manualBlockIds.clear();
    state.walkedBlockIds.clear();
    state.selectedBlockId = null;
    state.selectedStreetName = null;
    saveStateToStorage();
    refreshMapSources();
    updateDashboardStats();
    showToast('Reset all walks and street progress.');
  });

  // Inspector actions
  document.getElementById('btn-close-inspector').addEventListener('click', () => {
    state.selectedBlockId = null;
    state.selectedStreetName = null;
    refreshMapSources();
    updateInspectorUI();
  });

  document.getElementById('btn-toggle-block-walked').addEventListener('click', () => {
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

  document.getElementById('btn-focus-full-street').addEventListener('click', () => {
    const b = state.selectedBlockId ? state.blockById.get(state.selectedBlockId) : null;
    if (!b) return;
    const info = state.streetsByName.get(b.s);
    if (info) {
      selectStreetByName(b.s, info.blockIds);
    }
  });

  // Live GPS button
  document.getElementById('btn-record-gps').addEventListener('click', toggleLiveGpsRecording);

  // Sync modal open/close
  const modal = document.getElementById('sync-modal-backdrop');
  document.getElementById('btn-open-sync-modal').addEventListener('click', () => {
    modal.classList.remove('hidden');
  });
  document.getElementById('btn-close-sync-modal').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  // File upload (.gpx, .tcx, .json)
  const fileInput = document.getElementById('input-file-upload');
  fileInput.addEventListener('change', async (e) => {
    await handleUploadedFiles(e.target.files);
    fileInput.value = '';
  });

  const dropzone = document.getElementById('file-dropzone');
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

  // Strava Access Token or saved Refresh Token sync
  document.getElementById('btn-sync-strava-token').addEventListener('click', async () => {
    const manualToken = document.getElementById('input-strava-token').value.trim();
    if (manualToken) {
      await fetchStravaActivitiesWithToken(manualToken);
      return;
    }
    const autoToken = await getValidStravaAccessToken();
    if (autoToken) {
      await fetchStravaActivitiesWithToken(autoToken);
      return;
    }
    showToast('Connect via Strava OAuth below (one-time setup) or paste an Access Token.');
  });

  // Strava OAuth redirect
  document.getElementById('btn-strava-oauth').addEventListener('click', () => {
    const clientId = document.getElementById('input-strava-client-id').value.trim();
    const clientSecret = document.getElementById('input-strava-client-secret').value.trim();
    if (!clientId || !clientSecret) {
      showToast('Enter your Strava Client ID & Client Secret first.');
      return;
    }
    saveStravaConfig({ clientId, clientSecret });
    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    const authUrl =
      `https://www.strava.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&response_type=code&redirect_uri=${redirectUri}` +
      `&approval_prompt=auto&scope=read,activity:read_all`;
    window.location.href = authUrl;
  });

  // Export backup JSON
  document.getElementById('btn-export-backup').addEventListener('click', () => {
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
    document.getElementById('sync-modal-backdrop').classList.add('hidden');
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
      const reg = await navigator.serviceWorker.register('./sw.js?v=3');
      await reg.update();
    } catch {}
  }

  initMap();
  wireEvents();
  loadInitialData();
});
