const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}

loadEnv();

const config = {
  server: {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development'
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: Number(process.env.MINIO_PORT || 9001),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'admin',
    secretKey: process.env.MINIO_SECRET_KEY || 'admin12345',
    bucket: process.env.MINIO_BUCKET || 'data-mesh-bucket',
    nodeEndpoints: (process.env.MINIO_NODE_ENDPOINTS || 'localhost:9001,localhost:9002,localhost:9003,localhost:9004')
      .split(',')
      .map(e => e.trim())
      .filter(Boolean)
  },
  monitoring: {
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
    healthCheckTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS || 3000)
  }
};

module.exports = config;

