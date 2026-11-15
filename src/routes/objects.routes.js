const express = require('express');
const router = express.Router();
const multer = require('multer');
const storageNodeService = require('../services/storage-node.service');
const integrityService = require('../services/integrity.service');
const websocketService = require('../services/websocket.service');
const dashboardService = require('../services/dashboard.service');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const meta = await storageNodeService.storeObject(
      req.file.originalname,
      req.file.buffer
    );

    integrityService.invalidateCache();

    dashboardService.getDashboard().then(data => {
      websocketService.broadcast('dashboard.updated', data);
    }).catch(() => {});

    res.json({
      success: true,
      name: meta.name,
      sha256: meta.sha256,
      replicas: meta.replicas
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res) => {
  const objects = storageNodeService.listObjects();
  res.json(objects);
});

router.get('/:name/download', (req, res, next) => {
  try {
    const objectName = req.params.name;
    const { buffer, metadata, servedBy } = storageNodeService.retrieveObject(objectName);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(objectName)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Served-By-Node', servedBy);

    res.send(buffer);
  } catch (err) {
    res.status(err.message.includes('unavailable') ? 503 : 404).json({ error: err.message });
  }
});

router.delete('/:name', async (req, res, next) => {
  try {
    const objectName = req.params.name;
    const result = storageNodeService.deleteObject(objectName);
    integrityService.invalidateCache();

    dashboardService.getDashboard().then(data => {
      websocketService.broadcast('dashboard.updated', data);
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:name/corrupt', async (req, res, next) => {
  try {
    const objectName = req.params.name;
    const nodeId = req.body?.nodeId;
    const result = storageNodeService.corruptReplica(objectName, nodeId);
    integrityService.invalidateCache();

    dashboardService.getDashboard().then(data => {
      websocketService.broadcast('dashboard.updated', data);
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

