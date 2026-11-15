const express = require('express');
const http = require('http');
const https = require('https');
const { createHash } = require('crypto');
const { execFile } = require('child_process');
const Minio = require('minio');
const multer = require('multer');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');

const app = express();
const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 3000);
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
const MINIO_PORT = Number(process.env.MINIO_PORT || 9001);
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_NODE_ENDPOINTS = (process.env.MINIO_NODE_ENDPOINTS ||
  'localhost:9001,localhost:9002,localhost:9003,localhost:9004')
  .split(',')
  .map(endpoint => endpoint.trim())
  .filter(Boolean);
const healthHttpClient = MINIO_USE_SSL ? https : http;

app.use(express.json());
app.use(express.static(__dirname));

const minioClient = new Minio.Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: process.env.MINIO_ACCESS_KEY || 'admin',
  secretKey: process.env.MINIO_SECRET_KEY || 'admin12345'
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'data-mesh-bucket';
const dashboardSubscribers = new Set();
const previousNodeStatuses = new Map();
const recoveryEvents = [];
const activityEvents = [];
let lastIntegrityResult = null;
let lastIntegrityFingerprint = null;
let previousClusterHealth = null;
let availabilitySample = null;
let availabilityObservedMs = 0;
let availabilityHealthyMs = 0;
const previousBlockIo = new Map();

function buildDisconnectedDashboard(recoveryNodes = []) {
  const healthyNodeCount = recoveryNodes.filter(node => node.status === 'healthy').length;
  const hasNodeHealth = recoveryNodes.length > 0;

  return {
    connected: false,
    overview: {
      storageCapacity: null,
      availableStorage: null,
      nodeHealth: null,
      replicationHealth: null,
      systemAvailability: null,
      storageThroughput: null
    },
    nodes: [],
    objects: [],
    activity: activityEvents,
    integrity: {
      status: 'unavailable',
      totalObjects: 0,
      checked: 0,
      passed: 0,
      failed: 0,
      unverified: 0,
      detail: 'Integrity verification is unavailable while the storage cluster is disconnected.'
    },
    replication: {
      mode: null,
      healthyNodes: 0,
      totalNodes: MINIO_NODE_ENDPOINTS.length,
      nodes: [],
      detail: 'Replication status is unavailable while the storage cluster is disconnected.'
    },
    recovery: {
      status: hasNodeHealth
        ? healthyNodeCount === recoveryNodes.length ? 'healthy' : 'attention'
        : 'unavailable',
      healthyNodes: healthyNodeCount,
      totalNodes: recoveryNodes.length || MINIO_NODE_ENDPOINTS.length,
      events: recoveryEvents,
      detail: hasNodeHealth
        ? `${healthyNodeCount} of ${recoveryNodes.length} configured storage nodes are reachable. Recovery history records observed node health changes; MinIO healing-job details are not exposed through the S3 API.`
        : 'Node reachability is unavailable. Recovery history records observed node health changes; MinIO healing-job details are not exposed through the S3 API.'
    },
    rebalance: {
      status: 'unavailable',
      healthyNodes: 0,
      totalNodes: MINIO_NODE_ENDPOINTS.length,
      detail: 'Rebalancing status is unavailable while the storage cluster is disconnected.'
    }
  };
}

function broadcastDashboardUpdate(data) {
  const payload = JSON.stringify({ type: 'dashboard.updated', data });

  for (const client of dashboardSubscribers) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function recordActivity(event) {
  activityEvents.unshift({
    ...event,
    time: event.time || new Date().toISOString()
  });
  activityEvents.splice(20);
}

async function ensureBucket() {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
      console.log(`Bucket "${BUCKET_NAME}" created.`);
      return true;
    }

    console.log(`Bucket "${BUCKET_NAME}" already exists.`);
    return true;
  } catch (err) {
    const message = err && err.message ? err.message : String(err || 'Unknown MinIO error');
    console.warn(`MinIO bucket check skipped: ${message}`);
    return false;
  }
}

function normalizeMinioEndpoint(endpoint) {
  const value = String(endpoint || '').trim();
  if (!value) {
    return '';
  }

  if (/^https?:\/\//i.test(value)) {
    return value.replace(/\/$/, '');
  }

  return value.replace(/\/$/, '');
}

