require("dotenv").config();

const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const fsp = require("fs/promises");

const app = express();

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 50);
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const NODE_ENV = process.env.NODE_ENV || "development";

const STORAGE_DIR = path.join(__dirname, "storage");
const FRONTEND_DIR = path.join(__dirname, "frontend");
const META_FILE = path.join(STORAGE_DIR, "_meta.json");

// One primary + three replicas. Every object is copied to all four.
const NODE_NAMES = ["node-1", "node-2", "node-3", "node-4"];
const nodeDir = (name) => path.join(STORAGE_DIR, name);

const startedAt = Date.now();
let bytesWritten = 0;
let storageReady = false;

let meta = {
  objects: {},        // storedName -> { originalName, size, sha256, uploadedAt }
  activity: [],       // newest first
  failed: [],         // nodes currently offline (simulated)
  lastVerification: null,
  lastRecovery: null,
  lastRebalance: null
};

// =====================================================
// EXPRESS SECURITY
// =====================================================

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(express.json({ limit: "1mb" }));

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      success: false,
      error: "Too many requests. Please try again later."
    }
  })
);

// =====================================================
// SERVE FRONTEND (frontend/index.html, script.js, style.css)
// =====================================================

app.use(express.static(FRONTEND_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// =====================================================
// HELPERS
// =====================================================

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + " " + units[i];
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

const sha256 = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

function cleanFileName(name) {
  const base = path.basename(String(name || "file"));
  const cleaned = base.replace(/[^\w.\- ()]/g, "_").slice(0, 150);
  return cleaned || "file";
}

function safeObjectName(name) {
  try {
    const decoded = decodeURIComponent(name);
    const base = path.basename(decoded);
    if (base !== decoded || base.includes("..") || base.includes("/") || base.includes("\\")) {
      return null;
    }
    return base;
  } catch {
    return null;
  }
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

// =====================================================
// METADATA + ACTIVITY LOG
// =====================================================

async function saveMeta() {
  await fsp.writeFile(META_FILE, JSON.stringify(meta, null, 2));
}

async function logEvent(type, status, message) {
  meta.activity.unshift({
    time: new Date().toISOString(),
    type,
    status,
    message
  });
  meta.activity = meta.activity.slice(0, 200);
  await saveMeta();
}

async function ensureStorage() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  for (const name of NODE_NAMES) {
    await fsp.mkdir(nodeDir(name), { recursive: true });
  }

  if (storageReady) return;

  // Load saved metadata
  const raw = await readIfExists(META_FILE);
  if (raw) {
    try {
      meta = { ...meta, ...JSON.parse(raw.toString("utf8")) };
    } catch (err) {
      console.error("Could not read _meta.json, starting fresh:", err.message);
    }
  }

  // Move files from the old single-folder layout into the 4 nodes
  const entries = await fsp.readdir(STORAGE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === "_meta.json") continue;

    const oldPath = path.join(STORAGE_DIR, entry.name);
    const buffer = await fsp.readFile(oldPath);
    const stats = await fsp.stat(oldPath);

    for (const name of NODE_NAMES) {
      await fsp.writeFile(path.join(nodeDir(name), entry.name), buffer);
    }

    meta.objects[entry.name] = {
      originalName: entry.name.replace(/^\d{10,}-/, ""),
      size: buffer.length,
      sha256: sha256(buffer),
      uploadedAt: stats.mtime.toISOString()
    };

    await fsp.unlink(oldPath);
    await logEvent("migration", "ok", `Imported ${meta.objects[entry.name].originalName} into all nodes`);
  }

  await saveMeta();
  storageReady = true;
}

// =====================================================
// OBJECTS
// =====================================================

async function replicaPresence(storedName) {
  const present = [];
  for (const name of NODE_NAMES) {
    if (await exists(path.join(nodeDir(name), storedName))) present.push(name);
  }
  return present;
}

async function getStoredObjects() {
  await ensureStorage();
  const objects = [];

  for (const [storedName, info] of Object.entries(meta.objects)) {
    const presentOn = await replicaPresence(storedName);
    const status =
      presentOn.length === NODE_NAMES.length
        ? "available"
        : presentOn.length > 0
        ? "degraded"
        : "lost";

    objects.push({
      name: storedName,
      originalName: info.originalName,
      size: info.size,
      sizeFormatted: formatBytes(info.size),
      lastModified: info.uploadedAt,
      status,
      replicas: presentOn.length,
      presentOn,
      checksum: info.sha256
    });
  }

  objects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  return objects;
}

async function saveObject(buffer, originalName) {
  const targets = NODE_NAMES.filter((n) => !meta.failed.includes(n));
  if (targets.length === 0) throw new Error("No online nodes available.");

  const original = cleanFileName(originalName);
  const storedName = `${Date.now()}-${original}`;

  for (const name of targets) {
    await fsp.writeFile(path.join(nodeDir(name), storedName), buffer);
  }

  meta.objects[storedName] = {
    originalName: original,
    size: buffer.length,
    sha256: sha256(buffer),
    uploadedAt: new Date().toISOString()
  };

  bytesWritten += buffer.length * targets.length;

  await logEvent(
    "upload",
    targets.length === NODE_NAMES.length ? "ok" : "warning",
    `Uploaded ${original} (${formatBytes(buffer.length)}) to ${targets.length}/${NODE_NAMES.length} nodes`
  );

  return { storedName, original, size: buffer.length };
}

// =====================================================
// DASHBOARD DATA
// =====================================================

async function diskInfo() {
  try {
    const s = await fsp.statfs(STORAGE_DIR);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, usedPercent: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch {
    return { total: 0, free: 0, usedPercent: 0 };
  }
}

async function buildDashboard() {
  const objects = await getStoredObjects();
  const disk = await diskInfo();

  const onlineNodes = NODE_NAMES.filter((n) => !meta.failed.includes(n));
  const fullyReplicated = objects.filter((o) => o.replicas === NODE_NAMES.length).length;
  const degraded = objects.filter((o) => o.replicas < NODE_NAMES.length).length;
  const physicalBytes = objects.reduce((sum, o) => sum + o.size * o.replicas, 0);

  const nodes = NODE_NAMES.map((name, i) => {
    const stored = objects.filter((o) => o.presentOn.includes(name));
    return {
      name,
      role: i === 0 ? "primary" : `replica ${i}`,
      status: meta.failed.includes(name) ? "offline" : "online",
      objects: stored.length,
      bytes: stored.reduce((sum, o) => sum + o.size, 0)
    };
  });

  const memUsed = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

  return {
    connected: true,

    overview: {
      storageCapacity: `${disk.usedPercent}% used`,
      diskUsedPercent: disk.usedPercent,
      diskTotal: formatBytes(disk.total),
      availableStorage: formatBytes(disk.free),
      nodeHealth: `${onlineNodes.length}/${NODE_NAMES.length} online`,
      replicationHealth: objects.length
        ? `${fullyReplicated}/${objects.length} replicated`
        : "No objects yet",
      systemAvailability: formatUptime((Date.now() - startedAt) / 1000),
      storageThroughput: `${formatBytes(bytesWritten)} written`,
      bucketCount: 1,
      objectCount: objects.length,
      totalStorageUsed: formatBytes(physicalBytes),
      memoryUsed: `${memUsed}%`
    },

    nodes,

    replication: {
      factor: NODE_NAMES.length,
      fullyReplicated,
      totalObjects: objects.length
    },

    recovery: {
      failedNodes: meta.failed,
      degradedObjects: degraded,
      sourceAvailable: objects.some((o) => o.replicas > 0),
      lastRecovery: meta.lastRecovery,
      history: meta.activity
        .filter((e) => e.type === "failure" || e.type === "recovery")
        .slice(0, 15)
    },

    integrity: {
      totalObjects: objects.length,
      lastVerification: meta.lastVerification
    },

    rebalance: (() => {
      const online = nodes.filter((n) => n.status === "online");
      const bytes = online.map((n) => n.bytes);
      const spread = bytes.length ? Math.max(...bytes) - Math.min(...bytes) : 0;
      const status =
        objects.length === 0
          ? "empty"
          : online.length < nodes.length || spread > 0
          ? "uneven"
          : "balanced";
      return {
        status,
        spreadBytes: spread,
        nodes: nodes.map((n) => ({ name: n.name, status: n.status, objects: n.objects, bytes: n.bytes })),
        lastRebalance: meta.lastRebalance
      };
    })(),

    objects,
    activity: meta.activity.slice(0, 50)
  };
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", async (req, res) => {
  try {
    await ensureStorage();

    res.status(200).json({
      status: "ok",
      service: "data-mesh-api",
      storage: "connected",
      storageType: "local-development",
      environment: NODE_ENV,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Health error:", error);

    res.status(503).json({
      status: "error",
      service: "data-mesh-api",
      storage: "disconnected",
      environment: NODE_ENV,
      timestamp: new Date().toISOString()
    });
  }
});

// =====================================================
// DASHBOARD + OBJECT LIST
// =====================================================

app.get("/api/dashboard", async (req, res) => {
  try {
    res.status(200).json(await buildDashboard());
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(503).json({ connected: false, error: "Storage is currently unavailable." });
  }
});

app.get("/api/objects", async (req, res) => {
  try {
    const objects = await getStoredObjects();
    res.status(200).json({ success: true, count: objects.length, objects });
  } catch (error) {
    console.error("Object listing error:", error);
    res.status(500).json({ success: false, error: "Unable to list objects." });
  }
});

// =====================================================
// UPLOAD (copied to every online node)
// =====================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

app.post("/api/objects/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded." });
    }

    await ensureStorage();
    const saved = await saveObject(req.file.buffer, req.file.originalname);

    console.log(`File uploaded: ${saved.storedName} (${formatBytes(saved.size)})`);

    res.status(201).json({
      success: true,
      message: "File uploaded successfully.",
      object: {
        name: saved.storedName,
        originalName: saved.original,
        size: saved.size,
        sizeFormatted: formatBytes(saved.size),
        status: "available"
      }
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ success: false, error: "Unable to upload file." });
  }
});

