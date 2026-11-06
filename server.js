const express = require('express');
const http = require('http');
const https = require('https');
const Minio = require('minio');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const app = express();
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

function buildDisconnectedDashboard() {
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
    activity: [],
    replication: {
      mode: null,
      healthyNodes: 0,
      totalNodes: MINIO_NODE_ENDPOINTS.length,
      nodes: [],
      detail: 'Replication status is unavailable while the storage cluster is disconnected.'
    },
    recovery: {
      status: 'unavailable',
      healthyNodes: 0,
      totalNodes: MINIO_NODE_ENDPOINTS.length,
      events: [],
      detail: 'Recovery monitoring is unavailable while the storage cluster is disconnected.'
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
    console.warn(`MinIO bucket check skipped: ${err.message}`);
    return false;
  }
}

function checkMinioHealth(endpoint, path) {
  return new Promise(resolve => {
    const url = new URL(`${MINIO_USE_SSL ? 'https' : 'http'}://${endpoint}${path}`);
    const request = healthHttpClient.get(url, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });

    request.setTimeout(3000, () => {
      request.destroy(new Error(`Health check timed out for ${endpoint}`));
    });
    request.on('error', () => resolve(false));
  });
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
  }

  recoveryEvents.splice(20);
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'data-mesh-api',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    if (!await ensureBucket()) {
      return res.json(buildDisconnectedDashboard());
    }

    await minioClient.listBuckets();
    const objects = [];
    const stream = minioClient.listObjects(BUCKET_NAME, '', true);

    await new Promise((resolve, reject) => {
      stream.on('data', obj => {
        objects.push({
          name: obj.name,
          size: `${(obj.size / 1024).toFixed(2)} KB`,
          lastModified: obj.lastModified,
          status: 'available'
        });
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const nodes = await Promise.all(MINIO_NODE_ENDPOINTS.map(async endpoint => {
      const healthy = await checkMinioHealth(endpoint, '/minio/health/live');
      return {
        name: endpoint,
        status: healthy ? 'healthy' : 'unavailable',
        cpu: null,
        memory: null,
        disk: null
      };
    }));
    recordNodeHealthChanges(nodes);
    const healthyNodeCount = nodes.filter(node => node.status === 'healthy').length;
    const clusterResponding = await checkMinioHealth(
      `${MINIO_ENDPOINT}:${MINIO_PORT}`,
      '/minio/health/cluster'
    );
    const clusterHealthy = clusterResponding && healthyNodeCount === nodes.length;
    const clusterDetail = 'MinIO health endpoints report node reachability and cluster readiness. The S3 API does not expose per-object shard maps, active healing jobs, or rebalance history.';

    const dashboard = {
      connected: true,
      bucket: BUCKET_NAME,
      overview: {
        storageCapacity: 'Not reported',
        availableStorage: 'Not reported',
        nodeHealth: `${healthyNodeCount} / ${nodes.length}`,
        replicationHealth: clusterHealthy ? 'Healthy' : 'Degraded',
        systemAvailability: 'Not reported',
        storageThroughput: 'Not reported'
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
      rebalance: {
        status: clusterHealthy ? 'healthy' : 'attention',
        healthyNodes: healthyNodeCount,
        totalNodes: nodes.length,
        detail: `MinIO manages erasure-coded data placement. ${healthyNodeCount} of ${nodes.length} nodes are reachable. Rebalance progress and history are not exposed through its S3 API.`
      },
      activity: [
        {
          time: new Date().toISOString(),
          type: 'cluster health',
          status: clusterHealthy ? 'ok' : 'warning',
          message: `MinIO cluster health: ${healthyNodeCount}/${nodes.length} nodes reachable`
        }
      ]
    };

    broadcastDashboardUpdate(dashboard);
    res.json(dashboard);
  } catch (err) {
    const disconnectedDashboard = buildDisconnectedDashboard();
    console.warn('Dashboard unavailable:', err.message);
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

    await minioClient.putObject(BUCKET_NAME, req.file.originalname, req.file.buffer);
    res.json({ success: true, name: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

httpServer.listen(PORT, async () => {
  await ensureBucket();
  console.log(`DATA MESH API running on port ${PORT}`);
});