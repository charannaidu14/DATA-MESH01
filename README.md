# DATA-MESH01
Vault: Build a fault-tolerant distributed object storage system capable of storing, replicating, retrieving, and repairing large volumes of data across unreliable and independently failing storage nodes.  

## Run locally

1. Start Docker Desktop.
2. From this folder, start the MinIO cluster:
   ```powershell
   docker compose up -d
   ```
3. Install dependencies and start the API and website:
   ```powershell
   npm install
   npm start
   ```
4. Open [http://localhost:3000](http://localhost:3000).

The API connects to the local MinIO endpoint on port `9001` by default and checks the four local MinIO nodes. The dashboard refreshes live data every 15 seconds and records node health changes for the current server session. Override `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, or the comma-separated `MINIO_NODE_ENDPOINTS` if your MinIO setup differs. MinIO's S3 API does not expose detailed healing-job, shard-placement, or rebalance history, so those values are identified as unavailable instead of being inferred. Ollama is not required for the storage dashboard.
