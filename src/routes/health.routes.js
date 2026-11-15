const express = require('express');
const router = express.Router();
const storageNodeService = require('../services/storage-node.service');

router.get('/health', (req, res) => {
  storageNodeService.initialize();
  const healthyNodes = storageNodeService.getHealthyNodes();
  res.json({
    status: 'ok',
    service: 'data-mesh-api',
    cluster: {
      mode: 'distributed-mesh',
      healthyNodes: healthyNodes.length,
      totalNodes: storageNodeService.nodes.length,
      quorum: healthyNodes.length >= 2
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;

