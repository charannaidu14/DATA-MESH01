console.log('DATA MESH frontend loaded');
const API_BASE = '/api';

const dashboardState = {
  connected: false,
  overview: null,
  nodes: [],
  objects: [],
  activity: []
};

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return response.json();
}

async function loadDashboard() {
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
  }
}

function renderDashboard(data) {
  const connectionBadge = document.querySelector('.connection-badge');
  const bannerTag = document.querySelector('.connection-banner .state-tag');
  const footerStatus = document.querySelector('.footer-status');

  if (!data.connected) {
    connectionBadge.innerHTML = '<i aria-hidden="true"></i> Disconnected';
    bannerTag.textContent = 'DISCONNECTED';
    footerStatus.innerHTML = '<i></i> Cluster disconnected';
    return;
  }

  connectionBadge.innerHTML = '<i aria-hidden="true"></i> Connected';
  bannerTag.textContent = 'CONNECTED';
  footerStatus.innerHTML = '<i></i> Cluster connected';

  updateMetrics(data.overview);
  renderNodes(data.nodes);
  renderObjects(data.objects);
  renderActivity(data.activity);
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

  if (!nodes.length) {
    return;
  }

  emptyState.innerHTML = `
    <div class="node-list">
      ${nodes.map(node => `
        <article class="node-row">
          <strong>${escapeHtml(node.name)}</strong>
          <span>${escapeHtml(node.status)}</span>
          <span>CPU: ${node.cpu}%</span>
          <span>Memory: ${node.memory}%</span>
          <span>Disk: ${node.disk}%</span>
        </article>
      `).join('')}
    </div>
  `;
}

function renderObjects(objects) {
  const table = document.querySelector('.data-table');

  if (!objects.length) {
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
}

function renderActivity(events) {
  const panel = document.querySelector('.activity-panel');

  if (!events.length) {
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

function showConnectionError() {
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

loadDashboard();

const socket = new WebSocket(
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
);

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);

  if (message.type === 'dashboard.updated') {
    renderDashboard(message.data);
  }
});