// =====================================================
// DOWNLOAD
// =====================================================

app.get("/api/objects/:name", async (req, res) => {
  try {
    const safeName = safeObjectName(req.params.name);
    const info = safeName && meta.objects[safeName];

    if (!info) {
      return res.status(404).json({ success: false, error: "Object not found." });
    }

    for (const name of NODE_NAMES) {
      const file = path.join(nodeDir(name), safeName);
      if (await exists(file)) {
        return res.download(file, info.originalName);
      }
    }

    res.status(404).json({ success: false, error: "No replica of this object is available." });
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({ success: false, error: "Unable to download object." });
  }
});

// =====================================================
// DELETE (from every node)
// =====================================================

app.delete("/api/objects/:name", async (req, res) => {
  try {
    const safeName = safeObjectName(req.params.name);
    const info = safeName && meta.objects[safeName];

    if (!info) {
      return res.status(404).json({ success: false, error: "Object not found." });
    }

    for (const name of NODE_NAMES) {
      await fsp.unlink(path.join(nodeDir(name), safeName)).catch(() => {});
    }

    delete meta.objects[safeName];
    await logEvent("delete", "ok", `Deleted ${info.originalName} from all nodes`);

    res.status(200).json({ success: true, message: "Object deleted successfully." });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ success: false, error: "Unable to delete object." });
  }
});

