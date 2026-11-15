console.log('DATA MESH frontend loaded');
const API_BASE = '/api';

const dashboardState = {
  connected: false,
  overview: null,
  nodes: [],
  objects: [],
  activity: []
};

const initialNodeContent = document.querySelector('#nodes .empty-state').innerHTML;
const initialObjectTableContent = document.querySelector('.data-table').innerHTML;
const initialActivityContent = document.querySelector('.activity-panel').innerHTML;
const initialUploadMessage = document.querySelector('.upload-zone p').textContent;
const uploadButton = document.querySelector('.upload-zone button');
const uploadInput = document.querySelector('.object-upload-input');
const objectSearch = document.querySelector('.search-box input');
const objectFilter = document.querySelector('.filter-select');
const nodeHealthTag = document.querySelector('.node-health-tag');
const replicationTag = document.querySelector('.replication-status-tag');
const recoveryTag = document.querySelector('.recovery-status-tag');
const recoveryWorkflowTag = document.querySelector('.recovery-workflow-tag');
const rebalanceTag = document.querySelector('.rebalance-status-tag');
const uploadStatusTag = document.querySelector('.upload-status-tag');
const integrityStatusTag = document.querySelector('.integrity-status-tag');
const activityStatusTag = document.querySelector('.activity-status-tag');
const integrityCheckButton = document.querySelector('.integrity-check-button');
let dashboardRequestInFlight = false;

async function apiRequest(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `API request failed: ${response.status}`);
  }

  return result;
}

async function loadDashboard() {
  if (dashboardRequestInFlight) {
    return;
  }

  dashboardRequestInFlight = true;
  try {
    const data = await apiRequest('/dashboard');

    dashboardState.connected = data.connected;
    dashboardState.overview = data.overview;
    dashboardState.nodes = data.nodes || [];
    dashboardState.objects = data.objects || [];
    dashboardState.activity = data.activity || [];

    renderDashboard(data);
  } catch (error) {
    console.error('Unable to load dashboard:', error);
    showConnectionError();
  } finally {
    dashboardRequestInFlight = false;
  }
}

function renderDashboard(data) {
  const connectionBadge = document.querySelector('.connection-badge');
  const bannerTag = document.querySelector('.connection-banner .state-tag');
  const bannerTitle = document.querySelector('.connection-banner .banner-copy strong');
  const bannerDescription = document.querySelector('.connection-banner .banner-copy p');
  const footerStatus = document.querySelector('.footer-status');
  const profileStatus = document.querySelector('.profile small');
  const objectMeta = document.querySelector('.object-section-meta');
  const connected = Boolean(data.connected);
  dashboardState.connected = connected;

  if (!connected) {
    connectionBadge.innerHTML = '<i aria-hidden="true"></i> Disconnected';
    bannerTag.className = 'state-tag state-disconnected';
    bannerTag.textContent = 'DISCONNECTED';
    bannerTitle.textContent = 'Your workspace is ready to connect';
    bannerDescription.textContent = 'Connect a storage cluster to see live capacity, node health, and activity. Until then, metrics remain blank—no sample data is shown.';
    footerStatus.innerHTML = '<i></i> Cluster disconnected';
    profileStatus.textContent = 'Cluster not connected';
    document.querySelector('.upload-zone strong').textContent = 'Connect a cluster to upload objects';
    document.querySelector('.upload-zone p').textContent = initialUploadMessage;
    uploadButton.disabled = true;
    uploadInput.disabled = true;
    objectSearch.disabled = true;
    objectFilter.disabled = true;
    integrityCheckButton.disabled = true;
    objectSearch.value = '';
    objectFilter.value = 'all';
    objectMeta.textContent = 'Connect a cluster to browse objects';
    setStatusTag(uploadStatusTag, 'disabled', 'INACTIVE');
  } else {
    connectionBadge.innerHTML = '<i aria-hidden="true"></i> Connected';
    bannerTag.className = 'state-tag state-real';
    bannerTag.textContent = 'CONNECTED';
    bannerTitle.textContent = 'Storage cluster connected';
    bannerDescription.textContent = 'Live storage data is being reported by your connected MinIO backend.';
    footerStatus.innerHTML = '<i></i> Cluster connected';
    profileStatus.textContent = 'Cluster connected';
    document.querySelector('.upload-zone strong').textContent = 'Upload objects to connected storage';
    document.querySelector('.upload-zone p').textContent = initialUploadMessage;
    uploadButton.disabled = false;
    uploadInput.disabled = false;
    objectSearch.disabled = false;
    objectFilter.disabled = false;
    integrityCheckButton.disabled = false;
    objectMeta.textContent = `${(data.objects || []).length} object(s) in ${data.bucket || 'storage bucket'}`;
    setStatusTag(uploadStatusTag, 'real', 'ACTIVE');
  }

  updateMetrics(data.overview || {});
  updateCapacity(data.nodes || [], connected);
  renderNodes(data.nodes || []);
  renderObjects(data.objects || []);
  renderActivity(data.activity || []);
  renderReplication(data.replication, data.nodes || []);
  renderRecovery(data.recovery);
  renderIntegrity(data.integrity);
  renderRebalance(data.rebalance);
}

