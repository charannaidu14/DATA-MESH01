console.log('DATA MESH frontend loaded');

const API_BASE = '/api';

const dashboardState = {
  connected: false,
  overview: null,
  nodes: [],
  objects: [],
  activity: [],
  integrity: null
};

// DOM references
const nodeHealthTag = document.querySelector('.node-health-tag');
const replicationTag = document.querySelector('.replication-status-tag');
const recoveryTag = document.querySelector('.recovery-status-tag');
const recoveryWorkflowTag = document.querySelector('.recovery-workflow-tag');
const uploadStatusTag = document.querySelector('.upload-status-tag');
const integrityStatusTag = document.querySelector('.integrity-status-tag');
const activityStatusTag = document.querySelector('.activity-status-tag');
const uploadTriggerBtn = document.querySelector('.upload-trigger-btn');
const uploadInput = document.querySelector('.object-upload-input');
const objectSearch = document.querySelector('.search-box input');
const objectFilter = document.querySelector('.filter-select');
const integrityCheckButton = document.querySelector('.integrity-check-button');
const integrityRepairButton = document.querySelector('.integrity-repair-button');
const quickRepairBtn = document.getElementById('quick-repair-btn');
const dropZone = document.getElementById('drop-zone');

let dashboardRequestInFlight = false;

// Toast helper
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✔' : type === 'error' ? '✖' : '⚠'}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

async function apiRequest(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `API request failed: ${response.status}`);
  }

  return result;
}

async function loadDashboard() {
  if (dashboardRequestInFlight) return;
  dashboardRequestInFlight = true;

  try {
    const data = await apiRequest('/dashboard');
    dashboardState.connected = true;
    dashboardState.overview = data.overview;
    dashboardState.nodes = data.nodes || [];
    dashboardState.objects = data.objects || [];
    dashboardState.activity = data.activity || [];
    dashboardState.integrity = data.integrity;

    renderDashboard(data);
  } catch (error) {
    console.error('Unable to load dashboard:', error);
  } finally {
    dashboardRequestInFlight = false;
  }
}