// =====================================================
// DATA INTEGRITY: verify every copy against its SHA-256
// =====================================================

app.post("/api/integrity/verify", async (req, res) => {
  try {
    await ensureStorage();
    const results = [];

    for (const [storedName, info] of Object.entries(meta.objects)) {
      const nodes = [];

      for (const name of NODE_NAMES) {
        if (meta.failed.includes(name)) {
          nodes.push({ node: name, status: "offline" });
          continue;
        }
        const buffer = await readIfExists(path.join(nodeDir(name), storedName));
        if (!buffer) nodes.push({ node: name, status: "missing" });
        else nodes.push({ node: name, status: sha256(buffer) === info.sha256 ? "ok" : "corrupt" });
      }

      const status = nodes.some((n) => n.status === "corrupt")
        ? "corrupt"
        : nodes.some((n) => n.status === "missing")
        ? "warning"
        : "verified";

      results.push({
        name: storedName,
        originalName: info.originalName,
        checksum: info.sha256,
        status,
        nodes
      });
    }

    meta.lastVerification = {
      time: new Date().toISOString(),
      algorithm: "SHA-256",
      checked: results.length,
      verified: results.filter((r) => r.status === "verified").length,
      warnings: results.filter((r) => r.status === "warning").length,
      corrupt: results.filter((r) => r.status === "corrupt").length,
      results
    };

    const v = meta.lastVerification;
    await logEvent(
      "integrity",
      v.corrupt ? "error" : v.warnings ? "warning" : "ok",
      `Verified ${v.checked} object(s): ${v.verified} ok, ${v.warnings} warning(s), ${v.corrupt} corrupt`
    );

    res.status(200).json({ success: true, verification: v });
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ success: false, error: "Verification failed." });
  }
});

