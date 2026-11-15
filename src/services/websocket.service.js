const { WebSocketServer } = require('ws');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Set();
    this.pingInterval = null;
  }

  initialize(httpServer, path = '/ws') {
    this.wss = new WebSocketServer({ server: httpServer, path });

    this.wss.on('connection', ws => {
      ws.isAlive = true;
      this.clients.add(ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    this.pingInterval = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) {
          this.clients.delete(ws);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);

    return this.wss;
  }

  broadcast(type, data) {
    if (!this.wss || !this.clients.size) return;

    const payload = JSON.stringify({ type, data });
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(payload);
        } catch {
          this.clients.delete(client);
        }
      }
    }
  }

  close() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.wss) {
      for (const client of this.clients) {
        try {
          client.close();
        } catch {}
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }
  }
}

module.exports = new WebSocketService();

