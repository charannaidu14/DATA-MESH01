# DATA-MESH01

Vault: Fault-tolerant distributed object storage operations system capable of storing, replicating, retrieving, and repairing large volumes of data across distributed storage nodes.

---

## Architecture Overview

The backend has been completely redesigned into a clean, modular, production-ready architecture:

```
DATA-MESH01/
├── src/
│   ├── config/
│   │   └── index.js             # Validated configuration & zero-dependency .env loader
│   ├── utils/
│   │   └── formatters.js        # Formatting utilities (bytes, rates, Docker telemetry parsers)
│   ├── services/
│   │   ├── activity.service.js  # Circular in-memory audit trail for recovery & activities
│   │   ├── minio.service.js     # MinIO client connection, bucket lifecycle & S3 operations
│   │   ├── health.service.js    # Node & cluster health check probes with state change tracking
│   │   ├── docker.service.js    # Safe, non-blocking Docker container statistics & disk I/O
│   │   ├── integrity.service.js # Streaming SHA-256 and MD5 / ETag checksum verification
│   │   ├── websocket.service.js # Real-time WebSocket (/ws) connection manager & broadcast
│   │   └── dashboard.service.js # Unified dashboard aggregator (connected & disconnected states)
│   ├── routes/
│   │   ├── health.routes.js     # GET /api/health
│   │   ├── dashboard.routes.js  # GET /api/dashboard
│   │   ├── objects.routes.js    # POST /api/objects/upload, GET /api/objects, download & delete
│   │   └── integrity.routes.js  # POST /api/integrity/verify
│   ├── middleware/
│   │   └── errorHandler.js      # Centralized error handler
│   ├── app.js                   # Express application & static file server
│   └── server.js                # HTTP & WebSocket server startup with graceful shutdown
├── test/
│   └── backend.test.js          # Automated unit & integration tests using Node's native test runner
├── Dockerfile                   # Multi-stage production container build with health checks
├── docker-compose.yml           # Complete distributed stack: 4 MinIO cluster nodes + app
├── .dockerignore                # Production container exclusions
├── .env.example                 # Environment configuration template
├── app.js                       # Frontend client script
├── index.html                   # Storage Operations Dashboard UI
└── style.css                    # Dashboard stylesheet
```

---

## Getting Started

### 1. Run Locally with Node.js

Prerequisites: Node.js 18+ (tested with Node 20 & 26).

1. Start the distributed MinIO nodes (or run in disconnected mode without Docker):
   ```powershell
   docker compose up -d minio1 minio2 minio3 minio4
   ```

2. Install dependencies (if not already installed):
   ```powershell
   npm install
   ```

3. Run the test suite:
   ```powershell
   npm test
   ```

4. Start the server:
   ```powershell
   npm start
   ```
   Or run directly:
   ```powershell
   node src/server.js
   ```

5. Open your browser at [http://localhost:3000](http://localhost:3000).

To run on a different port:
```powershell
$env:PORT=3001; npm start
```

---

### 2. Full-Stack Deployment with Docker

To spin up the entire distributed cluster **and** the web application in containers:

```bash
docker compose up -d --build
```

The application will be accessible at [http://localhost:3000](http://localhost:3000) and automatically connected to the 4 MinIO nodes (`minio1`, `minio2`, `minio3`, `minio4`) over the internal Docker network.

---

### 3. Deploy to Cloud (Docker / PaaS / Kubernetes)

Build and deploy the container image:

```bash
docker build -t data-mesh:latest .
docker run -p 3000:3000 -e MINIO_ENDPOINT=your-minio-host -e MINIO_PORT=9000 data-mesh:latest
```

The container includes:
- Non-root user execution (`node`)
- Built-in container health check hitting `/api/health`
- Multi-stage minimal footprint build

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP and WebSocket server port |
| `HOST` | `0.0.0.0` | Host binding interface |
| `NODE_ENV` | `development` | Runtime environment (`development`, `production`, `test`) |
| `MINIO_ENDPOINT` | `localhost` | MinIO cluster S3 host |
| `MINIO_PORT` | `9001` | MinIO cluster S3 port |
| `MINIO_USE_SSL` | `false` | Use HTTPS for MinIO communication |
| `MINIO_ACCESS_KEY` | `admin` | MinIO root access key |
| `MINIO_SECRET_KEY` | `admin12345` | MinIO root secret key |
| `MINIO_BUCKET` | `data-mesh-bucket` | Default storage bucket |
| `MINIO_NODE_ENDPOINTS` | `localhost:9001,localhost:9002,...` | Comma-separated endpoints for health checks |
| `ENABLE_DOCKER_STATS` | `true` | Enable Docker container metrics collection when available |
| `POLL_INTERVAL_MS` | `15000` | Background cluster telemetry poll interval |

---

## API Endpoints

- `GET /api/health`: Returns API liveness and MinIO connection state.
- `GET /api/dashboard`: Aggregated dashboard metrics, node statuses, objects list, and replication topology.
- `POST /api/objects/upload`: Upload file with multipart form-data (computes SHA-256 metadata hash).
- `GET /api/objects`: List stored objects.
- `GET /api/objects/download/:name`: Stream and download stored object.
- `DELETE /api/objects/:name`: Delete object from bucket.
- `POST /api/integrity/verify`: Run streaming SHA-256 / MD5 verification on stored objects.
- `WS /ws`: Real-time WebSocket connection for live telemetry updates.