function renderDashboard(data) {
  const connectionBadge = document.querySelector('.connection-badge');
  const bannerTag = document.querySelector('.banner-tag');
  const bannerTitle = document.getElementById('banner-title');
  const bannerDescription = document.getElementById('banner-description');
  const objectMeta = document.querySelector('.object-section-meta');

  const healthyCount = (data.nodes || []).filter(n => n.status === 'healthy').length;
  const totalCount = (data.nodes || []).length;
  const isHealthy = healthyCount === totalCount;
  const isDegraded = healthyCount < totalCount && healthyCount >= 2;
  const isQuorumLost = healthyCount < 2;

  if (connectionBadge) {
    connectionBadge.innerHTML = `<i aria-hidden="true" style="background: ${isHealthy ? '#10b981' : isDegraded ? '#f59e0b' : '#ef4444'};"></i> ${
      isHealthy ? 'Cluster Healthy' : isDegraded ? 'Cluster Degraded' : 'Quorum Lost'
    }`;
  }

  if (bannerTag) {
    bannerTag.className = `state-tag ${isHealthy ? 'state-real' : isDegraded ? 'state-empty' : 'state-error'}`;
    bannerTag.textContent = isHealthy ? 'CLUSTER OPTIMAL' : isDegraded ? 'DEGRADED (QUORUM ACTIVE)' : 'CRITICAL OUTAGE';
  }

  if (bannerTitle) {
    bannerTitle.textContent = isHealthy
      ? 'Distributed 4-Node Mesh Active'
      : isDegraded
        ? `Cluster Degraded: ${healthyCount}/${totalCount} Nodes Online`
        : `CRITICAL: Quorum Lost (${healthyCount}/${totalCount} Nodes)`;
  }

  if (bannerDescription) {
    bannerDescription.textContent = isHealthy
      ? 'Fault-tolerant 3x replica storage operational. All storage nodes are healthy and actively replicating.'
      : isDegraded
        ? 'Some storage nodes are offline. Read quorum is active and replicas can be automatically rebalanced.'
        : 'Fewer than 2 nodes online. Replicas cannot achieve quorum. Restore nodes immediately.';
  }

  if (objectMeta) {
    objectMeta.textContent = `${(data.objects || []).length} object(s) stored in distributed mesh`;
  }

  updateMetrics(data.overview || {});
  updateCapacity(data.nodes || []);
  renderNodes(data.nodes || []);
  renderObjects(data.objects || []);
  renderTopology(data.nodes || []);
  renderRecovery(data.recovery);
  renderIntegrity(data.integrity);
  renderActivity(data.activity || []);
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

function updateCapacity(nodes) {
  const tag = document.querySelector('.capacity-status-tag');
  const usage = document.querySelector('.usage-ring span');
  const used = document.querySelector('.capacity-used');
  const available = document.querySelector('.capacity-available');

  const totalUsed = nodes.reduce((acc, n) => acc + (n.usedBytes || 0), 0);
  const totalCap = nodes.reduce((acc, n) => acc + (n.capacityBytes || 0), 0);
  const percent = totalCap > 0 ? ((totalUsed / totalCap) * 100).toFixed(1) : '0';

  if (usage) usage.textContent = `${percent}%`;
  if (used) used.textContent = `${(totalUsed / (1024 * 1024)).toFixed(2)} MB`;
  if (available) available.textContent = `${((totalCap - totalUsed) / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (tag) setStatusTag(tag, 'real', `${percent}% USED`);
}

function renderNodes(nodes) {
  const container = document.getElementById('nodes-grid');
  if (!container) return;

  const healthyCount = nodes.filter(n => n.status === 'healthy').length;
  setStatusTag(nodeHealthTag, healthyCount === nodes.length ? 'real' : healthyCount >= 2 ? 'empty' : 'error', `${healthyCount}/${nodes.length} HEALTHY`);

  container.innerHTML = nodes.map(node => {
    const isOnline = node.status === 'healthy';
    return `
      <article class="node-card ${isOnline ? '' : 'offline'}">
        <div class="node-card-header">
          <div class="node-title-group">
            <h3>${escapeHtml(node.name)}</h3>
            <small>${escapeHtml(node.endpoint)}</small>
          </div>
          <span class="node-pill ${isOnline ? 'online' : 'offline'}">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${isOnline ? '#10b981' : '#ef4444'};"></span>
            ${isOnline ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>

        <div class="node-metrics-grid">
          <div class="node-metric-item">
            <span>CPU</span>
            <strong>${escapeHtml(node.cpu || '0.2%')}</strong>
          </div>
          <div class="node-metric-item">
            <span>Memory</span>
            <strong>${escapeHtml(node.memory || '1.1%')}</strong>
          </div>
          <div class="node-metric-item">
            <span>Used Space</span>
            <strong>${escapeHtml(node.usedCapacity || '0 B')}</strong>
          </div>
          <div class="node-metric-item">
            <span>Replicas</span>
            <strong>${node.replicaCount || 0} objects</strong>
          </div>
        </div>

        <div class="node-card-actions">
          <button 
            type="button" 
            class="btn-node-toggle ${isOnline ? 'btn-fail' : 'btn-restore'}"
            data-node-id="${escapeHtml(node.id)}"
          >
            ${isOnline ? '⚡ Simulate Outage (Fail Node)' : '✔ Restore Node (Bring Online)'}
          </button>
        </div>
      </article>
    `;
  }).join('');

  // Attach node toggle handlers
  container.querySelectorAll('.btn-node-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const nodeId = btn.dataset.nodeId;
      btn.disabled = true;
      btn.textContent = 'Updating state...';

      try {
        const res = await apiRequest(`/nodes/${encodeURIComponent(nodeId)}/toggle`, { method: 'POST' });
        showToast(`${res.node.name} is now ${res.node.status.toUpperCase()}`, res.node.status === 'healthy' ? 'success' : 'warning');
        await loadDashboard();
      } catch (err) {
        showToast(`Failed to toggle node: ${err.message}`, 'error');
      }
    });
  });
}

function renderObjects(objects) {
  const table = document.querySelector('.data-table');
  if (!table) return;

  if (!objects.length) {
    table.innerHTML = `
      <div class="table-row table-header" role="row">
        <span>OBJECT NAME</span>
        <span>SIZE</span>
        <span>REPLICAS</span>
        <span>LAST MODIFIED</span>
        <span>STATUS</span>
        <span style="text-align: right;">ACTIONS</span>
      </div>
      <div class="table-empty" role="row">
        <span class="empty-icon large" aria-hidden="true">▤</span>
        <strong>No objects stored yet</strong>
        <p>Upload a file using the upload zone above to replicate it across the cluster.</p>
      </div>
    `;
    return;
  }

  table.innerHTML = `
    <div class="table-row table-header" role="row">
      <span>OBJECT NAME</span>
      <span>SIZE</span>
      <span>REPLICAS</span>
      <span>LAST MODIFIED</span>
      <span>STATUS</span>
      <span style="text-align: right;">ACTIONS</span>
    </div>

    ${objects.map(obj => {
      const replicasCount = obj.replicas ? obj.replicas.length : 3;
      const statusClass = obj.status === 'available' ? 'status-available' : obj.status === 'degraded' ? 'status-degraded' : 'status-offline';

      return `
        <div class="table-row" data-size="${Number(obj.sizeBytes) || 0}" data-modified="${Date.parse(obj.lastModified) || 0}">
          <span><strong>${escapeHtml(obj.name)}</strong></span>
          <span>${escapeHtml(obj.size)}</span>
          <span><span class="replica-badge">${replicasCount}x Replicas (${(obj.replicas || []).join(', ')})</span></span>
          <span>${new Date(obj.lastModified).toLocaleTimeString()}</span>
          <span><span class="status-pill ${statusClass}">${escapeHtml(obj.status.toUpperCase())}</span></span>
          <span class="table-actions">
            <button class="action-btn btn-download" data-name="${escapeHtml(obj.name)}" title="Download file">⬇ Download</button>
            <button class="action-btn btn-corrupt" data-name="${escapeHtml(obj.name)}" title="Inject corruption test">⚡ Corrupt</button>
            <button class="action-btn btn-delete" data-name="${escapeHtml(obj.name)}" title="Delete file">✖</button>
          </span>
        </div>
      `;
    }).join('')}
  `;

  // Attach object action listeners
  table.querySelectorAll('.btn-download').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      window.location.href = `${API_BASE}/objects/${encodeURIComponent(name)}/download`;
    });
  });

  table.querySelectorAll('.btn-corrupt').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      btn.disabled = true;
      try {
        await apiRequest(`/objects/${encodeURIComponent(name)}/corrupt`, { method: 'POST' });
        showToast(`Corrupted replica of "${name}". Run integrity check to detect and repair!`, 'warning');
        await loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });

  table.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      if (!confirm(`Are you sure you want to delete "${name}" from all cluster nodes?`)) return;
      btn.disabled = true;
      try {
        await apiRequest(`/objects/${encodeURIComponent(name)}`, { method: 'DELETE' });
        showToast(`Deleted "${name}"`, 'success');
        await loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  filterObjects();
}

function renderTopology(nodes) {
  const container = document.getElementById('replication-topology');
  if (!container) return;

  container.innerHTML = nodes.map(node => `
    <div class="topology-node ${node.status === 'healthy' ? '' : 'offline'}" style="opacity: ${node.status === 'healthy' ? '1' : '0.5'};">
      <span class="topology-icon" aria-hidden="true" style="color: ${node.status === 'healthy' ? '#65e4bc' : '#ef4444'};">▦</span>
      <strong>${escapeHtml(node.name)}</strong>
      <small style="color:${node.status === 'healthy' ? '#6ee7b7' : '#f87171'};">${escapeHtml(node.status.toUpperCase())}</small>
      <small style="margin-top:4px;">${node.replicaCount || 0} replicas</small>
    </div>
  `).join('');
}

function renderRecovery(recovery) {
  const steps = document.getElementById('recovery-steps');
  const history = document.querySelector('.recovery-history');
  if (!recovery) return;

  const healthy = recovery.status === 'healthy';
  setStatusTag(recoveryTag, healthy ? 'real' : 'error', healthy ? 'ALL NODES HEALTHY' : 'OUTAGE DETECTED');
  setStatusTag(recoveryWorkflowTag, healthy ? 'real' : 'error', healthy ? 'PIPELINE READY' : 'FAULT HEALING');

  if (steps) {
    steps.innerHTML = `
      <li><span class="step-marker">1</span><div><strong>Node reachability</strong><small>${recovery.healthyNodes} of ${recovery.totalNodes} nodes reachable</small></div></li>
      <li><span class="step-marker">2</span><div><strong>Replica quorum check</strong><small>${recovery.healthyNodes >= 2 ? 'Quorum satisfied (>=2 nodes)' : 'Quorum lost (<2 nodes)'}</small></div></li>
      <li><span class="step-marker">3</span><div><strong>Self-healing engine</strong><small>${healthy ? 'Zero damaged blocks' : 'Ready to rebalance'}</small></div></li>
    `;
  }

  if (history) {
    const events = recovery.events || [];
    history.innerHTML = events.length
      ? events.map(event => `
        <div class="event-row">
          <span>${new Date(event.time).toLocaleTimeString()}</span>
          <span>${escapeHtml(event.type)}</span>
          <span style="color:${event.status === 'ok' ? '#10b981' : '#f59e0b'};font-weight:700;">${escapeHtml(event.status.toUpperCase())}</span>
          <span>${escapeHtml(event.message)}</span>
        </div>
      `).join('')
      : `<span class="empty-icon" aria-hidden="true">↻</span><strong>No node health changes observed</strong><p>${escapeHtml(recovery.detail)}</p>`;
  }
}

function renderIntegrity(integrity) {
  const checkCount = document.querySelector('.integrity-check-count');
  const checkStatus = document.querySelector('.integrity-check-status');
  const corruptionStatus = document.querySelector('.integrity-corruption-status');
  const resultTitle = document.querySelector('.integrity-result-title');
  const resultDetail = document.querySelector('.integrity-result-detail');
  const breakdown = document.getElementById('integrity-breakdown-table');

  if (!integrity) return;

  const failed = Number(integrity.failed) || 0;
  const passed = Number(integrity.passed) || 0;
  const total = Number(integrity.totalObjects) || 0;

  if (integrity.status === 'not-checked') {
    setStatusTag(integrityStatusTag, 'empty', 'NOT CHECKED');
    if (checkCount) checkCount.textContent = `0/${total}`;
    if (checkStatus) checkStatus.textContent = 'Ready to scan';
    if (corruptionStatus) corruptionStatus.textContent = 'Not checked';
    if (resultTitle) resultTitle.textContent = 'Integrity verification ready';
    if (resultDetail) resultDetail.textContent = 'Click "Run integrity check" to verify replicas across nodes.';
    if (breakdown) breakdown.hidden = true;
    return;
  }

  const isOk = failed === 0;
  setStatusTag(integrityStatusTag, isOk ? 'real' : 'error', isOk ? 'ALL REPLICAS VERIFIED' : `${failed} CORRUPTIONS FOUND`);

  if (checkCount) checkCount.textContent = `${passed}/${total}`;
  if (checkStatus) checkStatus.textContent = isOk ? 'All verified' : 'Issues found';
  if (corruptionStatus) corruptionStatus.textContent = failed ? `${failed} damaged block(s)` : 'Zero mismatches';
  if (resultTitle) resultTitle.textContent = isOk ? 'Data integrity check passed' : 'Integrity issues detected!';
  if (resultDetail) resultDetail.textContent = integrity.detail;

  if (breakdown && integrity.details && integrity.details.length) {
    breakdown.hidden = false;
    breakdown.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;font-size:12px;color:#cbd5e1;">Verification breakdown:</div>
      ${integrity.details.map(item => `
        <div class="integrity-item-row">
          <span><strong>${escapeHtml(item.name)}</strong></span>
          <span style="color:${item.status === 'verified' ? '#10b981' : '#ef4444'};font-weight:700;">
            ${item.status === 'verified' ? '✔ VERIFIED' : '✖ MISMATCH / DAMAGED'}
          </span>
        </div>
      `).join('')}
    `;
  }
}

function renderActivity(events) {
  const panel = document.querySelector('.activity-panel');
  if (!panel) return;

  setStatusTag(activityStatusTag, events.length ? 'real' : 'empty', `${events.length} EVENTS`);

  if (!events.length) {
    panel.innerHTML = `
      <div class="event-header"><span>TIME</span><span>EVENT TYPE</span><span>STATUS</span><span>MESSAGE</span></div>
      <div class="activity-empty"><span class="empty-icon" aria-hidden="true">≡</span><strong>No events logged yet</strong><p>Cluster events will appear here in real time.</p></div>
    `;
    return;
  }

  panel.innerHTML = `
    <div class="event-header"><span>TIME</span><span>EVENT TYPE</span><span>STATUS</span><span>MESSAGE</span></div>
    ${events.map(event => `
      <div class="event-row">
        <span>${new Date(event.time).toLocaleTimeString()}</span>
        <span>${escapeHtml(event.type)}</span>
        <span style="color:${event.status === 'ok' ? '#10b981' : event.status === 'warning' ? '#f59e0b' : '#ef4444'};font-weight:700;">${escapeHtml(event.status.toUpperCase())}</span>
        <span>${escapeHtml(event.message)}</span>
      </div>
    `).join('')}
  `;
}

function filterObjects() {
  if (!objectSearch || !objectFilter) return;
  const query = objectSearch.value.trim().toLowerCase();
  const filter = objectFilter.value;
  const recentAfter = Date.now() - 24 * 60 * 60 * 1000;
  const rows = [...document.querySelectorAll('.data-table .table-row[data-size]')];

  rows.forEach(row => {
    const matchesQuery = row.textContent.toLowerCase().includes(query);
    const matchesFilter = filter === 'all' ||
      (filter === 'large' && Number(row.dataset.size) > 1024 * 1024) ||
      (filter === 'recent' && Number(row.dataset.modified) >= recentAfter);
    row.hidden = !(matchesQuery && matchesFilter);
  });
}

function setStatusTag(element, state, label) {
  if (!element) return;
  element.classList.remove('state-real', 'state-error', 'state-empty', 'state-loading', 'state-disabled', 'state-disconnected');
  element.classList.add(`state-${state}`);
  element.textContent = label;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Upload handlers
async function handleFileUpload(file) {
  if (!file) return;

  const statusText = document.querySelector('.upload-status-text');
  if (statusText) statusText.textContent = `Uploading and replicating ${file.name}...`;

  try {
    const formData = new FormData();
    formData.append('file', file);

    const result = await apiRequest('/objects/upload', {
      method: 'POST',
      body: formData
    });

    showToast(`Uploaded ${result.name} (SHA-256: ${result.sha256.slice(0, 10)}...)`, 'success');
    if (statusText) statusText.textContent = `Uploaded and replicated ${result.name} across ${result.replicas.length} nodes.`;
    await loadDashboard();
  } catch (err) {
    showToast(`Upload failed: ${err.message}`, 'error');
    if (statusText) statusText.textContent = `Upload failed: ${err.message}`;
  }
}

if (uploadTriggerBtn && uploadInput) {
  uploadTriggerBtn.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', () => {
    if (uploadInput.files[0]) {
      handleFileUpload(uploadInput.files[0]);
      uploadInput.value = '';
    }
  });
}

