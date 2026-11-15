const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const config = require('../src/config');
const { formatBytes, formatRate } = require('../src/utils/formatters');
const activityService = require('../src/services/activity.service');
const storageNodeService = require('../src/services/storage-node.service');
const integrityService = require('../src/services/integrity.service');
const app = require('../src/app');

describe('DATA MESH Distributed Storage Tests', () => {
  let server;
  const isWindows = process.platform === 'win32';
  const pipePath = isWindows
    ? `\\\\.\\pipe\\data-mesh-test-${Date.now()}`
    : path.join(os.tmpdir(), `data-mesh-test-${Date.now()}.sock`);

  function makeRequest(options, body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: pipePath,
          ...options
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch {}
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: data,
              json
            });
          });
        }
      );

      req.on('error', reject);

      if (body) {
        if (typeof body === 'object') {
          req.setHeader('Content-Type', 'application/json');
          req.write(JSON.stringify(body));
        } else {
          req.write(body);
        }
      }
      req.end();
    });
  }

  before(async () => {
    storageNodeService.initialize();
    await new Promise(resolve => {
      server = http.createServer(app).listen(pipePath, resolve);
    });
  });

  after(() => {
    if (server) {
      server.close();
    }
  });

  describe('Storage Engine & Fault Tolerance', () => {
    test('Cluster initializes with 4 storage nodes', () => {
      const nodes = storageNodeService.getAllNodes();
      assert.strictEqual(nodes.length, 4);
      assert.strictEqual(nodes[0].status, 'healthy');
    });

    test('Store and retrieve replicated object', async () => {
      const testContent = Buffer.from('Vault distributed storage replication test content');
      const testName = `test-object-${Date.now()}.txt`;

      const meta = await storageNodeService.storeObject(testName, testContent);
      assert.strictEqual(meta.name, testName);
      assert.strictEqual(meta.replicas.length, 3); // 3x replication factor

      const retrieved = storageNodeService.retrieveObject(testName);
      assert.strictEqual(retrieved.buffer.toString(), testContent.toString());

      // Clean up
      storageNodeService.deleteObject(testName);
    });

    test('Node failure and recovery simulation', () => {
      const node = storageNodeService.toggleNode('node-2');
      assert.strictEqual(node.status, 'offline');

      const restored = storageNodeService.toggleNode('node-2');
      assert.strictEqual(restored.status, 'healthy');
    });

    test('Data corruption detection and auto-repair', async () => {
      const testContent = Buffer.from('Fault tolerance integrity check payload');
      const testName = `integrity-test-${Date.now()}.txt`;

      await storageNodeService.storeObject(testName, testContent);

      // Corrupt one replica
      const corruptRes = storageNodeService.corruptReplica(testName);
      assert.strictEqual(corruptRes.success, true);

      // Verify that integrity scan detects the corruption
      const scanResult = await integrityService.verify(true);
      assert.strictEqual(scanResult.failed, 1);

      // Trigger auto-repair
      const repairResult = await integrityService.autoRepair();
      assert.strictEqual(repairResult.success, true);
      assert.ok(repairResult.healedObjects >= 1);

      // Verify all replicas are now 100% healthy
      const postScan = await integrityService.verify(true);
      assert.strictEqual(postScan.failed, 0);

      // Clean up
      storageNodeService.deleteObject(testName);
    });
  });

  describe('HTTP API Endpoints', () => {
    test('GET /api/health returns 200 and cluster state', async () => {
      const res = await makeRequest({ path: '/api/health', method: 'GET' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.status, 'ok');
      assert.strictEqual(res.json.cluster.healthyNodes, 4);
    });

    test('GET /api/dashboard returns complete operational telemetry', async () => {
      const res = await makeRequest({ path: '/api/dashboard', method: 'GET' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.connected, true);
      assert.ok(res.json.overview);
      assert.strictEqual(res.json.nodes.length, 4);
      assert.ok(Array.isArray(res.json.objects));
      assert.ok(res.json.replication);
      assert.ok(res.json.recovery);
      assert.ok(res.json.integrity);
    });

    test('GET /api/nodes returns 4 nodes', async () => {
      const res = await makeRequest({ path: '/api/nodes', method: 'GET' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.length, 4);
    });

    test('POST /api/nodes/:id/toggle toggles node status', async () => {
      const res = await makeRequest({ path: '/api/nodes/node-1/toggle', method: 'POST' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.node.status, 'offline');

      // Restore it
      const restoreRes = await makeRequest({ path: '/api/nodes/node-1/toggle', method: 'POST' });
      assert.strictEqual(restoreRes.status, 200);
      assert.strictEqual(restoreRes.json.node.status, 'healthy');
    });

    test('POST /api/integrity/verify returns verification report', async () => {
      const res = await makeRequest({ path: '/api/integrity/verify', method: 'POST' });
      assert.strictEqual(res.status, 200);
      assert.ok('status' in res.json);
      assert.ok('checked' in res.json);
    });

    test('POST /api/objects/upload without file returns 400', async () => {
      const res = await makeRequest({ path: '/api/objects/upload', method: 'POST' }, {});
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json.error, 'No file uploaded');
    });

    test('GET / serves index.html frontend', async () => {
      const res = await makeRequest({ path: '/', method: 'GET' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.includes('DATA MESH'));
      assert.ok(res.text.includes('app.js'));
    });

    test('GET /style.css serves stylesheet', async () => {
      const res = await makeRequest({ path: '/style.css', method: 'GET' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.length > 100);
    });

    test('GET /app.js serves frontend script', async () => {
      const res = await makeRequest({ path: '/app.js', method: 'GET' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.includes('DATA MESH frontend loaded'));
    });
  });
});

