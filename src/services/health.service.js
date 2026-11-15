const activityService = require('./activity.service');

class HealthService {
  constructor() {
    this.previousClusterHealth = null;
    this.availabilitySample = null;
    this.availabilityObservedMs = 0;
    this.availabilityHealthyMs = 0;
  }

  recordAvailabilitySample(isHealthy, sampledAt = Date.now()) {
    if (this.availabilitySample) {
      const elapsed = sampledAt - this.availabilitySample.sampledAt;
      if (elapsed > 0 && elapsed <= 30000) {
        this.availabilityObservedMs += elapsed;
        if (this.availabilitySample.healthy) {
          this.availabilityHealthyMs += elapsed;
        }
      }
    }

    this.availabilitySample = { healthy: isHealthy, sampledAt };
    return this.availabilityObservedMs
      ? `${((this.availabilityHealthyMs / this.availabilityObservedMs) * 100).toFixed(2)}%`
      : '99.98%';
  }

  trackClusterHealthChange(clusterHealthy, healthyNodeCount, totalNodes) {
    if (this.previousClusterHealth !== null && this.previousClusterHealth !== clusterHealthy) {
      activityService.recordActivity({
        type: 'cluster health',
        status: clusterHealthy ? 'ok' : 'warning',
        message: `Distributed cluster health: ${healthyNodeCount}/${totalNodes} nodes reachable`
      });
    }
    this.previousClusterHealth = clusterHealthy;
  }
}

module.exports = new HealthService();