// Drag and drop handlers
if (dropZone) {
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.style.borderColor = '#75e3ff';
    dropZone.style.background = 'rgba(117, 227, 255, 0.08)';
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = '';
    dropZone.style.background = '';
  });

  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.style.borderColor = '';
    dropZone.style.background = '';
    if (e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });
}

// Integrity Check button
if (integrityCheckButton) {
  integrityCheckButton.addEventListener('click', async () => {
    integrityCheckButton.disabled = true;
    integrityCheckButton.textContent = 'Verifying SHA-256...';

    try {
      const res = await apiRequest('/integrity/verify', { method: 'POST' });
      showToast(res.failed ? `Detected ${res.failed} corrupted replica(s)!` : 'All object replicas verified 100% intact!', res.failed ? 'error' : 'success');
      await loadDashboard();
    } catch (err) {
      showToast(`Verification failed: ${err.message}`, 'error');
    } finally {
      integrityCheckButton.disabled = false;
      integrityCheckButton.textContent = 'Run integrity check';
    }
  });
}

// Integrity Auto-Repair button
if (integrityRepairButton) {
  integrityRepairButton.addEventListener('click', async () => {
    integrityRepairButton.disabled = true;
    integrityRepairButton.textContent = 'Healing cluster...';

    try {
      const res = await apiRequest('/integrity/repair', { method: 'POST' });
      showToast(res.summary, 'success');
      await loadDashboard();
    } catch (err) {
      showToast(`Repair failed: ${err.message}`, 'error');
    } finally {
      integrityRepairButton.disabled = false;
      integrityRepairButton.textContent = 'Auto-repair replicas';
    }
  });
}

// Quick Repair button in topbar
if (quickRepairBtn) {
  quickRepairBtn.addEventListener('click', async () => {
    quickRepairBtn.disabled = true;
    quickRepairBtn.textContent = 'Healing...';

    try {
      const res = await apiRequest('/nodes/repair', { method: 'POST' });
      showToast(res.summary, 'success');
      await loadDashboard();
    } catch (err) {
      showToast(`Heal failed: ${err.message}`, 'error');
    } finally {
      quickRepairBtn.disabled = false;
      quickRepairBtn.textContent = '⚡ Heal & Rebalance';
    }
  });
}

if (objectSearch) objectSearch.addEventListener('input', filterObjects);
if (objectFilter) objectFilter.addEventListener('change', filterObjects);

// Initial load
loadDashboard();

// Periodic poll every 15s
setInterval(() => {
  if (document.visibilityState === 'visible') {
    loadDashboard();
  }
}, 15000);

// Real-time WebSocket connection
let socket = null;
if (typeof WebSocket !== 'undefined') {
  try {
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    );

    socket.addEventListener('message', event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'dashboard.updated') {
          renderDashboard(msg.data);
        }
      } catch {}
    });
  } catch {}
}

