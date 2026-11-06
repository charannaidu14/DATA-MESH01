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
const nodeHealthTag = document.querySelector('.node-health-tag');
const replicationTag = document.querySelector('.replication-status-tag');
const recoveryTag = document.querySelector('.recovery-status-tag');
const recoveryWorkflowTag = document.querySelector('.recovery-workflow-tag');
const rebalanceTag = document.querySelector('.rebalance-status-tag');
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

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return response.json();
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
    objectSearch.value = '';
    objectMeta.textContent = 'Connect a cluster to browse objects';
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
    objectMeta.textContent = `${(data.objects || []).length} object(s) in ${data.bucket || 'storage bucket'}`;
  }

  updateMetrics(data.overview || {});
  renderNodes(data.nodes || []);
  renderObjects(data.objects || []);
  renderActivity(data.activity || []);
  renderReplication(data.replication, data.nodes || []);
  renderRecovery(data.recovery);
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
          <span>${escapeHtml(node.status)}</span>
          <span>CPU: ${formatUsage(node.cpu)}</span>
          <span>Memory: ${formatUsage(node.memory)}</span>
          <span>Disk: ${formatUsage(node.disk)}</span>
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
      <div class="table-row">
        <span>${escapeHtml(object.name)}</span>
        <span>${escapeHtml(object.size)}</span>
        <span>${escapeHtml(object.lastModified)}</span>
        <span>${escapeHtml(object.status)}</span>
      </div>
    `).join('')}
  `;
  filterObjects();
}

function renderActivity(events) {
  const panel = document.querySelector('.activity-panel');

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
  setStatusTag(replicationTag, healthy ? 'real' : 'error', healthy ? 'HEALTHY' : 'DEGRADED');
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

  const healthy = rebalance.status === 'healthy';
  setStatusTag(rebalanceTag, healthy ? 'real' : 'error', healthy ? 'CLUSTER HEALTHY' : 'ATTENTION REQUIRED');
  document.querySelector('.rebalance-title').textContent = 'MinIO distributed erasure-coded placement';
  document.querySelector('.rebalance-detail').textContent = rebalance.detail;
  document.querySelector('.rebalance-nodes').textContent = `${rebalance.healthyNodes}/${rebalance.totalNodes}`;
  document.querySelector('.rebalance-history').textContent = 'Not exposed by S3 API';
}

function setStatusTag(element, state, label) {
  element.classList.remove('state-real', 'state-error', 'state-empty', 'state-disconnected');
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

function formatUsage(value) {
  return value == null ? '—' : `${escapeHtml(value)}%`;
}

function filterObjects() {
  const query = objectSearch.value.trim().toLowerCase();
  document.querySelectorAll('.data-table .table-row:not(.table-header)').forEach(row => {
    row.hidden = !row.textContent.toLowerCase().includes(query);
  });
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
