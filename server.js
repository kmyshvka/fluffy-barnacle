// ============================================================
// MULTIPLAYER JUMP & RUN SERVER
// Deploy this on render.com as a Node.js web service
// Start command: node server.js
// ============================================================

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;

// Simple HTTP server to handle health checks
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', players: Object.keys(players).length }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ============================================================
// GAME STATE
// ============================================================
let players = {};
let currentLevel = null;
let levelSeed = Math.floor(Math.random() * 999999);
let levelStartTime = Date.now();
let finishedPlayers = new Set();
let gamePhase = 'waiting'; // 'waiting', 'playing', 'finished'
let countdownTimer = null;

// ============================================================
// LEVEL GENERATION (Server-side seed generation)
// ============================================================
function generateLevel(seed) {
  const rng = mulberry32(seed);
  const platforms = [];
  const PLATFORM_COUNT = 14 + Math.floor(rng() * 6);

  // Starting platform
  platforms.push({ x: 0, y: -2, z: 0, w: 4, d: 4, type: 'start' });

  let x = 0, y = -2, z = -6;
  for (let i = 0; i < PLATFORM_COUNT; i++) {
    const dx = (rng() - 0.3) * 5;
    const dy = (rng() - 0.4) * 2.5;
    const dz = -(3 + rng() * 3);

    x = Math.max(-12, Math.min(12, x + dx));
    y = Math.max(-4, Math.min(8, y + dy));
    z += dz;

    const w = 1.5 + rng() * 2.5;
    const d = 1.5 + rng() * 2.5;
    const type = rng() > 0.75 ? 'moving' : 'static';
    const moveAxis = rng() > 0.5 ? 'x' : 'y';
    const moveRange = 1.5 + rng() * 2;
    const moveSpeed = 0.5 + rng() * 1.5;

    platforms.push({ x, y, z, w, d, type, moveAxis, moveRange, moveSpeed, phase: rng() * Math.PI * 2 });
  }

  // Goal platform
  const lastP = platforms[platforms.length - 1];
  platforms.push({ x: lastP.x, y: lastP.y + 0.5, z: lastP.z - 4, w: 3, d: 3, type: 'goal' });

  return {
    seed,
    platforms,
    spawnPos: { x: 0, y: 1, z: 0 },
    goalPos: { x: platforms[platforms.length - 1].x, y: platforms[platforms.length - 1].y + 2, z: platforms[platforms.length - 1].z }
  };
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ============================================================
// LEVEL MANAGEMENT
// ============================================================
function startNewLevel() {
  levelSeed = Math.floor(Math.random() * 999999);
  currentLevel = generateLevel(levelSeed);
  levelStartTime = Date.now();
  finishedPlayers.clear();
  gamePhase = 'playing';

  // Reset all players to spawn
  Object.keys(players).forEach(id => {
    players[id].finished = false;
    players[id].pos = { ...currentLevel.spawnPos };
  });

  io.emit('level_start', {
    seed: levelSeed,
    level: currentLevel,
    startTime: levelStartTime,
    players: players
  });

  console.log(`New level started! Seed: ${levelSeed}, Players: ${Object.keys(players).length}`);
}

function checkAllFinished() {
  const activePlayers = Object.keys(players);
  if (activePlayers.length === 0) return;

  const allDone = activePlayers.every(id => finishedPlayers.has(id));
  if (allDone) {
    gamePhase = 'finished';
    io.emit('all_finished', { times: getFinishTimes() });

    // Start next level after 5 seconds
    if (countdownTimer) clearTimeout(countdownTimer);
    countdownTimer = setTimeout(() => {
      startNewLevel();
    }, 5000);
  }
}

function getFinishTimes() {
  const times = {};
  Object.keys(players).forEach(id => {
    if (players[id].finishTime) {
      times[id] = {
        name: players[id].name,
        time: players[id].finishTime - levelStartTime
      };
    }
  });
  return times;
}

// ============================================================
// SOCKET.IO EVENTS
// ============================================================
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Send current state to new player
  if (currentLevel) {
    socket.emit('level_start', {
      seed: levelSeed,
      level: currentLevel,
      startTime: levelStartTime,
      players: players
    });
  }

  socket.on('join', (data) => {
    const name = (data.name || 'Spieler').substring(0, 16);
    const color = data.color || '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');

    players[socket.id] = {
      id: socket.id,
      name,
      color,
      pos: currentLevel ? { ...currentLevel.spawnPos } : { x: 0, y: 1, z: 0 },
      rot: 0,
      vel: { x: 0, y: 0, z: 0 },
      finished: false,
      finishTime: null,
      anim: 'idle'
    };

    socket.emit('joined', { id: socket.id, players, currentLevel, levelStartTime });
    socket.broadcast.emit('player_joined', players[socket.id]);

    // Start level if first player
    if (Object.keys(players).length === 1 || !currentLevel) {
      startNewLevel();
    }

    console.log(`${name} joined. Total players: ${Object.keys(players).length}`);
  });

  socket.on('move', (data) => {
    if (!players[socket.id] || players[socket.id].finished) return;
    players[socket.id].pos = data.pos;
    players[socket.id].rot = data.rot;
    players[socket.id].anim = data.anim || 'idle';
    socket.broadcast.emit('player_moved', {
      id: socket.id,
      pos: data.pos,
      rot: data.rot,
      anim: data.anim
    });
  });

  socket.on('finished', (data) => {
    if (!players[socket.id] || players[socket.id].finished) return;
    players[socket.id].finished = true;
    players[socket.id].finishTime = Date.now();
    finishedPlayers.add(socket.id);

    const elapsed = players[socket.id].finishTime - levelStartTime;
    io.emit('player_finished', {
      id: socket.id,
      name: players[socket.id].name,
      time: elapsed
    });

    console.log(`${players[socket.id].name} finished in ${(elapsed / 1000).toFixed(2)}s`);
    checkAllFinished();
  });

  socket.on('request_new_level', () => {
    // Only host (first connected player) can request
    const playerIds = Object.keys(players);
    if (playerIds[0] === socket.id) {
      startNewLevel();
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      console.log(`${players[socket.id].name} disconnected`);
      io.emit('player_left', { id: socket.id });
      delete players[socket.id];
      finishedPlayers.delete(socket.id);
      checkAllFinished();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`🎮 Jump & Run Server läuft auf Port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
