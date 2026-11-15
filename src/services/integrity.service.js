const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const storageNodeService = require('./storage-node.service');
const activityService = require('./activity.service');

class IntegrityService {
  constructor() {
    this.lastResult = null;
    this.lastCheckedAt = null;
  }

  invalidateCache() {
    this.lastResult = null;
    this.lastCheckedAt = null;
  }

  getLastResult(totalObjects = 0) {
    if (this.lastResult) {
      return this.lastResult;
    }
    return {
      status: 'not-checked',
      totalObjects,
      checked: 0,
      passed: 0,
      failed: 0,
      unverified: totalObjects,
      detail: 'Run an integrity check to verify object replicas against their SHA-256 checksums.'
    };
  }

  async verify(force = false) {
    storageNodeService.initialize();
    const objects = storageNodeService.listObjects();

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

    if (!objects.length) {
      result.status = 'empty';
      result.detail = 'No objects stored in cluster to verify.';
      this.lastResult = result;
      return result;
    }

    for (const object of objects) {
      let objectCorrupted = false;
      let checkedReplicas = 0;
      let matchingReplicas = 0;
      const replicaReports = [];

      for (const nodeId of object.replicas) {
        const node = storageNodeService.getNode(nodeId);
        if (!node || node.status !== 'healthy') {
          replicaReports.push({ nodeId, status: 'node-offline' });
          continue;
        }

        const filePath = path.join(storageNodeService.baseDir, nodeId, object.name);
        if (!fs.existsSync(filePath)) {
          replicaReports.push({ nodeId, status: 'replica-missing' });
          objectCorrupted = true;
          continue;
        }

        try {
          const buf = fs.readFileSync(filePath);
          const computedHash = createHash('sha256').update(buf).digest('hex');
          checkedReplicas++;

          if (computedHash === object.sha256) {
            matchingReplicas++;
            replicaReports.push({ nodeId, status: 'verified', hash: computedHash });
          } else {
            objectCorrupted = true;
            replicaReports.push({
              nodeId,
              status: 'corrupted',
              expected: object.sha256,
              actual: computedHash
            });
          }
        } catch (err) {
          objectCorrupted = true;
          replicaReports.push({ nodeId, status: 'read-error', message: err.message });
        }
      }

      result.checked++;
      if (objectCorrupted) {
        result.failed++;
        result.details.push({
          name: object.name,
          status: 'mismatch',
          replicas: replicaReports
        });
      } else {
        result.passed++;
        result.details.push({
          name: object.name,
          status: 'verified',
          replicas: replicaReports
        });
      }
    }

    result.status = result.failed
      ? 'attention'
      : result.passed === result.totalObjects
        ? 'healthy'
        : 'partial';

    result.detail = result.failed
      ? `${result.failed} object(s) have corrupted or missing replicas. Click "Auto-Repair" to heal from healthy nodes.`
      : `All ${result.passed} stored object(s) verified successfully. No checksum mismatches detected.`;

    this.lastResult = result;

    activityService.recordActivity({
      type: 'integrity check',
      status: result.failed ? 'warning' : 'ok',
      message: result.detail
    });

    return result;
  }

  async autoRepair() {
    const repairResult = storageNodeService.repairCluster();
    await this.verify(true);
    return repairResult;
  }
}

module.exports = new IntegrityService();