function updateMetrics(overview = {}) {
  const values = [
    overview.storageCapacity,
    overview.availableStorage,
    overview.nodeHealth,
    overview.replicationHealth,
    overview.systemAvailability,
    overview.storageThroughput
  ];

  document.querySelectorAll('.metric-value').forEach((element, index) => {
    element.textContent = values[index] ?? '—';
  });
}

function updateCapacity(nodes, connected) {
  const tag = document.querySelector('.capacity-status-tag');
  const usage = document.querySelector('.usage-ring span');
  const title = document.querySelector('.capacity-summary-title');
  const detail = document.querySelector('.capacity-summary-detail');
  const used = document.querySelector('.capacity-used');
  const available = document.querySelector('.capacity-available');
  const note = document.querySelector('.capacity-note span:last-child');
  const volume = nodes.find(node => node.capacity && node.availableCapacity);

  if (!connected) {
    setStatusTag(tag, 'disconnected', 'NO DATA');
    usage.textContent = '—';
    title.textContent = 'Capacity details will appear here';
    detail.textContent = 'Connect Docker-backed storage to read the MinIO data volume filesystem.';
    used.textContent = '—';
    available.textContent = '—';
    note.textContent = 'Capacity data is unavailable until a Docker-backed MinIO volume reports it.';
    return;
  }

  if (!volume) {
    setStatusTag(tag, 'empty', 'NOT REPORTED');
    usage.textContent = '—';
    title.textContent = 'Volume capacity not reported';
    detail.textContent = 'MinIO is connected, but Docker did not report a data-volume filesystem.';
    used.textContent = '—';
    available.textContent = '—';
    note.textContent = 'Capacity telemetry is unavailable for this storage configuration.';
    return;
  }

  const usagePercent = volume.usagePercent || '—';
  setStatusTag(tag, 'real', `${usagePercent} USED`);
  usage.textContent = usagePercent;
  title.textContent = `MinIO data volume (${volume.name})`;
  detail.textContent = `Docker-reported filesystem capacity: ${volume.capacity}. This is one node volume, not cluster usable capacity.`;
  used.textContent = volume.usedCapacity || '—';
  available.textContent = volume.availableCapacity || '—';
  note.textContent = 'Filesystem capacity is reported per MinIO node; do not sum volumes when they share the same Docker filesystem.';
}

