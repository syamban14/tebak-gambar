const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { getThreeWordChoices } = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck endpoint untuk Docker / VPS
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    activeRooms: rooms.size
  });
});

// Penyimpanan state seluruh room di memori
const rooms = new Map();

/**
 * Algoritma Fisher-Yates Shuffle untuk mengacak giliran tanpa duplikasi
 */
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Menghitung jarak Levenshtein untuk deteksi tebakan "Hampir Benar"
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Membuat kode room unik 5 karakter
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

/**
 * Membentuk string pola kata tertutup (contoh: "K _ _ I N G   T _ _ _ _")
 */
function buildMaskedWord(word, revealedIndices = new Set()) {
  return word
    .split('')
    .map((ch, idx) => {
      if (ch === ' ') return '  ';
      return revealedIndices.has(idx) ? ch : '_';
    })
    .join(' ');
}

/**
 * Mengirim daftar room publik ke halaman utama
 */
function broadcastPublicRooms() {
  const publicList = [];
  for (const [, r] of rooms) {
    if (r.settings.isPublic && r.players.size < r.settings.maxPlayers) {
      publicList.push({
        code: r.code,
        hostName: r.hostName,
        playerCount: r.players.size,
        maxPlayers: r.settings.maxPlayers,
        state: r.state,
        round: r.currentRound,
        maxRounds: r.settings.maxRounds
      });
    }
  }
  io.emit('rooms:public_list', publicList);
}

/**
 * Membuat objek state Room yang aman dikirim ke klien
 */
function serializeRoomState(room) {
  const playersArr = Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    score: p.score,
    guessed: p.guessed,
    turnGain: room.turnScores.get(p.id) || 0,
    isHost: p.id === room.hostId,
    isDrawer: p.id === room.currentDrawerId,
    connected: p.connected !== false
  }));

  // Susun antrean giliran Shuffle Bag untuk visualisasi di UI
  const queueStatus = room.roundTurnOrder.map((pid, idx) => {
    const p = room.players.get(pid);
    let status = 'waiting';
    if (idx < room.currentTurnIndex) status = 'done';
    else if (idx === room.currentTurnIndex && room.state !== 'lobby') status = 'current';
    return {
      id: pid,
      name: p ? p.name : 'Pemain',
      status
    };
  });

  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state, // 'lobby' | 'choosing_word' | 'drawing' | 'turn_reveal' | 'game_over'
    settings: room.settings,
    currentRound: room.currentRound,
    currentTurnIndex: room.currentTurnIndex,
    totalTurnsInRound: room.roundTurnOrder.length,
    currentDrawerId: room.currentDrawerId,
    currentDrawerName: room.players.get(room.currentDrawerId)?.name || '',
    maskedWord: room.currentWord ? buildMaskedWord(room.currentWord, room.revealedIndices) : '',
    wordLetterCounts: room.currentWord
      ? room.currentWord.split(' ').map(w => w.length).join('-')
      : '',
    revealedWord: (room.state === 'turn_reveal' || room.state === 'game_over') ? room.currentWord : null,
    timeLeft: room.timeLeft,
    players: playersArr,
    queueStatus
  };
}

/**
 * Kirim event ke 1 pemain (berdasarkan ID pemain tetap, bukan socket.id)
 */
function emitToPlayer(room, playerId, event, data) {
  const p = room.players.get(playerId);
  if (p && p.socketId) io.to(p.socketId).emit(event, data);
}

/**
 * Broadcast state terbaru room ke semua anggota room
 */
function broadcastRoomState(room) {
  const publicState = serializeRoomState(room);
  io.to(room.code).emit('room:state', publicState);

  // Kirim kata asli secara privat ke Drawer saat sedang menggambar
  if (room.state === 'drawing' && room.currentDrawerId && room.currentWord) {
    emitToPlayer(room, room.currentDrawerId, 'drawer:secret_word', room.currentWord);
  }
}

