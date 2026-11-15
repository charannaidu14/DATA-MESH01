const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const activityService = require('./activity.service');
const { formatBytes } = require('../utils/formatters');

class StorageNodeService {
  constructor() {
    this.baseDir = path.resolve(process.cwd(), 'data', 'nodes');
    this.replicationFactor = 3; // 3 replicas per object

    this.nodes = [
      {
        id: 'node-1',
        name: 'Node 1 (Alpha)',
        endpoint: 'localhost:9001',
        port: 9001,
        status: 'healthy',
        capacityBytes: 100 * 1024 * 1024 * 1024, // 100 GB
        usedBytes: 0,
        cpu: '0.4%',
        memory: '1.2%',
        disk: '12.4 MB / 45.8 MB',
        network: '1.8 MB / 920 KB'
      },
      {
        id: 'node-2',
        name: 'Node 2 (Beta)',
        endpoint: 'localhost:9002',
        port: 9002,
        status: 'healthy',
        capacityBytes: 100 * 1024 * 1024 * 1024,
        usedBytes: 0,
        cpu: '0.3%',
        memory: '1.1%',
        disk: '10.1 MB / 38.2 MB',
        network: '1.5 MB / 840 KB'
      },
      {
        id: 'node-3',
        name: 'Node 3 (Gamma)',
        endpoint: 'localhost:9003',
        port: 9003,
        status: 'healthy',
        capacityBytes: 100 * 1024 * 1024 * 1024,
        usedBytes: 0,
        cpu: '0.5%',
        memory: '1.4%',
        disk: '11.8 MB / 42.1 MB',
        network: '1.7 MB / 890 KB'
      },
      {
        id: 'node-4',
        name: 'Node 4 (Delta)',
        endpoint: 'localhost:9004',
        port: 9004,
        status: 'healthy',
        capacityBytes: 100 * 1024 * 1024 * 1024,
        usedBytes: 0,
        cpu: '0.2%',
        memory: '0.9%',
        disk: '8.4 MB / 29.5 MB',
        network: '1.1 MB / 710 KB'
      }
    ];

    this.metadataFile = path.resolve(process.cwd(), 'data', 'metadata.json');
    this.objects = new Map(); // objectName -> metadata
    this.initialized = false;
  }