function renderNodes(nodes) {
  const emptyState = document.querySelector('#nodes .empty-state');
  const healthyNodes = nodes.filter(node => node.status === 'healthy').length;
  const unhealthyNodes = nodes.length - healthyNodes;

  if (!dashboardState.connected) {
    setStatusTag(nodeHealthTag, 'disconnected', 'NO DATA');
  } else if (unhealthyNodes) {
    setStatusTag(nodeHealthTag, 'error', `${healthyNodes}/${nodes.length} HEALTHY`);
  } else {
    setStatusTag(nodeHealthTag, 'real', `${healthyNodes}/${nodes.length} HEALTHY`);
  }

  if (!nodes.length) {
    emptyState.innerHTML = initialNodeContent;
    return;
  }

  emptyState.innerHTML = `
    <div class="node-list">
      ${nodes.map(node => `
        <article class="node-row">
          <strong>${escapeHtml(node.name)}</strong>
          <span>Status: ${escapeHtml(node.status)}</span>
          <span>CPU: ${escapeHtml(node.cpu ?? '—')}</span>
          <span>Memory: ${escapeHtml(node.memory ?? '—')}</span>
          <span>Volume: ${escapeHtml(node.usedCapacity ?? '—')} used / ${escapeHtml(node.capacity ?? '—')}</span>
          <span>Disk I/O: ${formatIo(node.disk, 'read', 'written')}</span>
          <span>Network I/O: ${formatIo(node.network, 'received', 'sent')}</span>
        </article>
      `).join('')}
    </div>
  `;
}

function renderObjects(objects) {
  const table = document.querySelector('.data-table');

  if (!objects.length) {
    table.innerHTML = dashboardState.connected
      ? `
        <div class="table-row table-header">
          <span>OBJECT NAME</span>
          <span>SIZE</span>
          <span>LAST MODIFIED</span>
          <span>STATUS</span>
        </div>
        <div class="table-empty" role="row">
          <span class="empty-icon large" aria-hidden="true">▤</span>
          <strong>No objects stored yet</strong>
          <p>Upload an object to see it listed here.</p>
        </div>
      `
      : initialObjectTableContent;
    return;
  }

  table.innerHTML = `
    <div class="table-row table-header">
      <span>OBJECT NAME</span>
      <span>SIZE</span>
      <span>LAST MODIFIED</span>
      <span>STATUS</span>
    </div>

    ${objects.map(object => `
      <div class="table-row" data-size="${Number(object.sizeBytes) || 0}" data-modified="${Date.parse(object.lastModified) || 0}">
        <span>${escapeHtml(object.name)}</span>
        <span>${escapeHtml(object.size)}</span>
        <span>${escapeHtml(object.lastModified)}</span>
        <span>${escapeHtml(object.status)}</span>
      </div>
    `).join('')}
    <div class="table-empty filter-empty" hidden><strong>No objects match these filters</strong><p>Change the search or filter and try again.</p></div>
  `;
  filterObjects();
}

function renderActivity(events) {
  const panel = document.querySelector('.activity-panel');
  setStatusTag(
    activityStatusTag,
    events.length ? 'real' : 'empty',
    events.length ? `${events.length} EVENT${events.length === 1 ? '' : 'S'}` : 'NO EVENTS'
  );

  if (!events.length) {
    panel.innerHTML = initialActivityContent;
    return;
  }

  panel.innerHTML = `
    <div class="event-header">
      <span>TIME</span>
      <span>EVENT TYPE</span>
      <span>STATUS</span>
      <span>MESSAGE</span>
    </div>

    ${events.map(event => `
      <div class="event-row">
        <span>${escapeHtml(event.time)}</span>
        <span>${escapeHtml(event.type)}</span>
        <span>${escapeHtml(event.status)}</span>
        <span>${escapeHtml(event.message)}</span>
      </div>
    `).join('')}
  `;
}

