const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.get('/', (req, res) => res.send('3D Shooter Server Online'));
app.get('/ping', (req, res) => res.json({ status: 'ok', players: Object.keys(players).length }));

const players = {};
const BULLET_SPEED = 0.5;
const MAP_BOUNDS = 40;

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Spawn player at random position
  players[socket.id] = {
    id: socket.id,
    x: (Math.random() - 0.5) * 30,
    y: 0,
    z: (Math.random() - 0.5) * 30,
    rotY: 0,
    hp: 100,
    name: `Player${Math.floor(Math.random() * 9000) + 1000}`,
    kills: 0,
    deaths: 0
  };

  // Send current state to new player
  socket.emit('init', { id: socket.id, players });

  // Notify others
  socket.broadcast.emit('playerJoined', players[socket.id]);

  socket.on('move', (data) => {
    if (!players[socket.id]) return;
    players[socket.id].x = data.x;
    players[socket.id].y = data.y;
    players[socket.id].z = data.z;
    players[socket.id].rotY = data.rotY;
    socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y, z: data.z, rotY: data.rotY });
  });

  socket.on('shoot', (data) => {
    io.emit('bulletFired', {
      id: socket.id,
      ox: data.ox, oy: data.oy, oz: data.oz,
      dx: data.dx, dy: data.dy, dz: data.dz
    });

    // Server-side hit detection
    for (const [pid, p] of Object.entries(players)) {
      if (pid === socket.id) continue;
      const ex = data.ox, ey = data.oy, ez = data.oz;
      const dx = data.dx, dy = data.dy, dz = data.dz;
      // Ray-sphere intersection
      const cx = p.x - ex, cy = (p.y + 1) - ey, cz = p.z - ez;
      const t = cx * dx + cy * dy + cz * dz;
      if (t < 0) continue;
      const px2 = ex + dx * t - p.x;
      const py2 = ey + dy * t - (p.y + 1);
      const pz2 = ez + dz * t - p.z;
      const dist2 = px2 * px2 + py2 * py2 + pz2 * pz2;
      if (dist2 < 1.2) {
        players[pid].hp -= 25;
        io.emit('playerHit', { id: pid, hp: players[pid].hp, shooter: socket.id });

        if (players[pid].hp <= 0) {
          players[pid].hp = 100;
          players[pid].x = (Math.random() - 0.5) * 30;
          players[pid].z = (Math.random() - 0.5) * 30;
          players[pid].deaths = (players[pid].deaths || 0) + 1;
          if (players[socket.id]) players[socket.id].kills = (players[socket.id].kills || 0) + 1;

          io.emit('playerDied', {
            id: pid,
            killer: socket.id,
            respawn: { x: players[pid].x, z: players[pid].z },
            hp: 100
          });
        }
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