// =====================================================
// RECOVERY: simulate a node failure, then rebuild
// =====================================================

app.post("/api/recovery/simulate-failure", async (req, res) => {
  try {
    await ensureStorage();
    const node = (req.body && req.body.node) || "node-2";

    if (!NODE_NAMES.includes(node)) {
      return res.status(400).json({ success: false, error: "Unknown node." });
    }
    if (meta.failed.includes(node)) {
      return res.status(400).json({ success: false, error: `${node} is already offline.` });
    }
    if (NODE_NAMES.length - meta.failed.length <= 1) {
      return res.status(400).json({ success: false, error: "At least one node must stay online." });
    }

    const files = await fsp.readdir(nodeDir(node));
    for (const file of files) {
      await fsp.unlink(path.join(nodeDir(node), file)).catch(() => {});
    }

    meta.failed.push(node);
    await logEvent("failure", "error", `Simulated failure: ${node} went offline and lost ${files.length} replica(s)`);

    res.status(200).json({ success: true, node, replicasLost: files.length });
  } catch (error) {
    console.error("Simulate failure error:", error);
    res.status(500).json({ success: false, error: "Could not simulate failure." });
  }
});

app.post("/api/recovery/run", async (req, res) => {
  try {
    await ensureStorage();

    const failedBefore = [...meta.failed];
    await logEvent("recovery", "started", "Recovery started: rebuilding missing or corrupt replicas");

    meta.failed = []; // failed nodes are brought back online

    let degradedObjects = 0;
    let replicasRestored = 0;
    let unrecoverable = 0;

    for (const [storedName, info] of Object.entries(meta.objects)) {
      // Find a healthy copy to use as the repair source
      let source = null;
      for (const name of NODE_NAMES) {
        const buffer = await readIfExists(path.join(nodeDir(name), storedName));
        if (buffer && sha256(buffer) === info.sha256) {
          source = buffer;
          break;
        }
      }

      if (!source) {
        unrecoverable++;
        continue;
      }

      let needed = false;
      for (const name of NODE_NAMES) {
        const file = path.join(nodeDir(name), storedName);
        const current = await readIfExists(file);
        if (!current || sha256(current) !== info.sha256) {
          await fsp.writeFile(file, source);
          replicasRestored++;
          needed = true;
        }
      }
      if (needed) degradedObjects++;
    }

    meta.lastRecovery = {
      time: new Date().toISOString(),
      failedNodes: failedBefore,
      degradedObjects,
      replicasRestored,
      unrecoverable
    };

    await logEvent(
      "recovery",
      unrecoverable ? "warning" : "ok",
      `Recovery finished: ${replicasRestored} replica(s) restored across ${degradedObjects} object(s)` +
        (unrecoverable ? `, ${unrecoverable} object(s) unrecoverable` : "")
    );

    res.status(200).json({ success: true, recovery: meta.lastRecovery });
  } catch (error) {
    console.error("Recovery error:", error);
    res.status(500).json({ success: false, error: "Recovery failed." });
  }
});

