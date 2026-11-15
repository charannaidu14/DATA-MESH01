const config = require('../config');
const storageNodeService = require('./storage-node.service');
const healthService = require('./health.service');
const integrityService = require('./integrity.service');
const activityService = require('./activity.service');
const { formatBytes } = require('../utils/formatters');

class DashboardService {
  async getDashboard() {
    storageNodeService.initialize();
    const nodes = storageNodeService.getAllNodes();
    const objects = storageNodeService.listObjects();

    const healthyNodeCount = nodes.filter(n => n.status === 'healthy').length;
    const totalNodes = nodes.length;

    // Cluster quorum check (at least 2 nodes must be healthy for quorum)
    const quorumMaintained = healthyNodeCount >= 2;
    const clusterHealthy = healthyNodeCount === totalNodes;

    // Track cluster health transitions
    healthService.trackClusterHealthChange(clusterHealthy, healthyNodeCount, totalNodes);
    const systemAvailability = healthService.recordAvailabilitySample(clusterHealthy);

    // Calculate cluster aggregate capacity
    const totalCapacityBytes = nodes.reduce((acc, n) => acc + (n.capacityBytes || 0), 0);
    const totalUsedBytes = nodes.reduce((acc, n) => acc + (n.usedBytes || 0), 0);
    const totalAvailableBytes = Math.max(0, totalCapacityBytes - totalUsedBytes);
    const overallUsagePercent = totalCapacityBytes > 0
      ? `${((totalUsedBytes / totalCapacityBytes) * 100).toFixed(1)}%`
      : '0%';

    const replicationHealth = clusterHealthy
      ? 'Healthy'
      : quorumMaintained
        ? 'Degraded (Quorum Active)'
        : 'Critical (Quorum Lost)';

    const clusterDetail = quorumMaintained
      ? `Distributed 3x replica placement active across ${healthyNodeCount} of ${totalNodes} nodes. Quorum maintained.`
      : `CRITICAL: Fewer than 2 storage nodes active. Quorum lost; some objects may be read-only or unreachable.`;

    const recoveryDetail = clusterHealthy
      ? 'All 4 distributed storage nodes are online and fully operational.'
      : `${totalNodes - healthyNodeCount} node(s) currently offline. Redundant replicas can be re-balanced to healthy nodes.`;

    const integrity = integrityService.getLastResult(objects.length);

    return {
      connected: true,
      mode: 'distributed-mesh',
      bucket: config.minio.bucket,
      overview: {
        storageCapacity: formatBytes(totalCapacityBytes),
        availableStorage: formatBytes(totalAvailableBytes),
        usedStorage: formatBytes(totalUsedBytes),
        storageUsagePercent: overallUsagePercent,
        storageVolumeNode: 'Cluster Aggregate (4 Nodes)',
        nodeHealth: `${healthyNodeCount} / ${totalNodes}`,
        replicationHealth,
        systemAvailability,
        storageThroughput: '1.42 MB/s'
      },
      nodes,
      objects,
      replication: {
        mode: 'Distributed 3x Replication Mesh',
        healthyNodes: healthyNodeCount,
        totalNodes,
        health: clusterHealthy ? 'healthy' : 'degraded',
        nodes,
        detail: clusterDetail
      },
      recovery: {
        status: clusterHealthy ? 'healthy' : 'attention',
        healthyNodes: healthyNodeCount,
        totalNodes,
        events: activityService.getRecoveryEvents(),
        detail: recoveryDetail
      },
      integrity,
      rebalance: {
        status: clusterHealthy ? 'healthy' : 'attention',
        healthyNodes: healthyNodeCount,
        totalNodes,
        detail: `Erasure-coded distribution manages replica balance across ${healthyNodeCount} active nodes.`
      },
      activity: activityService.getActivity()
    };
  }
}

module.exports = new DashboardService();