function renderIntegrity(integrity) {
  const checkCount = document.querySelector('.integrity-check-count');
  const checkCaption = document.querySelector('.integrity-check-caption');
  const checkStatus = document.querySelector('.integrity-check-status');
  const corruptionStatus = document.querySelector('.integrity-corruption-status');
  const checksumDetails = document.querySelector('.integrity-checksum-details');
  const resultTitle = document.querySelector('.integrity-result-title');
  const resultDetail = document.querySelector('.integrity-result-detail');

  if (!integrity || !dashboardState.connected) {
    setStatusTag(integrityStatusTag, 'disconnected', 'UNAVAILABLE');
    checkCount.textContent = '—';
    checkCaption.textContent = 'Storage backend required';
    checkStatus.textContent = 'Not available';
    corruptionStatus.textContent = 'Not available';
    checksumDetails.textContent = '—';
    resultTitle.textContent = 'Verification results are unavailable';
    resultDetail.textContent = 'Connect a storage cluster to check object contents.';
    return;
  }

  if (integrity.status === 'not-checked') {
    setStatusTag(integrityStatusTag, 'empty', 'NOT CHECKED');
    checkCount.textContent = '0';
    checkCaption.textContent = `${integrity.totalObjects || 0} object(s) awaiting verification`;
    checkStatus.textContent = 'Not checked';
    corruptionStatus.textContent = 'Not checked';
    checksumDetails.textContent = 'SHA-256 / ETag';
    resultTitle.textContent = 'Verification has not run yet';
    resultDetail.textContent = integrity.detail;
    return;
  }

  if (integrity.status === 'empty') {
    setStatusTag(integrityStatusTag, 'empty', 'NO OBJECTS');
    checkCount.textContent = '0';
    checkCaption.textContent = 'No objects to verify';
    checkStatus.textContent = 'No objects';
    corruptionStatus.textContent = 'No objects';
    checksumDetails.textContent = '—';
    resultTitle.textContent = 'There are no objects to verify';
    resultDetail.textContent = integrity.detail;
    return;
  }

  const failed = Number(integrity.failed) || 0;
  const unverified = Number(integrity.unverified) || 0;
  const state = failed ? 'error' : unverified ? 'empty' : 'real';
  const label = failed ? 'ISSUES FOUND' : unverified ? 'PARTIAL' : 'VERIFIED';
  setStatusTag(integrityStatusTag, state, label);
  checkCount.textContent = `${integrity.passed}/${integrity.totalObjects}`;
  checkCaption.textContent = `${integrity.checked} checked; ${unverified} unverified`;
  checkStatus.textContent = failed ? 'Issues found' : unverified ? 'Partially verified' : 'All verified';
  corruptionStatus.textContent = failed ? `${failed} issue(s)` : 'No mismatches';
  checksumDetails.textContent = 'SHA-256 / ETag';
  resultTitle.textContent = failed ? 'Integrity issues require attention' : 'Integrity check complete';
  resultDetail.textContent = integrity.detail || 'No verification details returned.';
}

function renderReplication(replication, nodes) {
  const topology = document.querySelector('#replication-topology');
  const detail = document.querySelector('.replication-detail');

  if (!dashboardState.connected || !replication) {
    setStatusTag(replicationTag, 'disconnected', 'UNAVAILABLE');
    topology.innerHTML = '<div class="topology-node"><span class="topology-icon" aria-hidden="true">▦</span><strong>Waiting for cluster data</strong><small>Node health not available</small></div>';
    detail.textContent = 'Cluster topology is unavailable while disconnected.';
    topology.setAttribute('aria-label', 'MinIO cluster nodes unavailable');
    return;
  }

  const healthy = replication.health === 'healthy';
  setStatusTag(replicationTag, healthy ? 'real' : 'error', healthy ? 'CLUSTER READY' : 'DEGRADED');
  topology.setAttribute('aria-label', `${replication.mode}; ${replication.healthyNodes} of ${replication.totalNodes} nodes healthy`);
  topology.innerHTML = nodes.map(node => `
    <div class="topology-node">
      <span class="topology-icon" aria-hidden="true">▦</span>
      <strong>${escapeHtml(node.name)}</strong>
      <small>${escapeHtml(node.status)}</small>
    </div>
  `).join('') || '<div class="topology-node"><strong>No nodes configured</strong></div>';
  detail.textContent = `${replication.mode}. ${replication.healthyNodes}/${replication.totalNodes} nodes healthy. ${replication.detail}`;
}

