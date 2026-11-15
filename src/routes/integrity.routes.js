const express = require('express');
const router = express.Router();
const integrityService = require('../services/integrity.service');
const websocketService = require('../services/websocket.service');
const dashboardService = require('../services/dashboard.service');

router.post('/verify', async (req, res, next) => {
  try {
    const result = await integrityService.verify(true);

    dashboardService.getDashboard().then(data => {
      websocketService.broadcast('dashboard.updated', data);
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/repair', async (req, res, next) => {
  try {
    const result = await integrityService.autoRepair();

    dashboardService.getDashboard().then(data => {
      websocketService.broadcast('dashboard.updated', data);
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