/**
 * Menghentikan interval timer room
 */
function clearRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

/**
 * Inisialisasi antrean acak (Shuffle Bag) untuk ronde baru
 * Memastikan semua pemain mendapat 1 giliran sebelum diacak ulang,
 * dan mencegah pemain terakhir di ronde sebelumnya langsung dapat giliran pertama.
 */
function initRoundShuffleQueue(room) {
  const playerIds = Array.from(room.players.keys());
  let shuffled = shuffleArray(playerIds);

  // Anti Back-to-Back: Jika pemain pertama di ronde baru sama dengan pelukis terakhir ronde lalu
  if (shuffled.length > 1 && room.lastDrawerId && shuffled[0] === room.lastDrawerId) {
    const swapIdx = 1 + Math.floor(Math.random() * (shuffled.length - 1));
    [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
  }

  room.roundTurnOrder = shuffled;
  room.currentTurnIndex = -1;
}

/**
 * Memulai giliran berikutnya dari antrean Shuffle Bag
 */
function startNextTurn(room) {
  clearRoomTimer(room);

  // Cek apakah jumlah pemain masih cukup (minimal 2 pemain)
  if (room.players.size < 2) {
    room.state = 'lobby';
    room.currentDrawerId = null;
    room.currentWord = null;
    io.to(room.code).emit('chat:message', {
      type: 'system-info',
      text: '⚠️ Permainan dihentikan karena jumlah pemain kurang dari 2 orang.'
    });
    broadcastRoomState(room);
    return;
  }

  room.currentTurnIndex++;

  // Jika semua pemain di antrean ronde ini sudah kebagian giliran
  if (room.currentTurnIndex >= room.roundTurnOrder.length) {
    if (room.currentRound >= room.settings.maxRounds) {
      // Semua ronde selesai -> Masuk ke Podium Akhir
      room.state = 'game_over';
      room.currentDrawerId = null;
      room.timeLeft = 0;
      io.to(room.code).emit('chat:message', {
        type: 'system-correct',
        text: '🏆 Seluruh ronde selesai! Lihat Podium Juara!'
      });
      broadcastRoomState(room);
      broadcastPublicRooms();
      return;
    }

    // Lanjut ke ronde berikutnya dengan mengacak ulang Shuffle Bag
    room.currentRound++;
    initRoundShuffleQueue(room);
    room.currentTurnIndex = 0;

    io.to(room.code).emit('chat:message', {
      type: 'system-info',
      text: `🔄 Memulai Ronde ${room.currentRound}/${room.settings.maxRounds}! Antrean giliran seluruh pemain telah diacak ulang.`
    });
  }

  const drawerId = room.roundTurnOrder[room.currentTurnIndex];
  const drawer = room.players.get(drawerId);

  // Jika pemain sudah keluar, lewati ke antrean berikutnya
  if (!drawer) {
    startNextTurn(room);
    return;
  }

  room.currentDrawerId = drawerId;
  room.lastDrawerId = drawerId;
  room.currentWord = null;
  room.revealedIndices = new Set();
  room.strokeHistory = [];
  room.turnScores = new Map();
  room.correctGuessCount = 0;

  // Reset status tebakan seluruh pemain untuk giliran baru
  for (const [, p] of room.players) {
    p.guessed = false;
  }

  // Kosongkan kanvas di semua klien
  io.to(room.code).emit('canvas:clear');

  // Masuk ke Fase Pemilihan 3 Kata (10 detik)
  room.state = 'choosing_word';
  room.wordChoices = getThreeWordChoices(room.usedWords);
  room.timeLeft = 10;

  io.to(room.code).emit('chat:message', {
    type: 'system-info',
    text: `🎲 Giliran ${room.currentTurnIndex + 1}/${room.roundTurnOrder.length}: ${drawer.name} terpilih untuk menggambar!`
  });

  // Kirim 3 pilihan kata khusus ke Drawer
  emitToPlayer(room, drawerId, 'word:choices', room.wordChoices);
  broadcastRoomState(room);

  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit('room:timer', room.timeLeft);

    if (room.timeLeft <= 0) {
      // Jika Drawer tidak memilih dalam 10 detik, sistem pilih otomatis secara acak
      const autoPick = room.wordChoices[Math.floor(Math.random() * room.wordChoices.length)].word;
      beginDrawingPhase(room, autoPick, true);
    }
  }, 1000);
}

