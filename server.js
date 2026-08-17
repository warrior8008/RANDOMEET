const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_NAME = 32;
const MAX_TEXT = 1000;
const INTERESTS_LIMIT = 8;
const ROOM_CAP = { '2p': 2, group: 5 };
const DEFAULT_MODE = 'group';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function safe(str, limit) {
  return String(str ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit).trim();
}

function sanitizeInterests(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const t = safe(item, 40).toLowerCase();
    if (t && !out.includes(t) && out.length < INTERESTS_LIMIT) out.push(t);
  }
  return out;
}

/* ---------------- ICE / TURN configuration ---------------- */

const DEFAULT_ICE = [
  {
    urls: [
      'stun:openrelay.metered.ca:80',
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:cloudflare.com:3478',
    ],
  },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

function buildIceConfig() {
  if (process.env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      console.warn('[server] ICE_SERVERS env is invalid JSON, using defaults.');
    }
  }
  if (process.env.TURN_URL) {
    return [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      {
        urls: [process.env.TURN_URL],
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || '',
      },
    ];
  }
  return DEFAULT_ICE;
}

const ICE_CONFIG = buildIceConfig();

const httpServer = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400); res.end('400 Bad Request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!(filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep))) {
    res.writeHead(403); res.end('403'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 1048576 });

const clients = new Map();   // ws -> client object
const rooms = new Map();     // roomId -> room object

let onlineTimer = null;
function broadcastOnline() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    const count = clients.size;
    const msg = JSON.stringify({ type: 'online', online: count });
    for (const c of clients.values()) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }, 100);
}

function findClient(id) {
  for (const c of clients.values()) if (c.id === id) return c;
  return null;
}

function broadcastRoom(room) {
  const members = room.members.map((m) => ({ id: m.id, name: m.name || 'Stranger' }));
  for (const m of room.members) {
    send(m, { type: 'room', roomId: room.id, selfId: m.id, members });
  }
}

function removeFromRoom(client, reason) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  client.lastRooms.push(room.id);
  if (client.lastRooms.length > 3) client.lastRooms.shift();
  room.members = room.members.filter((m) => m !== client);
  if (room.members.length === 0) {
    rooms.delete(room.id);
    return;
  }
  for (const m of room.members) {
    send(m, { type: 'member-left', id: client.id, reason: reason || 'left' });
  }
  broadcastRoom(room);
}

function joinRoom(client) {
  const cap = ROOM_CAP[client.mode] || ROOM_CAP[DEFAULT_MODE];
  let room = null;
  for (const r of rooms.values()) {
    if (r.mode === client.mode && r.members.length < cap && !client.lastRooms.includes(r.id)) { room = r; break; }
  }
  if (!room) {
    room = { id: crypto.randomBytes(4).toString('hex'), mode: client.mode, members: [] };
    rooms.set(room.id, room);
  }
  room.members.push(client);
  client.room = room;
  broadcastRoom(room);
}

function send(client, obj) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(obj));
  }
}

function handleMessage(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'join': {
      client.name = safe(msg.name, MAX_NAME) || 'Stranger';
      client.interests = sanitizeInterests(msg.interests);
      if (msg.mode === '2p' || msg.mode === 'group') client.mode = msg.mode;
      if (client.room) removeFromRoom(client, 'rejoin');
      joinRoom(client);
      break;
    }
    case 'ready': {
      client.ready = true;
      break;
    }
    case 'signal': {
      const to = findClient(msg.to);
      if (to && to !== client && to.room === client.room && msg.data) {
        send(to, { type: 'signal', from: client.id, data: msg.data });
      }
      break;
    }
    case 'chat': {
      const text = safe(msg.text, MAX_TEXT);
      if (!text) break;
      const room = client.room;
      if (!room) break;
      for (const m of room.members) if (m !== client) send(m, { type: 'chat', text, name: client.name });
      break;
    }
    case 'typing': {
      const room = client.room;
      if (!room) break;
      for (const m of room.members) if (m !== client) send(m, { type: 'typing', isTyping: !!msg.isTyping });
      break;
    }
    case 'next': {
      removeFromRoom(client, 'next');
      joinRoom(client);
      break;
    }
    case 'report': {
      removeFromRoom(client, 'reported');
      joinRoom(client);
      break;
    }
    case 'leave': {
      removeFromRoom(client, 'leave');
      client.name = null;
      client.interests = [];
      send(client, { type: 'status', text: 'idle' });
      break;
    }
    default:
      break;
  }
}

wss.on('connection', (ws) => {
  const client = {
    id: crypto.randomBytes(8).toString('hex'),
    ws,
    name: null,
    interests: [],
    mode: DEFAULT_MODE,
    room: null,
    lastRooms: [],
    ready: false,
    alive: true,
  };
  clients.set(ws, client);
  send(client, { type: 'welcome', id: client.id, online: clients.size, iceServers: ICE_CONFIG });
  broadcastOnline();

  ws.on('message', (data) => {
    const text = data.toString();
    if (text.length > 8192) return;
    handleMessage(client, text);
  });

  ws.on('pong', () => { client.alive = true; });

  ws.on('close', () => {
    clients.delete(ws);
    removeFromRoom(client, 'disconnected');
    broadcastOnline();
  });

  ws.on('error', () => { ws.terminate(); });
});

const heartbeat = setInterval(() => {
  for (const c of clients.values()) {
    if (c.ws.readyState !== WebSocket.OPEN) { c.ws.terminate(); continue; }
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    c.ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.on('error', (err) => {
  console.error('[server] Failed to start:', err.message);
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log('==========================================');
  console.log('  CHATKRO server running');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-ip>:${PORT}`);
  console.log('==========================================');
});