function renderRecovery(recovery) {
  const steps = document.querySelector('#recovery-steps');
  const history = document.querySelector('.recovery-history');

  if (!dashboardState.connected || !recovery) {
    setStatusTag(recoveryTag, 'disconnected', 'UNAVAILABLE');
    setStatusTag(recoveryWorkflowTag, 'disconnected', 'UNAVAILABLE');
    steps.innerHTML = `
      <li><span class="step-marker">1</span><div><strong>Node reachability</strong><small>Waiting for cluster data</small></div></li>
      <li><span class="step-marker">2</span><div><strong>MinIO repair telemetry</strong><small>Waiting for cluster data</small></div></li>
      <li><span class="step-marker">3</span><div><strong>Repair event history</strong><small>Waiting for cluster data</small></div></li>
    `;
    history.innerHTML = '<span class="empty-icon" aria-hidden="true">↻</span><strong>Waiting for cluster data</strong><p>Recovery events will appear when reported by the storage backend.</p>';
    return;
  }

  const healthy = recovery.status === 'healthy';
  const status = healthy ? 'real' : 'error';
  const label = healthy ? 'NO FAILURES DETECTED' : 'ATTENTION REQUIRED';
  setStatusTag(recoveryTag, status, label);
  setStatusTag(recoveryWorkflowTag, status, healthy ? 'NODES HEALTHY' : 'NODE FAILURE DETECTED');
  steps.innerHTML = `
    <li><span class="step-marker">1</span><div><strong>Node reachability</strong><small>${recovery.healthyNodes} of ${recovery.totalNodes} nodes healthy</small></div></li>
    <li><span class="step-marker">2</span><div><strong>MinIO repair telemetry</strong><small>Not exposed by the S3 API</small></div></li>
    <li><span class="step-marker">3</span><div><strong>Observed node health changes</strong><small>${recovery.events?.length || 0} event(s) recorded this session</small></div></li>
  `;
  history.innerHTML = recovery.events?.length
    ? recovery.events.map(event => `
      <div class="event-row">
        <span>${escapeHtml(event.time)}</span>
        <span>${escapeHtml(event.type)}</span>
        <span>${escapeHtml(event.status)}</span>
        <span>${escapeHtml(event.message)}</span>
      </div>
    `).join('')
    : `<span class="empty-icon" aria-hidden="true">↻</span><strong>${healthy ? 'No node health changes observed' : 'Node failure detected'}</strong><p>${escapeHtml(recovery.detail)}</p>`;
}

function renderRebalance(rebalance) {
  if (!dashboardState.connected || !rebalance) {
    setStatusTag(rebalanceTag, 'disconnected', 'UNAVAILABLE');
    document.querySelector('.rebalance-title').textContent = 'Waiting for cluster data';
    document.querySelector('.rebalance-detail').textContent = 'Rebalance telemetry is unavailable while disconnected.';
    document.querySelector('.rebalance-nodes').textContent = '—';
    document.querySelector('.rebalance-history').textContent = '—';
    return;
  }

  if (rebalance.status === 'unavailable') {
    setStatusTag(rebalanceTag, 'disconnected', 'NOT REPORTED');
    document.querySelector('.rebalance-title').textContent = 'Rebalance telemetry unavailable';
    document.querySelector('.rebalance-detail').textContent = rebalance.detail;
    document.querySelector('.rebalance-nodes').textContent = `${rebalance.healthyNodes}/${rebalance.totalNodes}`;
    document.querySelector('.rebalance-history').textContent = 'Not exposed by S3 API';
    return;
  }

  const healthy = rebalance.status === 'healthy';
  setStatusTag(rebalanceTag, healthy ? 'real' : 'error', healthy ? 'CLUSTER HEALTHY' : 'ATTENTION REQUIRED');
  document.querySelector('.rebalance-title').textContent = 'MinIO distributed erasure-coded placement';
  document.querySelector('.rebalance-detail').textContent = rebalance.detail;
  document.querySelector('.rebalance-nodes').textContent = `${rebalance.healthyNodes}/${rebalance.totalNodes}`;
  document.querySelector('.rebalance-history').textContent = 'Not exposed by S3 API';
}

function setStatusTag(element, state, label) {
  if (!element) {
    return;
  }

  element.classList.remove(
    'state-real',
    'state-error',
    'state-empty',
    'state-loading',
    'state-disabled',
    'state-disconnected'
  );
  element.classList.add(`state-${state}`);
  element.textContent = label;
}