  ensureDirectories() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    for (const node of this.nodes) {
      const nodeDir = path.join(this.baseDir, node.id);
      if (!fs.existsSync(nodeDir)) {
        fs.mkdirSync(nodeDir, { recursive: true });
      }
    }
  }

  loadMetadata() {
    try {
      if (fs.existsSync(this.metadataFile)) {
        const raw = fs.readFileSync(this.metadataFile, 'utf8');
        const data = JSON.parse(raw);
        for (const item of data) {
          this.objects.set(item.name, item);
        }
      }
    } catch (err) {
      console.warn('[StorageNode] Could not load metadata:', err.message);
    }
  }

  saveMetadata() {
    try {
      const dir = path.dirname(this.metadataFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.objects.values());
      fs.writeFileSync(this.metadataFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[StorageNode] Failed to save metadata:', err.message);
    }
  }

  initialize() {
    if (this.initialized) return;
    this.ensureDirectories();
    this.loadMetadata();
    this.recalculateNodeUsage();
    this.initialized = true;
    console.log(`[StorageNode] Initialized ${this.nodes.length} distributed nodes in ${this.baseDir}`);
  }

  recalculateNodeUsage() {
    for (const node of this.nodes) {
      const nodeDir = path.join(this.baseDir, node.id);
      let totalSize = 0;
      if (fs.existsSync(nodeDir)) {
        const files = fs.readdirSync(nodeDir);
        for (const file of files) {
          try {
            const stat = fs.statSync(path.join(nodeDir, file));
            totalSize += stat.size;
          } catch {}
        }
      }
      node.usedBytes = totalSize;
      node.availableBytes = Math.max(0, node.capacityBytes - totalSize);
      node.usedCapacity = formatBytes(node.usedBytes);
      node.capacity = formatBytes(node.capacityBytes);
      node.availableCapacity = formatBytes(node.availableBytes);
      node.usagePercent = `${((node.usedBytes / node.capacityBytes) * 100).toFixed(1)}%`;
    }
  }

  getHealthyNodes() {
    return this.nodes.filter(n => n.status === 'healthy');
  }

  getNode(nodeId) {
    return this.nodes.find(n => n.id === nodeId || n.name === nodeId || n.endpoint === nodeId);
  }

  getAllNodes() {
    this.recalculateNodeUsage();
    return this.nodes.map(node => {
      // Count replicas on this node
      let replicaCount = 0;
      for (const obj of this.objects.values()) {
        if (obj.replicas && obj.replicas.includes(node.id)) {
          replicaCount++;
        }
      }
      return {
        ...node,
        replicaCount
      };
    });
  }

  toggleNode(nodeId, explicitStatus = null) {
    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const previousStatus = node.status;
    if (explicitStatus) {
      node.status = explicitStatus;
    } else {
      node.status = node.status === 'healthy' ? 'offline' : 'healthy';
    }

    const isRestored = node.status === 'healthy' && previousStatus === 'offline';
    const isDegraded = node.status === 'offline';

    activityService.recordRecovery({
      type: isRestored ? 'node restored' : 'node offline',
      status: isRestored ? 'ok' : 'warning',
      message: isRestored
        ? `${node.name} (${node.endpoint}) is back online and operational`
        : `${node.name} (${node.endpoint}) went offline (fault simulated)`
    });

    return node;
  }

  async storeObject(objectName, buffer) {
    this.initialize();
    const healthyNodes = this.getHealthyNodes();

    if (healthyNodes.length === 0) {
      throw new Error('Storage unavailable: no healthy storage nodes in cluster');
    }

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const md5 = createHash('md5').update(buffer).digest('hex');

    // Pick nodes with least used space among healthy nodes
    const sorted = [...healthyNodes].sort((a, b) => a.usedBytes - b.usedBytes);
    const targetCount = Math.min(this.replicationFactor, sorted.length);
    const targetNodes = sorted.slice(0, targetCount);

    const replicas = [];
    for (const node of targetNodes) {
      const filePath = path.join(this.baseDir, node.id, objectName);
      fs.writeFileSync(filePath, buffer);
      replicas.push(node.id);
    }

    const meta = {
      name: objectName,
      size: `${(buffer.length / 1024).toFixed(2)} KB`,
      sizeBytes: buffer.length,
      sha256,
      md5,
      etag: md5,
      replicas,
      requiredReplicas: this.replicationFactor,
      lastModified: new Date().toISOString(),
      status: 'available'
    };

    this.objects.set(objectName, meta);
    this.saveMetadata();
    this.recalculateNodeUsage();

    activityService.recordActivity({
      type: 'object uploaded',
      status: 'ok',
      message: `${objectName} stored across ${replicas.length} nodes (${replicas.join(', ')})`
    });

    return meta;
  }

  retrieveObject(objectName) {
    this.initialize();
    const meta = this.objects.get(objectName);
    if (!meta) {
      throw new Error(`Object not found: ${objectName}`);
    }

    // Try finding an online node that has this replica
    for (const nodeId of meta.replicas) {
      const node = this.getNode(nodeId);
      if (node && node.status === 'healthy') {
        const filePath = path.join(this.baseDir, nodeId, objectName);
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath);
          return { buffer, metadata: meta, servedBy: node.id };
        }
      }
    }

    throw new Error(`Object unavailable: All nodes holding replicas for "${objectName}" are offline`);
  }

  deleteObject(objectName) {
    this.initialize();
    const meta = this.objects.get(objectName);
    if (!meta) {
      throw new Error(`Object not found: ${objectName}`);
    }

    for (const nodeId of meta.replicas) {
      const filePath = path.join(this.baseDir, nodeId, objectName);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }

    this.objects.delete(objectName);
    this.saveMetadata();
    this.recalculateNodeUsage();

    activityService.recordActivity({
      type: 'object deleted',
      status: 'ok',
      message: `${objectName} removed from cluster`
    });

    return { success: true, name: objectName };
  }

  listObjects() {
    this.initialize();
    return Array.from(this.objects.values()).map(meta => {
      // Check replica availability
      const onlineReplicas = meta.replicas.filter(nodeId => {
        const node = this.getNode(nodeId);
        return node && node.status === 'healthy';
      });

      let status = 'available';
      if (onlineReplicas.length === 0) {
        status = 'offline';
      } else if (onlineReplicas.length < meta.requiredReplicas) {
        status = 'degraded';
      }

      return {
        ...meta,
        onlineReplicasCount: onlineReplicas.length,
        status
      };
    });
  }

  corruptReplica(objectName, targetNodeId = null) {
    this.initialize();
    const meta = this.objects.get(objectName);
    if (!meta) {
      throw new Error(`Object not found: ${objectName}`);
    }

    const nodeId = targetNodeId || meta.replicas[0];
    const filePath = path.join(this.baseDir, nodeId, objectName);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Replica does not exist on node ${nodeId}`);
    }

    // Overwrite the first few bytes with corrupted data
    const content = fs.readFileSync(filePath);
    const corrupted = Buffer.from(content);
    if (corrupted.length > 0) {
      corrupted[0] = (corrupted[0] + 1) % 256;
    }
    fs.writeFileSync(filePath, corrupted);

    activityService.recordActivity({
      type: 'corruption test',
      status: 'warning',
      message: `Injected test corruption into "${objectName}" on ${nodeId}`
    });

    return {
      success: true,
      message: `Replica on ${nodeId} has been corrupted for testing`,
      object: objectName,
      node: nodeId
    };
  }

  repairCluster() {
    this.initialize();
    const healthyNodes = this.getHealthyNodes();
    let repairedReplicas = 0;
    let healedObjects = 0;

    for (const meta of this.objects.values()) {
      let objectNeedsRepair = false;

      // 1. Find a healthy, verified copy of the file
      let validBuffer = null;
      for (const nodeId of meta.replicas) {
        const node = this.getNode(nodeId);
        if (node && node.status === 'healthy') {
          const filePath = path.join(this.baseDir, nodeId, meta.name);
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            const currentHash = createHash('sha256').update(buf).digest('hex');
            if (currentHash === meta.sha256) {
              validBuffer = buf;
              break;
            }
          }
        }
      }

      if (!validBuffer) {
        // Can't repair if no valid copy exists
        continue;
      }

      // 2. Fix corrupted copies on healthy nodes
      for (const nodeId of meta.replicas) {
        const node = this.getNode(nodeId);
        if (node && node.status === 'healthy') {
          const filePath = path.join(this.baseDir, nodeId, meta.name);
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            const currentHash = createHash('sha256').update(buf).digest('hex');
            if (currentHash !== meta.sha256) {
              fs.writeFileSync(filePath, validBuffer);
              repairedReplicas++;
              objectNeedsRepair = true;
            }
          }
        }
      }

      // 3. Add missing replicas on healthy nodes that don't have one
      const nodesWithReplica = new Set(meta.replicas);
      const nodesNeedingReplica = healthyNodes.filter(n => !nodesWithReplica.has(n.id));

      while (meta.replicas.length < this.replicationFactor && nodesNeedingReplica.length > 0) {
        const targetNode = nodesNeedingReplica.shift();
        const filePath = path.join(this.baseDir, targetNode.id, meta.name);
        fs.writeFileSync(filePath, validBuffer);
        meta.replicas.push(targetNode.id);
        repairedReplicas++;
        objectNeedsRepair = true;
      }

      if (objectNeedsRepair) {
        healedObjects++;
      }
    }

    this.saveMetadata();
    this.recalculateNodeUsage();

    activityService.recordActivity({
      type: 'cluster repair',
      status: repairedReplicas > 0 ? 'ok' : 'info',
      message: repairedReplicas > 0
        ? `Auto-healed ${repairedReplicas} replicas across ${healedObjects} objects`
        : 'All replicas verified healthy — no repairs needed'
    });

    return {
      success: true,
      repairedReplicas,
      healedObjects,
      message: repairedReplicas > 0
        ? `Healed ${repairedReplicas} replica(s) across ${healedObjects} object(s)`
        : 'Cluster is healthy — no repairs needed'
    };
  }
}

module.exports = new StorageNodeService();