// =====================================================
// REBALANCING: make sure every online node holds every object
// =====================================================

app.post("/api/rebalance/run", async (req, res) => {
  try {
    await ensureStorage();

    if (meta.failed.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Some nodes are offline. Run recovery first."
      });
    }

    await logEvent("rebalance", "started", "Rebalancing started: checking data placement on all nodes");

    let replicasCopied = 0;
    let objectsMoved = 0;
    let bytesMoved = 0;

    for (const [storedName, info] of Object.entries(meta.objects)) {
      let source = null;
      for (const name of NODE_NAMES) {
        const buffer = await readIfExists(path.join(nodeDir(name), storedName));
        if (buffer && sha256(buffer) === info.sha256) {
          source = buffer;
          break;
        }
      }
      if (!source) continue;

      let moved = false;
      for (const name of NODE_NAMES) {
        const file = path.join(nodeDir(name), storedName);
        if (!(await exists(file))) {
          await fsp.writeFile(file, source);
          replicasCopied++;
          bytesMoved += source.length;
          moved = true;
        }
      }
      if (moved) objectsMoved++;
    }

    meta.lastRebalance = {
      time: new Date().toISOString(),
      replicasCopied,
      objectsMoved,
      bytesMoved
    };

    await logEvent(
      "rebalance",
      "ok",
      replicasCopied
        ? `Rebalancing finished: ${replicasCopied} replica(s) copied (${formatBytes(bytesMoved)})`
        : "Rebalancing finished: data was already evenly distributed"
    );

    res.status(200).json({ success: true, rebalance: meta.lastRebalance });
  } catch (error) {
    console.error("Rebalance error:", error);
    res.status(500).json({ success: false, error: "Rebalancing failed." });
  }
});

// =====================================================
// ACTIVITY LOG
// =====================================================

app.get("/api/activity", async (req, res) => {
  await ensureStorage();
  res.status(200).json({ success: true, events: meta.activity.slice(0, 100) });
});

// =====================================================
// ERROR HANDLERS
// =====================================================

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: `File is too large. Maximum size is ${MAX_FILE_SIZE_MB} MB.`
      });
    }
    return res.status(400).json({ success: false, error: error.message });
  }
  next(error);
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  res.status(500).json({ success: false, error: "Internal server error." });
});

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  try {
    await ensureStorage();

    app.listen(PORT, "0.0.0.0", () => {
      console.log("");
      console.log("========================================");
      console.log("          DATA MESH API");
      console.log("========================================");
      console.log(`API: http://localhost:${PORT}`);
      console.log(`Frontend: ${FRONTEND_DIR}`);
      console.log(`Storage: ${STORAGE_DIR}`);
      console.log(`Nodes: ${NODE_NAMES.join(", ")}`);
      console.log(`Environment: ${NODE_ENV}`);
      console.log(`Maximum upload: ${MAX_FILE_SIZE_MB} MB`);
      console.log("Security: Helmet + Rate Limiting");
      console.log("Storage mode: LOCAL DEVELOPMENT (4-node replication)");
      console.log("========================================");
      console.log("");
    });
  } catch (error) {
    console.error("DATA MESH startup failed:", error);
    process.exit(1);
  }
}

startServer();