/**
 * Memulai Fase Menggambar setelah kata dipilih
 */
function beginDrawingPhase(room, chosenWord, isAutoPicked = false) {
  clearRoomTimer(room);

  room.state = 'drawing';
  room.currentWord = chosenWord.toUpperCase();
  room.usedWords.add(room.currentWord);
  room.revealedIndices = new Set();
  room.timeLeft = room.settings.drawTime;

  const drawer = room.players.get(room.currentDrawerId);
  if (isAutoPicked && drawer) {
    emitToPlayer(room, room.currentDrawerId, 'chat:message', {
      type: 'system-close',
      text: `⏱️ Waktu pilih habis! Sistem memilihkan kata "${room.currentWord}" secara otomatis.`
    });
  }

  io.to(room.code).emit('chat:message', {
    type: 'system-info',
    text: `✏️ ${drawer ? drawer.name : 'Drawer'} mulai menggambar! Ayo tebak katanya di kolom chat!`
  });

  broadcastRoomState(room);

  const halfTime = Math.floor(room.settings.drawTime * 0.5);
  const quarterTime = Math.floor(room.settings.drawTime * 0.25);

  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit('room:timer', room.timeLeft);

    // Buka 1 huruf petunjuk saat waktu tersisa 50% dan 25%
    if (room.timeLeft === halfTime || room.timeLeft === quarterTime) {
      revealRandomLetterHint(room);
    }

    if (room.timeLeft <= 0) {
      endTurnWithReveal(room, '⏱️ Waktu habis!');
    }
  }, 1000);
}

/**
 * Membuka 1 huruf acak sebagai petunjuk bagi penebak
 */
function revealRandomLetterHint(room) {
  if (!room.currentWord) return;
  const validIndices = [];
  for (let i = 0; i < room.currentWord.length; i++) {
    if (room.currentWord[i] !== ' ' && !room.revealedIndices.has(i)) {
      validIndices.push(i);
    }
  }
  const totalLetters = room.currentWord.replace(/\s+/g, '').length;
  // Maksimal 35% huruf yang boleh terbuka sebagai petunjuk
  if (validIndices.length > 0 && room.revealedIndices.size < Math.floor(totalLetters * 0.35)) {
    const pickIdx = validIndices[Math.floor(Math.random() * validIndices.length)];
    room.revealedIndices.add(pickIdx);
    broadcastRoomState(room);
  }
}

/**
 * Mengakhiri giliran dan menampilkan layar Rekap Poin selama 6 detik
 */
function endTurnWithReveal(room, reasonText) {
  clearRoomTimer(room);
  room.state = 'turn_reveal';
  room.timeLeft = 6;

  io.to(room.code).emit('chat:message', {
    type: 'system-correct',
    text: `${reasonText} Jawabannya adalah: ${room.currentWord}`
  });

  broadcastRoomState(room);

  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit('room:timer', room.timeLeft);
    if (room.timeLeft <= 0) {
      startNextTurn(room);
    }
  }, 1000);
}

// ==========================================
// PENGELOLAAN PEMAIN (ID TETAP + MASA TUNGGU RECONNECT)
// ==========================================
const RECONNECT_GRACE_MS = 60 * 1000;

function newPlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Hapus pemain secara permanen dari room (keluar manual / masa tunggu habis)
 */