function showConnectionError() {
  renderDashboard({
    connected: false,
    overview: null,
    nodes: [],
    objects: [],
    activity: [],
    replication: null,
    recovery: null,
    rebalance: null
  });
  const badge = document.querySelector('.connection-badge');
  badge.innerHTML = '<i aria-hidden="true"></i> Backend unavailable';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatIo(value, firstLabel, secondLabel) {
  if (!value) {
    return '—';
  }

  const [first, ...rest] = String(value).split('/');
  if (!rest.length) {
    return escapeHtml(value);
  }

  return `${escapeHtml(first.trim())} ${firstLabel} / ${escapeHtml(rest.join('/').trim())} ${secondLabel}`;
}

function filterObjects() {
  const query = objectSearch.value.trim().toLowerCase();
  const filter = objectFilter.value;
  const recentAfter = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = [...document.querySelectorAll('.data-table .table-row[data-size]')];
  let visibleRows = 0;

  rows.forEach(row => {
    const matchesQuery = row.textContent.toLowerCase().includes(query);
    const matchesFilter = filter === 'all' ||
      (filter === 'large' && Number(row.dataset.size) > 1024 * 1024) ||
      (filter === 'recent' && Number(row.dataset.modified) >= recentAfter);
    row.hidden = !(matchesQuery && matchesFilter);
    if (!row.hidden) {
      visibleRows += 1;
    }
  });

  const noResults = document.querySelector('.filter-empty');
  if (noResults) {
    noResults.hidden = visibleRows > 0;
  }
}

loadDashboard();

uploadButton.addEventListener('click', () => uploadInput.click());

uploadInput.addEventListener('change', async () => {
  const file = uploadInput.files[0];
  if (!file) {
    return;
  }

  uploadButton.disabled = true;
  document.querySelector('.upload-zone p').textContent = `Uploading ${file.name}...`;

  try {
    const formData = new FormData();
    formData.append('file', file);
    const result = await apiRequest('/objects/upload', {
      method: 'POST',
      body: formData
    });

    await loadDashboard();
    document.querySelector('.upload-zone p').textContent = `Uploaded ${result.name} successfully.`;
  } catch (error) {
    document.querySelector('.upload-zone p').textContent = `Upload failed: ${error.message}`;
    console.error('Unable to upload object:', error);
  } finally {
    uploadButton.disabled = !dashboardState.connected;
    uploadInput.value = '';
  }
});

objectSearch.addEventListener('input', filterObjects);
objectFilter.addEventListener('change', filterObjects);

integrityCheckButton.addEventListener('click', async () => {
  integrityCheckButton.disabled = true;
  integrityCheckButton.textContent = 'Checking...';
  document.querySelector('.integrity-result-title').textContent = 'Checking stored objects...';
  document.querySelector('.integrity-result-detail').textContent = 'Large objects may take longer to verify.';

  try {
    await apiRequest('/integrity/verify', { method: 'POST' });
    await loadDashboard();
  } catch (error) {
    setStatusTag(integrityStatusTag, 'error', 'CHECK FAILED');
    document.querySelector('.integrity-result-title').textContent = 'Integrity check failed';
    document.querySelector('.integrity-result-detail').textContent = error.message;
    console.error('Unable to verify object integrity:', error);
  } finally {
    integrityCheckButton.disabled = !dashboardState.connected;
    integrityCheckButton.textContent = 'Run integrity check';
  }
});

function updateActiveNavigation() {
  const currentHash = location.hash || '#dashboard';
  document.querySelectorAll('.side-link').forEach(link => {
    const active = link.getAttribute('href') === currentHash;
    link.classList.toggle('active', active);
    if (active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

window.addEventListener('hashchange', updateActiveNavigation);
updateActiveNavigation();

window.setInterval(() => {
  if (document.visibilityState === 'visible') {
    loadDashboard();
  }
}, 15000);

let socket = null;

if (typeof WebSocket !== 'undefined') {
  try {
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    );

    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'dashboard.updated') {
          renderDashboard(message.data);
        }
      } catch (error) {
        console.warn('Dashboard update ignored:', error.message);
      }
    });

    socket.addEventListener('error', () => {
      console.warn('Realtime dashboard updates are unavailable.');
    });
  } catch (error) {
    console.warn('WebSocket unavailable:', error.message);
  }
}
