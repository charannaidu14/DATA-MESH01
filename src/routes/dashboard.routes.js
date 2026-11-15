const express = require('express');
const router = express.Router();
const dashboardService = require('../services/dashboard.service');

router.get('/dashboard', async (req, res, next) => {
  try {
    const data = await dashboardService.getDashboard();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