function removePlayerFromRoom(room, playerId) {
  const leavingPlayer = room.players.get(playerId);
  if (!leavingPlayer) return;
  if (leavingPlayer.graceTimer) clearTimeout(leavingPlayer.graceTimer);
  room.players.delete(playerId);

  if (room.players.size === 0) {
    clearRoomTimer(room);
    rooms.delete(room.code);
    broadcastPublicRooms();
    return;
  }

  if (room.hostId === playerId) {
    const nextHost = Array.from(room.players.values()).find(p => p.connected) || room.players.values().next().value;
    if (nextHost) {
      room.hostId = nextHost.id;
      room.hostName = nextHost.name;
      io.to(room.code).emit('chat:message', {
        type: 'system-info',
        text: `👑 ${nextHost.name} sekarang menjadi Host room.`
      });
    }
  }

  const idxInQueue = room.roundTurnOrder.indexOf(playerId);
  if (idxInQueue !== -1) {
    if (idxInQueue < room.currentTurnIndex) {
      room.roundTurnOrder.splice(idxInQueue, 1);
      room.currentTurnIndex--;
    } else if (idxInQueue > room.currentTurnIndex) {
      room.roundTurnOrder.splice(idxInQueue, 1);
    } else {
      room.roundTurnOrder.splice(idxInQueue, 1);
      room.currentTurnIndex--;
      if (room.state === 'choosing_word' || room.state === 'drawing') {
        io.to(room.code).emit('chat:message', {
          type: 'system-close',
          text: `⚠️ Pelukis (${leavingPlayer.name}) keluar. Beralih ke giliran berikutnya...`
        });
        startNextTurn(room);
        broadcastPublicRooms();
        return;
      }
    }
  }

  io.to(room.code).emit('chat:message', {
    type: 'system-info',
    text: `👋 ${leavingPlayer.name} keluar dari room.`
  });

  if (room.state === 'drawing') {
    const remaining = Array.from(room.players.values()).filter(p => p.id !== room.currentDrawerId && p.connected);
    if (remaining.length === 0 || remaining.every(p => p.guessed)) {
      endTurnWithReveal(room, 'Giliran selesai!');
      return;
    }
  }

  broadcastRoomState(room);
  broadcastPublicRooms();
}

