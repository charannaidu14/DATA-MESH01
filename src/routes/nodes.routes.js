const express = require('express');
const router = express.Router();
const storageNodeService = require('../services/storage-node.service');
const dashboardService = require('../services/dashboard.service');
const websocketService = require('../services/websocket.service');

router.get('/', (req, res) => {
  const nodes = storageNodeService.getAllNodes();
  res.json(nodes);
});

router.post('/:id/toggle', async (req, res, next) => {
  try {
    const node = storageNodeService.toggleNode(req.params.id);

    // Broadcast updated cluster state to all connected UI clients
    dashboardService.getDashboard().then(data => {
      websocketService.broadcast('dashboard.updated', data);
    }).catch(() => {});

    res.json({
      success: true,
      node
    });
  } catch (err) {
    next(err);
  }
});

router.post('/repair', async (req, res, next) => {
  try {
    const result = storageNodeService.repairCluster();

    dashboardService.getDashboard().then(data => {
      websocketService.broadcast('dashboard.updated', data);
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

