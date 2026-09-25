const express = require('express');
const Minio = require('minio');

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

// Connect to MinIO
const minioClient = new Minio.Client({
  endPoint: 'localhost',
  port: 9000,
  useSSL: false,
  accessKey: 'admin',
  secretKey: 'admin12345'
});

const BUCKET_NAME = 'data-mesh-bucket';

// Ensure our bucket exists (creates it once on startup)
async function ensureBucket() {
  const exists = await minioClient.bucketExists(BUCKET_NAME).catch(() => false);
  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
    console.log(`Bucket "${BUCKET_NAME}" created.`);
  } else {
    console.log(`Bucket "${BUCKET_NAME}" already exists.`);
  }
}
ensureBucket().catch(err => console.error('Bucket setup error:', err.message));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'data-mesh-api',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    // Get real bucket list from MinIO
    const buckets = await minioClient.listBuckets();

    // Get real object list from our bucket
    const objects = [];
    const stream = minioClient.listObjects(BUCKET_NAME, '', true);

    await new Promise((resolve, reject) => {
      stream.on('data', obj => {
        objects.push({
          name: obj.name,
          size: `${(obj.size / 1024).toFixed(2)} KB`,
          lastModified: obj.lastModified,
          status: 'available'
        });
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const totalBytes = objects.reduce((sum, o) => sum + parseFloat(o.size), 0);

    res.json({
      connected: true,
      overview: {
        storageCapacity: `${buckets.length} bucket(s)`,
        availableStorage: 'Unlimited (local MinIO)',
        nodeHealth: '1 / 1',
        replicationHealth: 'N/A (single node)',
        systemAvailability: '100%',
        storageThroughput: `${objects.length} object(s)`
      },
      nodes: [
        {
          name: 'minio-local',
          status: 'healthy',
          cpu: 0,
          memory: 0,
          disk: 0
        }
      ],
      objects: objects,
      activity: [
        {
          time: new Date().toISOString(),
          type: 'connection',
          status: 'ok',
          message: 'Connected to MinIO successfully'
        }
      ]
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.json({
      connected: false,
      overview: {
        storageCapacity: null,
        availableStorage: null,
        nodeHealth: null,
        replicationHealth: null,
        systemAvailability: null,
        storageThroughput: null
      },
      nodes: [],
      objects: [],
      activity: []
    });
  }
});

// Upload endpoint (lets you add real files to MinIO)
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/objects/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    await minioClient.putObject(BUCKET_NAME, req.file.originalname, req.file.buffer);
    res.json({ success: true, name: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('DATA MESH API running on port 3000');
});