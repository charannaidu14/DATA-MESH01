"use strict";

// Same origin when served by Express, localhost:3000 when opened as a file.
const API_BASE_URL = location.protocol === "file:" ? "http://localhost:3000" : "";
const MAX_FILE_SIZE = 50 * 1024 * 1024;

let clusterConnected = false;
let selectedFiles = [];
let serverObjects = [];
let lastDash = null;

const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);

document.addEventListener("DOMContentLoaded", () => {
  injectStyles();
  setupUpload();
  setupSearch();
  setupRecoveryUI();
  setupIntegrityUI();
  setupRebalanceUI();
  updateConnectionUI();
  checkClusterConnection();
  setInterval(checkClusterConnection, 10000);
});

/* ---------- Small helpers ---------- */

function injectStyles() {
  const s = document.createElement("style");
  s.textContent = `
    .button-muted { color: #dce5f5; cursor: pointer; }
    .action-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .action-row .button { cursor: pointer; }
    .action-row .button:disabled { opacity: .5; cursor: not-allowed; }
    .action-msg { display: block; margin-top: 8px; color: #8997b1; font-size: 10px; }
    .step-marker.done { color: #06121d; border-color: #65e4bc; background: #65e4bc; }
    .event-list { display: flex; flex-direction: column; }
    .event-row, .result-row { display: grid; gap: 12px; padding: 10px 16px; border-bottom: 1px solid rgba(171,190,255,.07); color: #b8c3d7; font-size: 10px; }
    .event-row { grid-template-columns: .9fr 1fr .8fr 2fr; }
    .event-row.two { grid-template-columns: 1fr 2fr; padding: 10px 4px; }
    .result-row { grid-template-columns: 2fr 1fr 1.4fr; padding: 10px 4px; }
    .event-row span, .result-row span { overflow-wrap: anywhere; }
    .tone-ok { color: #6de1b9; } .tone-warning { color: #ffcc76; } .tone-error { color: #ff8e9a; }
    .list-empty { padding: 22px 12px; color: #8998b3; font-size: 10px; text-align: center; }
    @media (max-width: 700px) { .event-row { grid-template-columns: 1fr 1fr; } }
  `;
  document.head.appendChild(s);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + " " + units[i];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function show(v) {
  if (v === undefined || v === null || v === "") return "—";
  return String(v);
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function setTag(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = "state-tag " + cls;
}

function tone(status) {
  if (status === "ok" || status === "verified") return "tone-ok";
  if (status === "warning" || status === "started" || status === "degraded") return "tone-warning";
  if (status === "error" || status === "corrupt") return "tone-error";
  return "";
}

// Replace a placeholder element with a div that has an id (only once).
function container(selector, id) {
  let el = $(id);
  if (el) return el;
  const old = q(selector);
  if (!old) return null;
  el = document.createElement("div");
  el.id = id;
  old.replaceWith(el);
  return el;
}

async function api(path, method, body) {
  const res = await fetch(API_BASE_URL + path, {
    method: method || "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.error || "HTTP " + res.status);
  }
  return data;
}

/* ---------- Connection ---------- */

async function checkClusterConnection() {
  try {
    const res = await fetch(API_BASE_URL + "/api/health?time=" + Date.now());
    const data = await res.json();
    clusterConnected =
      res.ok &&
      data.status === "ok" &&
      (data.storage === undefined || data.storage === "connected");
  } catch (err) {
    console.error("Cannot reach backend:", err);
    clusterConnected = false;
  }

  updateConnectionUI();
  if (clusterConnected) await loadDashboard();
}

function setBadge(el, text, connected) {
  if (!el) return;
  el.classList.remove("connected", "disconnected");
  el.classList.add(connected ? "connected" : "disconnected");
  el.innerHTML = '<i aria-hidden="true"></i> ' + text;
}

function updateConnectionUI() {
  const on = clusterConnected;

  setBadge($("connectionStatus"), on ? "Connected" : "Disconnected", on);
  setBadge($("bannerConnectionStatus"), on ? "Connected" : "Disconnected", on);

  const footer = q(".footer-status");
  if (footer) {
    footer.classList.remove("connected", "disconnected");
    footer.classList.add(on ? "connected" : "disconnected");
    footer.innerHTML = "<i></i> " + (on ? "Cluster connected" : "Cluster disconnected");
  }

  const bannerTitle = q("#connect .banner-copy strong");
  const bannerText = q("#connect .banner-copy p");
  if (bannerTitle) bannerTitle.textContent = on ? "Storage cluster connected" : "Your workspace is ready to connect";
  if (bannerText) {
    bannerText.textContent = on
      ? "Live data from your 4-node storage cluster is shown below."
      : "Start the backend (node server.js) and open http://localhost:3000. Until then, metrics remain blank.";
  }
  setTag(q("#connect .state-tag"), on ? "CONNECTED" : "DISCONNECTED", on ? "state-real" : "state-disconnected");
  setTag(q("#uploadObjects .state-tag"), on ? "CLUSTER CONNECTED" : "CLUSTER DISCONNECTED", on ? "state-real" : "state-disabled");

  const profileSmall = q(".profile small");
  if (profileSmall) profileSmall.textContent = on ? "Cluster connected" : "Cluster not connected";

  const zoneTitle = q("#uploadObjects .upload-zone strong");
  const zoneText = q("#uploadObjects .upload-zone > p");
  if (zoneTitle) zoneTitle.textContent = on ? "Select files to upload" : "Select files to prepare them";
  if (zoneText) {
    zoneText.textContent = on
      ? "Choose files, then click Upload selected. Each file is copied to all 4 nodes."
      : "Files can be selected while disconnected. A connected storage backend is required to upload them.";
  }

  const toolbarMeta = q(".table-toolbar .section-meta");
  if (toolbarMeta) toolbarMeta.textContent = on ? "Stored objects and local selections" : "Local selections only · not uploaded";

  const objMeta = q('[aria-labelledby="objects-title"] .section-heading .section-meta');
  if (objMeta) objMeta.textContent = on ? "Live objects from DATA MESH storage" : "Connect a cluster to browse objects";

  // "Select files" is always usable. Only "Upload selected" needs the cluster.
  const selectBtn = $("uploadButton");
  if (selectBtn) selectBtn.disabled = false;
  updateSendButton();

  ["failBtn", "recoverBtn", "verifyBtn", "rebalanceBtn"].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = !on;
  });
}

/* ---------- Load + render everything ---------- */

async function loadDashboard() {
  try {
    const res = await fetch(API_BASE_URL + "/api/dashboard?time=" + Date.now());
    if (!res.ok) throw new Error("Dashboard HTTP " + res.status);
    const data = await res.json();
    lastDash = data;

    if (data.overview) {
      updateDashboardMetrics(data.overview);
      updateCapacity(data.overview);
      updateNodes(data.overview, data.nodes || []);
    }
    serverObjects = data.objects || [];
    renderObjects();
    renderReplication(data.nodes || [], data.replication || {});
    renderRecovery(data.recovery || {});
    renderIntegrity(data.integrity || {}, data.objects || []);
    renderActivity(data.activity || []);
    renderRebalance(data.rebalance || {});
  } catch (err) {
    console.error("Dashboard error:", err);
  }
}

function updateDashboardMetrics(o) {
  const items = [
    ["storageCapacity", "Disk space used"],
    ["availableStorage", "Free disk space"],
    ["nodeHealth", "Storage nodes reporting"],
    ["replicationHealth", "Objects with all 4 copies"],
    ["systemAvailability", "Server uptime"],
    ["storageThroughput", "Data written since start"]
  ];
  const cards = document.querySelectorAll(".metric-card");
  items.forEach(([key, caption], i) => {
    const card = cards[i];
    if (!card) return;
    const value = card.querySelector(".metric-value");
    const cap = card.querySelector(".metric-caption");
    if (value) {
      value.textContent = show(o[key]);
      value.style.fontSize = String(o[key] || "").length > 14 ? "20px" : "";
    }
    if (cap) cap.textContent = caption;
    card.dataset.state = "connected";
  });
  const meta = q("#dashboard .section-meta");
  if (meta) meta.innerHTML = '<span class="state-indicator"></span> Live data';
}

function updateCapacity(o) {
  const ring = q(".usage-ring span");
  if (ring) ring.textContent = (o.diskUsedPercent ?? 0) + "%";

  const title = q("#capacityPanel .usage-summary strong");
  const text = q("#capacityPanel .usage-summary p");
  if (title) title.textContent = "Local storage capacity";
  if (text) text.textContent = "Host disk: " + show(o.diskTotal) + ". DATA MESH stores every object on 4 nodes.";

  const labels = document.querySelectorAll("#capacityPanel .muted-label b");
  if (labels[0]) labels[0].textContent = show(o.totalStorageUsed) + " (all copies)";
  if (labels[1]) labels[1].textContent = show(o.availableStorage);

  const note = q("#capacityPanel .empty-inline");
  if (note) note.lastChild.textContent = " Capacity comes from the disk this server runs on.";

  setTag(q("#capacityPanel .state-tag"), "REAL DATA", "state-real");
}

function updateNodes(o, nodes) {
  const fields = document.querySelectorAll("#nodes .empty-fields b");
  const online = nodes.filter((n) => n.status === "online").length;
  const values = [
    online + "/" + nodes.length + " online",
    "Not measured",
    show(o.memoryUsed) + " of host RAM",
    show(o.totalStorageUsed),
    "Local only"
  ];
  fields.forEach((el, i) => (el.textContent = values[i] ?? "—"));

  const title = q("#nodes .empty-state strong");
  const text = q("#nodes .empty-state p");
  if (title) title.textContent = "4 storage nodes (1 primary, 3 replicas)";
  if (text) {
    text.textContent = nodes
      .map((n) => n.name + ": " + n.status + ", " + n.objects + " object(s), " + formatBytes(n.bytes))
      .join(" · ");
  }
  setTag(q("#nodes .section-heading > .state-tag"), "REAL DATA", "state-real");
}

/* ---------- Replication ---------- */

function renderReplication(nodes, rep) {
  const boxes = document.querySelectorAll(".topology-node");
  nodes.forEach((n, i) => {
    const box = boxes[i];
    if (!box) return;
    const label = i === 0 ? "Primary node" : "Replica " + i;
    box.querySelector("strong").textContent = label;
    box.querySelector("small").textContent = n.status + " · " + n.objects + " object(s)";
    box.style.opacity = n.status === "online" ? "1" : ".45";
  });

  const note = q(".topology-note");
  if (note) {
    const total = rep.totalObjects || 0;
    note.innerHTML =
      '<span class="state-indicator"></span> ' +
      (total
        ? escapeHtml(rep.fullyReplicated + " of " + total + " object(s) fully replicated on " + (rep.factor || 4) + " nodes")
        : "No objects stored yet") +
      ' <span class="note-separator">·</span> Each upload is copied to every online node.';
  }

  const degraded = (rep.totalObjects || 0) - (rep.fullyReplicated || 0);
  setTag(
    q("#replication .section-heading > .state-tag"),
    degraded > 0 ? "DEGRADED" : "REAL DATA",
    degraded > 0 ? "state-error" : "state-real"
  );
}

/* ---------- Recovery ---------- */

function setupRecoveryUI() {
  const ol = q(".recovery-steps");
  if (!ol || $("recoveryActions")) return;

  const div = document.createElement("div");
  div.id = "recoveryActions";
  div.innerHTML =
    '<div class="action-row">' +
    '<button id="failBtn" class="button button-muted" type="button" disabled>Simulate node failure (demo)</button>' +
    '<button id="recoverBtn" class="button button-primary" type="button" disabled>Run recovery</button>' +
    "</div>" +
    '<span id="recoveryMsg" class="action-msg" aria-live="polite"></span>';
  ol.after(div);

  $("failBtn").addEventListener("click", async () => {
    const failed = lastDash?.recovery?.failedNodes || [];
    const target = ["node-2", "node-3", "node-4"].find((n) => !failed.includes(n));
    const msg = $("recoveryMsg");
    if (!target) {
      msg.textContent = "All replica nodes are already offline. Run recovery first.";
      return;
    }
    try {
      msg.textContent = "Simulating failure of " + target + "...";
      const r = await api("/api/recovery/simulate-failure", "POST", { node: target });
      msg.textContent = target + " went offline and lost " + r.replicasLost + " replica(s). Click Run recovery.";
      await loadDashboard();
    } catch (err) {
      msg.textContent = "Failed: " + err.message;
    }
  });

  $("recoverBtn").addEventListener("click", async () => {
    const msg = $("recoveryMsg");
    try {
      msg.textContent = "Recovery running...";
      const r = await api("/api/recovery/run", "POST");
      const rec = r.recovery;
      msg.textContent =
        "Recovery finished: " + rec.replicasRestored + " replica(s) restored" +
        (rec.unrecoverable ? ", " + rec.unrecoverable + " unrecoverable." : ".");
      await loadDashboard();
    } catch (err) {
      msg.textContent = "Failed: " + err.message;
    }
  });
}

function renderRecovery(rec) {
  const steps = document.querySelectorAll(".recovery-steps li");
  const markers = document.querySelectorAll(".recovery-steps .step-marker");
  const names = document.querySelectorAll(".recovery-steps strong");
  const notes = document.querySelectorAll(".recovery-steps small");
  const failed = rec.failedNodes || [];
  const pending = failed.length > 0 || (rec.degradedObjects || 0) > 0;
  const last = rec.lastRecovery;

  function setStep(i, done, text) {
    if (!steps[i]) return;
    markers[i].classList.toggle("done", done);
    notes[i].textContent = text;
  }

  if (pending) {
    setStep(0, true, (failed.length ? failed.join(", ") + " offline" : "Replicas missing") + " · " + (rec.degradedObjects || 0) + " object(s) degraded");
    setStep(1, !!rec.sourceAvailable, rec.sourceAvailable ? "Healthy replica available as repair source" : "No healthy replica found");
    setStep(2, false, "Click Run recovery to start");
    setStep(3, false, "Waiting for recovery");
    setStep(4, false, "Waiting for recovery");
    setTag(q(".recovery-panel .state-tag"), "DEGRADED", "state-error");
  } else if (last) {
    setStep(0, true, "Failure of " + (last.failedNodes.join(", ") || "replicas") + " was detected");
    setStep(1, true, "Healthy replica used as repair source");
    setStep(2, true, "Recovery ran at " + fmtTime(last.time));
    setStep(3, true, last.replicasRestored + " replica(s) copied back and checked");
    setStep(4, last.unrecoverable === 0, last.unrecoverable ? last.unrecoverable + " object(s) unrecoverable" : "All 4 copies restored");
    setTag(q(".recovery-panel .state-tag"), "RECOVERED", "state-real");
  } else {
    setStep(0, false, "No failures detected");
    setStep(1, false, "No repair needed");
    setStep(2, false, "No recovery in progress");
    setStep(3, false, "All replicas in sync");
    setStep(4, false, "System healthy");
    setTag(q(".recovery-panel .state-tag"), "HEALTHY", "state-real");
  }
  names.forEach(() => {});

  setTag(
    q("#recovery > .section-heading > .state-tag"),
    pending ? "DEGRADED" : last ? "RECOVERED" : "HEALTHY",
    pending ? "state-error" : "state-real"
  );

  const hist = container(".history-panel .compact-empty", "recoveryHistory");
  if (hist) {
    const events = rec.history || [];
    hist.innerHTML = events.length
      ? '<div class="event-list">' +
        events
          .map(
            (e) =>
              '<div class="event-row two"><span>' + escapeHtml(fmtTime(e.time)) + '</span><span class="' + tone(e.status) + '">' + escapeHtml(e.message) + "</span></div>"
          )
          .join("") +
        "</div>"
      : '<div class="list-empty">No recovery events yet. Use "Simulate node failure" to try it.</div>';
  }
}

/* ---------- Data integrity ---------- */

function setupIntegrityUI() {
  const old = q(".verification-empty");
  if (!old || $("integrityBody")) return;

  const div = document.createElement("div");
  div.id = "integrityBody";
  div.innerHTML =
    '<div class="action-row"><button id="verifyBtn" class="button button-primary" type="button" disabled>Verify all objects</button></div>' +
    '<span id="integrityMsg" class="action-msg" aria-live="polite"></span>' +
    '<div id="integrityResults"></div>';
  old.replaceWith(div);

  $("verifyBtn").addEventListener("click", async () => {
    const msg = $("integrityMsg");
    try {
      msg.textContent = "Verifying checksums...";
      await api("/api/integrity/verify", "POST");
      msg.textContent = "";
      await loadDashboard();
    } catch (err) {
      msg.textContent = "Failed: " + err.message;
    }
  });
}

function renderIntegrity(integrity, objects) {
  const v = integrity.lastVerification;
  const stats = document.querySelectorAll(".integrity-stat");
  const set = (i, value, small) => {
    if (!stats[i]) return;
    stats[i].querySelector("strong").textContent = value;
    stats[i].querySelector("small").textContent = small;
  };

  if (v) {
    set(0, v.verified + "/" + v.checked, "objects verified · " + fmtTime(v.time));
    set(1, v.corrupt ? "Corruption found" : v.warnings ? "Warnings" : "All verified", v.warnings + " warning(s)");
    set(2, v.corrupt ? v.corrupt + " corrupt" : "None found", "Every copy compared to its checksum");
  } else {
    set(0, String(objects.length), "object(s) stored · not verified yet");
    set(1, "Not run", "Click Verify all objects");
    set(2, "Not run", "No verification results yet");
  }
  set(3, "SHA-256", "Fingerprint saved when each file is uploaded");

  const results = $("integrityResults");
  if (results) {
    const rows = v
      ? v.results.map((r) => ({ name: r.originalName, status: r.status, hash: r.checksum }))
      : objects.map((o) => ({ name: o.originalName, status: "not verified", hash: o.checksum }));

    results.innerHTML = rows.length
      ? '<div class="event-list">' +
        rows
          .map(
            (r) =>
              '<div class="result-row"><span>' + escapeHtml(r.name) + '</span><span class="' + tone(r.status) + '">' + escapeHtml(r.status) + "</span><span>" + escapeHtml((r.hash || "").slice(0, 16)) + "…</span></div>"
          )
          .join("") +
        "</div>"
      : '<div class="list-empty">Upload a file to see its checksum here.</div>';
  }

  setTag(
    q("#integrity .section-heading > .state-tag"),
    v ? (v.corrupt ? "CORRUPTION" : v.warnings ? "WARNING" : "VERIFIED") : "NOT RUN",
    v ? (v.corrupt || v.warnings ? "state-error" : "state-real") : "state-empty"
  );
}

/* ---------- Storage rebalancing ---------- */

function setupRebalanceUI() {
  const textBox = q(".rebalance-panel > div");
  if (!textBox || $("rebalanceBtn")) return;

  const wrap = document.createElement("div");
  wrap.innerHTML =
    '<div class="action-row"><button id="rebalanceBtn" class="button button-primary" type="button" disabled>Run rebalancing</button></div>' +
    '<span id="rebalanceMsg" class="action-msg" aria-live="polite"></span>';
  textBox.appendChild(wrap);

  $("rebalanceBtn").addEventListener("click", async () => {
    const msg = $("rebalanceMsg");
    try {
      msg.textContent = "Rebalancing...";
      const r = await api("/api/rebalance/run", "POST");
      const rb = r.rebalance;
      msg.textContent = rb.replicasCopied
        ? "Done: " + rb.replicasCopied + " replica(s) copied (" + formatBytes(rb.bytesMoved) + ")."
        : "Done: data was already evenly distributed.";
      await loadDashboard();
    } catch (err) {
      msg.textContent = "Failed: " + err.message;
    }
  });
}

function renderRebalance(rb) {
  const title = q(".rebalance-panel strong");
  const text = q(".rebalance-panel p");
  const fields = document.querySelectorAll(".rebalance-placeholder b");
  const status = rb.status || "empty";

  const label = status === "balanced" ? "Balanced" : status === "uneven" ? "Uneven" : "No data yet";
  if (title) {
    title.textContent =
      status === "balanced"
        ? "Data is evenly distributed"
        : status === "uneven"
        ? "Data placement is uneven"
        : "No objects to balance yet";
  }
  if (text) {
    text.textContent = (rb.nodes || []).length
      ? rb.nodes
          .map((n) => n.name + ": " + (n.status === "online" ? n.objects + " object(s), " + formatBytes(n.bytes) : "offline"))
          .join(" · ")
      : "Upload a file to see how it is distributed across the nodes.";
  }

  const last = rb.lastRebalance;
  if (fields[0]) fields[0].textContent = label;
  if (fields[1]) fields[1].textContent = last ? fmtTime(last.time) + " (" + last.replicasCopied + " copied)" : "Never";

  setTag(
    q('[aria-labelledby="rebalance-title"] .section-heading > .state-tag'),
    status === "balanced" ? "BALANCED" : status === "uneven" ? "UNEVEN" : "NO DATA",
    status === "balanced" ? "state-real" : status === "uneven" ? "state-error" : "state-empty"
  );
}

/* ---------- Activity logs ---------- */

function renderActivity(events) {
  const box = container(".activity-empty", "activityList");
  if (!box) return;

  box.innerHTML = events.length
    ? '<div class="event-list">' +
      events
        .map(
          (e) =>
            '<div class="event-row"><span>' + escapeHtml(fmtTime(e.time)) + "</span><span>" + escapeHtml(e.type) + '</span><span class="' + tone(e.status) + '">' + escapeHtml(e.status) + "</span><span>" + escapeHtml(e.message) + "</span></div>"
        )
        .join("") +
      "</div>"
    : '<div class="list-empty">No events yet. Upload a file to create the first one.</div>';

  setTag(q("#activity .section-heading > .state-tag"), events.length ? "LIVE" : "NO EVENTS", events.length ? "state-real" : "state-disconnected");
}

/* ---------- Objects table ---------- */

function renderObjects() {
  const list = $("objectList");
  const empty = $("objectEmpty");
  if (!list) return;

  list.querySelectorAll(".data-row").forEach((r) => r.remove());

  const term = ($("objectSearch")?.value || "").trim().toLowerCase();
  const rows = [];

  serverObjects.forEach((o) => {
    rows.push({
      name: o.originalName || o.name || "Unknown",
      size: o.sizeFormatted || formatBytes(o.size || 0),
      modified: fmtTime(o.lastModified),
      status: (o.status || "stored") + " · " + (o.replicas ?? "?") + "/4 copies"
    });
  });

  selectedFiles.forEach((f) => {
    rows.push({
      name: f.name,
      size: formatBytes(f.size),
      modified: f.lastModified ? new Date(f.lastModified).toLocaleString() : "—",
      status: "not uploaded"
    });
  });

  const filtered = rows.filter((r) => r.name.toLowerCase().includes(term));

  filtered.forEach((r) => {
    const row = document.createElement("div");
    row.className = "table-row data-row";
    row.setAttribute("role", "row");
    row.innerHTML =
      "<span>" + escapeHtml(r.name) + "</span>" +
      "<span>" + escapeHtml(r.size) + "</span>" +
      "<span>" + escapeHtml(r.modified) + "</span>" +
      "<span>" + escapeHtml(r.status) + "</span>";
    list.appendChild(row);
  });

  if (empty) empty.style.display = filtered.length ? "none" : "";
}

function setupSearch() {
  const box = $("objectSearch");
  if (box) box.addEventListener("input", renderObjects);
}

/* ---------- Upload ---------- */

function setupUpload() {
  const selectBtn = $("uploadButton");
  const sendBtn = $("sendUploadButton");
  const input = $("fileInput");
  if (!selectBtn || !input) {
    console.warn("Upload elements not found.");
    return;
  }

  selectBtn.addEventListener("click", () => input.click());

  input.addEventListener("change", () => {
    selectedFiles = Array.from(input.files || []);
    setUploadMessage(
      selectedFiles.length
        ? selectedFiles.length + " file(s) selected: " + selectedFiles.map((f) => f.name).join(", ")
        : "No files selected."
    );
    updateSendButton();
    renderObjects();
  });

  if (sendBtn) sendBtn.addEventListener("click", uploadSelectedFiles);
}

function updateSendButton() {
  const sendBtn = $("sendUploadButton");
  if (sendBtn) sendBtn.disabled = !(clusterConnected && selectedFiles.length > 0);
}

function setUploadMessage(msg) {
  const el = $("selectedFileName");
  if (el) el.textContent = msg;
}

async function uploadSelectedFiles() {
  if (!clusterConnected) {
    setUploadMessage("Backend is not connected.");
    return;
  }
  if (!selectedFiles.length) return;

  const sendBtn = $("sendUploadButton");
  if (sendBtn) sendBtn.disabled = true;

  let ok = 0;
  const failed = [];

  for (const file of selectedFiles) {
    if (file.size > MAX_FILE_SIZE) {
      failed.push(file.name + " (over 50 MB)");
      continue;
    }
    try {
      setUploadMessage("Uploading " + file.name + "...");
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(API_BASE_URL + "/api/objects/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || data.message || "HTTP " + res.status);
      }
      ok++;
    } catch (err) {
      console.error("Upload error:", err);
      failed.push(file.name + " (" + err.message + ")");
    }
  }

  setUploadMessage(ok + " uploaded" + (failed.length ? ", failed: " + failed.join("; ") : "."));

  selectedFiles = [];
  const input = $("fileInput");
  if (input) input.value = "";
  updateSendButton();

  await loadDashboard();
}

console.log("DATA MESH frontend script ready.");