// ==========================================
// SOCKET.IO EVENT HANDLERS
// ==========================================
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let myId = null;

  const getRoom = () => (currentRoomCode ? rooms.get(currentRoomCode) : null);

  broadcastPublicRooms();

  function attachPlayer(room, player) {
    player.socketId = socket.id;
    player.connected = true;
    if (player.graceTimer) {
      clearTimeout(player.graceTimer);
      player.graceTimer = null;
    }
    myId = player.id;
    currentRoomCode = room.code;
    socket.join(room.code);
  }

  // Buat Room Baru
  socket.on('room:create', ({ playerName, avatarColor, settings }, callback) => {
    const cleanName = (playerName || 'Pemain').trim().slice(0, 18) || 'Pemain';
    const code = generateRoomCode();
    const playerId = newPlayerId();

    const room = {
      code,
      hostId: playerId,
      hostName: cleanName,
      state: 'lobby',
      settings: {
        maxPlayers: Math.min(Math.max(Number(settings?.maxPlayers) || 10, 2), 16),
        maxRounds: Math.min(Math.max(Number(settings?.maxRounds) || 3, 1), 10),
        drawTime: Math.min(Math.max(Number(settings?.drawTime) || 60, 30), 120),
        isPublic: settings?.isPublic !== false
      },
      currentRound: 1,
      roundTurnOrder: [playerId],
      currentTurnIndex: -1,
      currentDrawerId: null,
      lastDrawerId: null,
      currentWord: null,
      wordChoices: [],
      usedWords: new Set(),
      revealedIndices: new Set(),
      strokeHistory: [],
      turnScores: new Map(),
      correctGuessCount: 0,
      timeLeft: 0,
      timerInterval: null,
      players: new Map()
    };

    const player = {
      id: playerId,
      socketId: socket.id,
      connected: true,
      graceTimer: null,
      name: cleanName,
      color: avatarColor || '#6366f1',
      score: 0,
      guessed: false
    };
    room.players.set(playerId, player);
    rooms.set(code, room);
    attachPlayer(room, player);

    if (callback) callback({ ok: true, code, playerId });
    broadcastRoomState(room);
    broadcastPublicRooms();
  });

  // Gabung ke Room yang Sudah Ada
  socket.on('room:join', ({ roomCode, playerName, avatarColor }, callback) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return callback && callback({ ok: false, error: 'Kode Room tidak ditemukan!' });
    }
    if (room.players.size >= room.settings.maxPlayers) {
      return callback && callback({ ok: false, error: `Room sudah penuh (${room.settings.maxPlayers}/${room.settings.maxPlayers})!` });
    }

    const cleanName = (playerName || 'Pemain').trim().slice(0, 18) || 'Pemain';
    const playerId = newPlayerId();
    const player = {
      id: playerId,
      socketId: socket.id,
      connected: true,
      graceTimer: null,
      name: cleanName,
      color: avatarColor || '#10b981',
      score: 0,
      guessed: false
    };
    room.players.set(playerId, player);

    if (room.state === 'lobby') {
      room.roundTurnOrder.push(playerId);
    } else {
      const remainingStart = room.currentTurnIndex + 1;
      const insertPos = remainingStart + Math.floor(Math.random() * (room.roundTurnOrder.length - remainingStart + 1));
      room.roundTurnOrder.splice(insertPos, 0, playerId);
    }

    attachPlayer(room, player);
    if (callback) callback({ ok: true, code, playerId });

    io.to(code).emit('chat:message', {
      type: 'system-info',
      text: `👋 ${cleanName} bergabung ke dalam room!`
    });

    if (room.state === 'drawing' && room.strokeHistory.length > 0) {
      socket.emit('canvas:history', room.strokeHistory);
    }

    broadcastRoomState(room);
    broadcastPublicRooms();
  });

  // Masuk kembali ke room setelah refresh / koneksi putus
  socket.on('room:rejoin', ({ roomCode, playerId }, callback) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    const player = room && room.players.get(playerId);
    if (!room || !player) {
      return callback && callback({ ok: false, error: 'Sesi sudah berakhir.' });
    }

    attachPlayer(room, player);
    if (callback) callback({ ok: true, code, playerId });

    io.to(code).emit('chat:message', {
      type: 'system-info',
      text: `🔌 ${player.name} tersambung kembali.`
    });

    if (room.state === 'drawing') {
      socket.emit('canvas:history', room.strokeHistory);
    }
    if (room.state === 'choosing_word' && room.currentDrawerId === playerId) {
      socket.emit('word:choices', room.wordChoices);
    }

    broadcastRoomState(room);
    broadcastPublicRooms();
  });

  // Keluar dari room secara manual
  socket.on('room:leave', () => {
    const room = getRoom();
    if (!room || !myId) return;
    const pid = myId;
    socket.leave(room.code);
    currentRoomCode = null;
    myId = null;
    removePlayerFromRoom(room, pid);
  });

  // Update Pengaturan Room oleh Host di Lobby
  socket.on('room:update_settings', (newSettings) => {
    const room = getRoom();
    if (!room || room.hostId !== myId || room.state !== 'lobby') return;

    room.settings = {
      maxPlayers: Math.min(Math.max(Number(newSettings?.maxPlayers) || 10, 2), 16),
      maxRounds: Math.min(Math.max(Number(newSettings?.maxRounds) || 3, 1), 10),
      drawTime: Math.min(Math.max(Number(newSettings?.drawTime) || 60, 30), 120),
      isPublic: Boolean(newSettings?.isPublic)
    };
    broadcastRoomState(room);
    broadcastPublicRooms();
  });

  // Mulai Permainan (Oleh Host)
  socket.on('game:start', (_, callback) => {
    const room = getRoom();
    if (!room || room.hostId !== myId) return;

    if (room.players.size < 2) {
      return callback && callback({ ok: false, error: 'Minimal butuh 2 pemain di room untuk memulai permainan!' });
    }

    for (const [, p] of room.players) {
      p.score = 0;
      p.guessed = false;
    }
    room.currentRound = 1;
    room.usedWords.clear();
    room.lastDrawerId = null;

    initRoundShuffleQueue(room);
    if (callback) callback({ ok: true });

    io.to(room.code).emit('chat:message', {
      type: 'system-correct',
      text: `🚀 Permainan dimulai! Urutan giliran ${room.players.size} pemain telah diacak secara adil.`
    });

    startNextTurn(room);
    broadcastPublicRooms();
  });

  // Main Lagi dari Podium Akhir
  socket.on('game:restart', () => {
    const room = getRoom();
    if (!room || room.hostId !== myId) return;

    clearRoomTimer(room);
    for (const [, p] of room.players) {
      p.score = 0;
      p.guessed = false;
    }
    room.state = 'lobby';
    room.currentRound = 1;
    room.roundTurnOrder = Array.from(room.players.keys());
    room.currentTurnIndex = -1;
    room.currentDrawerId = null;
    room.currentWord = null;
    broadcastRoomState(room);
    broadcastPublicRooms();
  });

  // Drawer Memilih 1 dari 3 Kata
  socket.on('word:select', (chosenWord) => {
    const room = getRoom();
    if (!room || room.state !== 'choosing_word' || room.currentDrawerId !== myId) return;

    const validChoice = room.wordChoices.find(c => c.word === chosenWord);
    const wordToUse = validChoice ? validChoice.word : room.wordChoices[0].word;
    beginDrawingPhase(room, wordToUse, false);
  });

  // Sinkronisasi Goresan Kuas Real-time
  socket.on('canvas:stroke', (strokeData) => {
    const room = getRoom();
    if (!room || room.state !== 'drawing' || room.currentDrawerId !== myId) return;

    room.strokeHistory.push({ type: 'stroke', ...strokeData });
    socket.to(room.code).emit('canvas:stroke', strokeData);
  });

  // Sinkronisasi Flood Fill (Bucket)
  socket.on('canvas:fill', (fillData) => {
    const room = getRoom();
    if (!room || room.state !== 'drawing' || room.currentDrawerId !== myId) return;

    room.strokeHistory.push({ type: 'fill', ...fillData });
    socket.to(room.code).emit('canvas:fill', fillData);
  });

  // Undo Goresan Terakhir
  socket.on('canvas:undo', () => {
    const room = getRoom();
    if (!room || room.state !== 'drawing' || room.currentDrawerId !== myId) return;
    if (room.strokeHistory.length === 0) return;

    const lastItem = room.strokeHistory[room.strokeHistory.length - 1];
    if (lastItem.strokeId) {
      const targetId = lastItem.strokeId;
      while (
        room.strokeHistory.length > 0 &&
        room.strokeHistory[room.strokeHistory.length - 1].strokeId === targetId
      ) {
        room.strokeHistory.pop();
      }
    } else {
      room.strokeHistory.pop();
    }

    io.to(room.code).emit('canvas:rebuild', room.strokeHistory);
  });

  // Bersihkan Kanvas
  socket.on('canvas:clear', () => {
    const room = getRoom();
    if (!room || room.state !== 'drawing' || room.currentDrawerId !== myId) return;

    room.strokeHistory = [];
    io.to(room.code).emit('canvas:clear');
  });

  // Kirim Tebakan / Chat
  socket.on('chat:send', (rawMessage) => {
    const room = getRoom();
    if (!room) return;
    const player = room.players.get(myId);
    if (!player) return;

    const text = String(rawMessage || '').trim().slice(0, 80);
    if (!text) return;

    if (room.state === 'drawing' && room.currentWord) {
      const cleanGuess = text.toUpperCase().replace(/\s+/g, ' ');
      const targetWord = room.currentWord.toUpperCase();

      if (myId === room.currentDrawerId) {
        socket.emit('chat:message', {
          type: 'system-close',
          text: '🤫 Kamu sedang menggambar, tidak boleh mengirim chat tebakan!'
        });
        return;
      }

      if (player.guessed) {
        socket.emit('chat:message', {
          type: 'system-info',
          text: `✅ Kamu sudah menebak benar! Pesanmu disembunyikan agar tidak bocor.`
        });
        return;
      }

      if (cleanGuess === targetWord) {
        player.guessed = true;
        room.correctGuessCount++;

        const speedBonus = Math.round((room.timeLeft / room.settings.drawTime) * 300);
        let orderBonus = 0;
        if (room.correctGuessCount === 1) orderBonus = 100;
        else if (room.correctGuessCount === 2) orderBonus = 50;
        else if (room.correctGuessCount === 3) orderBonus = 25;

        const guesserPoints = 100 + speedBonus + orderBonus;
        player.score += guesserPoints;
        room.turnScores.set(player.id, (room.turnScores.get(player.id) || 0) + guesserPoints);

        const drawer = room.players.get(room.currentDrawerId);
        if (drawer) {
          let drawerGain = 60;
          const totalGuessers = room.players.size - 1;
          if (room.correctGuessCount === totalGuessers && totalGuessers > 1) {
            drawerGain += 100;
          }
          drawer.score += drawerGain;
          room.turnScores.set(drawer.id, (room.turnScores.get(drawer.id) || 0) + drawerGain);
        }

        io.to(room.code).emit('chat:message', {
          type: 'system-correct',
          text: `🎉 ${player.name} berhasil menebak kata! (+${guesserPoints} poin)`,
          sound: 'correct'
        });

        broadcastRoomState(room);

        const allGuessersDone = Array.from(room.players.values())
          .filter(p => p.id !== room.currentDrawerId && p.connected)
          .every(p => p.guessed);

        if (allGuessersDone) {
          endTurnWithReveal(room, '🔥 Luar biasa! Semua pemain berhasil menebak!');
        }
        return;
      }

      const dist = levenshteinDistance(cleanGuess, targetWord);
      if (targetWord.length >= 4 && dist > 0 && dist <= 2) {
        socket.emit('chat:message', {
          type: 'system-close',
          text: `🤏 Hampir benar! Tebakanmu "${text}" sangat mendekati!`,
          sound: 'close'
        });
        return;
      }
    }

    io.to(room.code).emit('chat:message', {
      type: 'normal',
      sender: player.name,
      color: player.color,
      text
    });
  });

  // Koneksi putus: tahan pemain selama masa tunggu agar bisa rejoin
  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room || !myId) return;
    const player = room.players.get(myId);
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;
    const pid = myId;
    player.graceTimer = setTimeout(() => {
      const r = rooms.get(room.code);
      if (r) removePlayerFromRoom(r, pid);
    }, RECONNECT_GRACE_MS);

    io.to(room.code).emit('chat:message', {
      type: 'system-info',
      text: `📴 ${player.name} terputus. Menunggu tersambung kembali (60 dtk)...`
    });

    if (room.state === 'drawing') {
      const remaining = Array.from(room.players.values()).filter(p => p.id !== room.currentDrawerId && p.connected);
      if (remaining.length > 0 && remaining.every(p => p.guessed)) {
        endTurnWithReveal(room, 'Giliran selesai!');
        return;
      }
    }
    broadcastRoomState(room);
  });
});

server.listen(PORT, () => {
  console.log(`🎨 Server Tebak Gambar Multiplayer berjalan di http://localhost:${PORT}`);
});