function checkMinioHealth(endpoint, path) {
  return new Promise(resolve => {
    const normalizedEndpoint = normalizeMinioEndpoint(endpoint);
    if (!normalizedEndpoint) {
      resolve(false);
      return;
    }

    const url = new URL(`${MINIO_USE_SSL ? 'https' : 'http'}://${normalizedEndpoint}${path}`);
    const request = healthHttpClient.get(url, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });

    request.setTimeout(3000, () => {
      request.destroy(new Error(`Health check timed out for ${normalizedEndpoint}`));
    });
    request.on('error', () => resolve(false));
  });
}

function parseDockerFilesystem(output) {
  const line = output.trim().split(/\r?\n/).pop();
  if (!line) {
    return null;
  }

  const columns = line.trim().split(/\s+/);
  if (columns.length < 6 || !/^\d+$/.test(columns[1])) {
    return null;
  }

  return {
    capacityBytes: Number(columns[1]) * 1024,
    usedBytes: Number(columns[2]) * 1024,
    availableBytes: Number(columns[3]) * 1024,
    usagePercent: columns[4]
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Not reported';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`;
}

function parseDockerByteCount(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
  if (!match) {
    return null;
  }

  const unit = match[2];
  const base = /iB$/i.test(unit) ? 1024 : 1000;
  const exponent = { b: 0, kb: 1, mb: 2, gb: 3, tb: 4, kib: 1, mib: 2, gib: 3, tib: 4 }[unit.toLowerCase()];
  return Number(match[1]) * base ** exponent;
}

function parseDockerIoCounters(value) {
  const [readText, writeText] = String(value || '').split('/');
  const read = parseDockerByteCount(readText || '');
  const written = parseDockerByteCount(writeText || '');
  return read == null || written == null ? null : { read, written };
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return 'Collecting';
  }

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex ? 2 : 0)} ${units[unitIndex]}`;
}

function recordAvailabilitySample(healthy, sampledAt = Date.now()) {
  if (availabilitySample) {
    const elapsed = sampledAt - availabilitySample.sampledAt;
    if (elapsed > 0 && elapsed <= 30000) {
      availabilityObservedMs += elapsed;
      if (availabilitySample.healthy) {
        availabilityHealthyMs += elapsed;
      }
    }
  }

  availabilitySample = { healthy, sampledAt };
  return availabilityObservedMs
    ? `${(availabilityHealthyMs / availabilityObservedMs * 100).toFixed(2)}%`
    : 'Collecting';
}

function getStorageThroughput(statsByService, sampledAt = Date.now()) {
  let bytesPerSecond = 0;
  let sampledNodes = 0;

  for (const [service, stats] of statsByService) {
    const totals = parseDockerIoCounters(stats.disk);
    if (!totals) {
      continue;
    }

    const previous = previousBlockIo.get(service);
    previousBlockIo.set(service, { ...totals, sampledAt });
    if (!previous) {
      continue;
    }

    const elapsed = (sampledAt - previous.sampledAt) / 1000;
    if (elapsed <= 0 || elapsed > 60) {
      continue;
    }

    const bytesRead = Math.max(0, totals.read - previous.read);
    const bytesWritten = Math.max(0, totals.written - previous.written);
    bytesPerSecond += (bytesRead + bytesWritten) / elapsed;
    sampledNodes += 1;
  }

  return sampledNodes ? formatRate(bytesPerSecond) : 'Collecting';
}

async function getDockerNodeStats() {
  const options = {
    cwd: __dirname,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  };
  const { stdout: composeOutput } = await execFileAsync(
    'docker',
    ['compose', 'ps', '--format', 'json'],
    options
  );
  const containers = composeOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(container => container.State === 'running' && /^minio\d+$/.test(container.Service));

  if (!containers.length) {
    return new Map();
  }

  const { stdout: statsOutput } = await execFileAsync(
    'docker',
    ['stats', '--no-stream', '--format', '{{json .}}', ...containers.map(container => container.Name)],
    options
  );
  const statsByName = new Map(
    statsOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const stats = JSON.parse(line);
        return [stats.Name, stats];
      })
  );

  const volumesByName = new Map(await Promise.all(containers.map(async container => {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', container.Name, 'df', '-Pk', '/bitnami/minio/data'],
        options
      );
      return [container.Name, parseDockerFilesystem(stdout)];
    } catch (err) {
      const message = err && err.message ? err.message : String(err || 'Unknown Docker volume error');
      console.warn(`Docker volume metrics unavailable for ${container.Name}:`, message);
      return [container.Name, null];
    }
  })));

  return new Map(containers.map(container => {
    const nodeStats = statsByName.get(container.Name);
    const volumeStats = volumesByName.get(container.Name);
    const publishedPorts = (container.Publishers || [])
      .map(publisher => Number(publisher.PublishedPort))
      .filter(Boolean);

    return [container.Service, {
      publishedPorts,
      cpu: nodeStats ? nodeStats.CPUPerc : null,
      memory: nodeStats ? nodeStats.MemPerc : null,
      disk: nodeStats ? nodeStats.BlockIO : null,
      network: nodeStats ? nodeStats.NetIO : null,
      capacityBytes: volumeStats ? volumeStats.capacityBytes : null,
      usedBytes: volumeStats ? volumeStats.usedBytes : null,
      availableBytes: volumeStats ? volumeStats.availableBytes : null,
      usagePercent: volumeStats ? volumeStats.usagePercent : null
    }];
  }));
}

function getNodeStats(endpoint, statsByService) {
  let url;
  try {
    const value = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
    url = new URL(value);
  } catch {
    return null;
  }

  const serviceMatch = url.hostname.match(/^minio\d+$/i);
  if (serviceMatch) {
    return statsByService.get(url.hostname.toLowerCase()) || null;
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  for (const stats of statsByService.values()) {
    if (stats.publishedPorts.includes(port)) {
      return stats;
    }
  }

  return null;
}

function recordNodeHealthChanges(nodes) {
  for (const node of nodes) {
    const previousStatus = previousNodeStatuses.get(node.name);
    previousNodeStatuses.set(node.name, node.status);

    if (node.status === 'healthy' && (previousStatus === 'healthy' || previousStatus == null)) {
      continue;
    }

    if (node.status !== 'healthy' && previousStatus === node.status) {
      continue;
    }

    const restored = node.status === 'healthy' && previousStatus != null;
    recoveryEvents.unshift({
      time: new Date().toISOString(),
      type: restored ? 'node restored' : 'node unavailable',
      status: restored ? 'ok' : 'warning',
      message: restored
        ? `${node.name} is reachable again`
        : `${node.name} is ${node.status}`
    });
    recordActivity(recoveryEvents[0]);
  }

  recoveryEvents.splice(20);
}

async function getNodeHealth() {
  return Promise.all(MINIO_NODE_ENDPOINTS.map(async endpoint => ({
    name: endpoint,
    status: await checkMinioHealth(endpoint, '/minio/health/live')
      ? 'healthy'
      : 'unavailable'
  })));
}

function listBucketObjects() {
  const objects = [];
  const stream = minioClient.listObjects(BUCKET_NAME, '', true);

  return new Promise((resolve, reject) => {
    stream.on('data', object => {
      objects.push(object);
    });
    stream.on('end', () => resolve(objects));
    stream.on('error', reject);
  });
}

function getObjectFingerprint(objects) {
  const entries = objects
    .map(object => `${object.name}\0${object.size}\0${String(object.lastModified || '')}`)
    .sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

async function hashStoredObject(objectName, algorithm) {
  const stream = await minioClient.getObject(BUCKET_NAME, objectName);
  const hash = createHash(algorithm);

  await new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return hash.digest('hex');
}

async function verifyBucketIntegrity() {
  const objects = await listBucketObjects();
  const fingerprint = getObjectFingerprint(objects);
  const result = {
    status: 'healthy',
    totalObjects: objects.length,
    checked: 0,
    passed: 0,
    failed: 0,
    unverified: 0,
    checkedAt: new Date().toISOString(),
    details: []
  };

  for (const object of objects) {
    try {
      const stat = await minioClient.statObject(BUCKET_NAME, object.name);
      const metadata = stat.metaData || {};
      const expectedSha256 = metadata['x-amz-meta-sha256'] || metadata.sha256;
      const etag = String(stat.etag || '').replaceAll('"', '').toLowerCase();
      const algorithm = expectedSha256 ? 'sha256' : (/^[a-f0-9]{32}$/.test(etag) ? 'md5' : null);
      const expected = expectedSha256 || (algorithm === 'md5' ? etag : null);

      if (!algorithm || !expected) {
        result.unverified += 1;
        result.details.push({ name: object.name, status: 'unverified' });
        continue;
      }

      const actual = await hashStoredObject(object.name, algorithm);
      const passed = actual === expected.toLowerCase();
      result.checked += 1;
      result[passed ? 'passed' : 'failed'] += 1;
      result.details.push({
        name: object.name,
        status: passed ? 'verified' : 'mismatch',
        algorithm,
        checksum: actual
      });
    } catch (error) {
      result.failed += 1;
      result.details.push({
        name: object.name,
        status: 'error',
        message: error.message
      });
    }
  }

  result.status = !result.totalObjects
    ? 'empty'
    : result.failed
      ? 'attention'
      : result.unverified
        ? 'partial'
        : 'healthy';
  result.detail = result.totalObjects
    ? `${result.passed} verified, ${result.failed} failed, ${result.unverified} unverified of ${result.totalObjects} object(s).`
    : 'No objects are available to verify.';
  result.details = result.details.slice(0, 50);
  return { result, fingerprint };
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'data-mesh-api',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/dashboard', async (req, res) => {
  let recoveryNodes = [];

  try {
    recoveryNodes = await getNodeHealth();
    recordNodeHealthChanges(recoveryNodes);

    if (!await ensureBucket()) {
      return res.json(buildDisconnectedDashboard(recoveryNodes));
    }

    await minioClient.listBuckets();
    const storedObjects = await listBucketObjects();
    const objectFingerprint = getObjectFingerprint(storedObjects);
    if (lastIntegrityFingerprint && lastIntegrityFingerprint !== objectFingerprint) {
      lastIntegrityResult = null;
      lastIntegrityFingerprint = null;
    }
    const objects = storedObjects.map(object => ({
      name: object.name,
      size: `${(object.size / 1024).toFixed(2)} KB`,
      sizeBytes: object.size,
      lastModified: object.lastModified,
      status: 'available'
    }));

    let dockerStats = new Map();
    try {
      dockerStats = await getDockerNodeStats();
    } catch (err) {
      const message = err && err.message ? err.message : String(err || 'Unknown Docker stats error');
      console.warn('Docker node metrics unavailable:', message);
    }

    const nodes = await Promise.all(recoveryNodes.map(async node => {
      const stats = getNodeStats(node.name, dockerStats);
      return {
        ...node,
        cpu: stats ? stats.cpu : null,
        memory: stats ? stats.memory : null,
        disk: stats ? stats.disk : null,
        network: stats ? stats.network : null,
        capacityBytes: stats ? stats.capacityBytes : null,
        usedBytes: stats ? stats.usedBytes : null,
        availableBytes: stats ? stats.availableBytes : null,
        usagePercent: stats ? stats.usagePercent : null,
        capacity: stats ? formatBytes(stats.capacityBytes) : null,
        usedCapacity: stats ? formatBytes(stats.usedBytes) : null,
        availableCapacity: stats ? formatBytes(stats.availableBytes) : null
      };
    }));
    const healthyNodeCount = nodes.filter(node => node.status === 'healthy').length;
    const clusterResponding = await checkMinioHealth(
      `${MINIO_ENDPOINT}:${MINIO_PORT}`,
      '/minio/health/cluster'
    );
    const clusterHealthy = clusterResponding && healthyNodeCount === nodes.length;
    const volumeNode = nodes.find(node => Number.isFinite(node.capacityBytes));
    const systemAvailability = recordAvailabilitySample(clusterHealthy);
    const storageThroughput = dockerStats.size
      ? getStorageThroughput(dockerStats)
      : 'Not reported';
    const clusterDetail = 'MinIO health endpoints report node reachability and cluster readiness. The S3 API does not expose per-object shard maps, active healing jobs, or rebalance history.';
    if (previousClusterHealth !== clusterHealthy) {
      recordActivity({
        type: 'cluster health',
        status: clusterHealthy ? 'ok' : 'warning',
        message: `MinIO cluster health: ${healthyNodeCount}/${nodes.length} nodes reachable`
      });
      previousClusterHealth = clusterHealthy;
    }

    const dashboard = {
      connected: true,
      bucket: BUCKET_NAME,
      overview: {
        storageCapacity: volumeNode ? formatBytes(volumeNode.capacityBytes) : 'Not reported',
        availableStorage: volumeNode ? formatBytes(volumeNode.availableBytes) : 'Not reported',
        usedStorage: volumeNode ? formatBytes(volumeNode.usedBytes) : 'Not reported',
        storageUsagePercent: volumeNode ? volumeNode.usagePercent : null,
        storageVolumeNode: volumeNode ? volumeNode.name : null,
        nodeHealth: `${healthyNodeCount} / ${nodes.length}`,
        replicationHealth: clusterHealthy ? 'Healthy' : 'Degraded',
        systemAvailability,
        storageThroughput
      },
      nodes: nodes,
      objects: objects,
      replication: {
        mode: 'MinIO distributed erasure-coded storage',
        healthyNodes: healthyNodeCount,
        totalNodes: nodes.length,
        health: clusterHealthy ? 'healthy' : 'degraded',
        nodes: nodes,
        detail: clusterDetail
      },
      recovery: {
        status: clusterHealthy ? 'healthy' : 'attention',
        healthyNodes: healthyNodeCount,
        totalNodes: nodes.length,
        events: recoveryEvents,
        detail: clusterHealthy
          ? 'No unavailable nodes detected. Recovery history records node health changes observed by this app; MinIO healing-job details are not exposed through its S3 API.'
          : `${nodes.length - healthyNodeCount} storage node(s) are unavailable. Recovery history records node health changes; MinIO repair job details are not exposed through its S3 API.`
      },
      integrity: lastIntegrityResult || {
        status: 'not-checked',
        totalObjects: objects.length,
        checked: 0,
        passed: 0,
        failed: 0,
        unverified: objects.length,
        detail: 'Run an integrity check to verify object contents against their stored checksums.'
      },
      rebalance: {
        status: 'unavailable',
        healthyNodes: healthyNodeCount,
        totalNodes: nodes.length,
        detail: `MinIO manages erasure-coded data placement. ${healthyNodeCount} of ${nodes.length} nodes are reachable. Rebalance progress and history are not exposed through its S3 API.`
      },
      activity: activityEvents
    };

    broadcastDashboardUpdate(dashboard);
    res.json(dashboard);
  } catch (err) {
    const disconnectedDashboard = buildDisconnectedDashboard(recoveryNodes);
    const message = err && err.message ? err.message : String(err || 'Unknown dashboard error');
    console.warn('Dashboard unavailable:', message);
    res.json(disconnectedDashboard);
  }
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/objects/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!await ensureBucket()) {
      return res.status(503).json({ error: 'Storage backend unavailable' });
    }

    const checksum = createHash('sha256').update(req.file.buffer).digest('hex');
    await minioClient.putObject(
      BUCKET_NAME,
      req.file.originalname,
      req.file.buffer,
      req.file.size,
      { 'x-amz-meta-sha256': checksum }
    );
    lastIntegrityResult = null;
    lastIntegrityFingerprint = null;
    recordActivity({
      type: 'object uploaded',
      status: 'ok',
      message: `${req.file.originalname} uploaded (${req.file.size} bytes)`
    });
    res.json({ success: true, name: req.file.originalname, sha256: checksum });
  } catch (err) {
    const message = err && err.message ? err.message : String(err || 'Unknown upload error');
    res.status(500).json({ error: message });
  }
});

app.post('/api/integrity/verify', async (req, res) => {
  try {
    if (!await ensureBucket()) {
      return res.status(503).json({ error: 'Storage backend unavailable' });
    }

    const verification = await verifyBucketIntegrity();
    lastIntegrityResult = verification.result;
    lastIntegrityFingerprint = verification.fingerprint;
    recordActivity({
      type: 'integrity check',
      status: lastIntegrityResult.failed ? 'warning' : 'ok',
      message: lastIntegrityResult.detail
    });
    res.json(lastIntegrityResult);
  } catch (err) {
    const message = err && err.message ? err.message : String(err || 'Unknown integrity check error');
    res.status(500).json({ error: message });
  }
});

const httpServer = http.createServer(app);
const wsServer = new WebSocketServer({ server: httpServer, path: '/ws' });

wsServer.on('connection', socket => {
  dashboardSubscribers.add(socket);

  socket.on('close', () => {
    dashboardSubscribers.delete(socket);
  });
});

wsServer.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. DATA MESH may already be running at http://localhost:${PORT}. ` +
      `To use another port in PowerShell, run: $env:PORT=3001; npm start`
    );
  } else {
    console.error('WebSocket server error:', error);
  }
  process.exitCode = 1;
});

httpServer.listen(PORT, async () => {
  await ensureBucket();
  console.log(`DATA MESH API running on port ${PORT}`);
});