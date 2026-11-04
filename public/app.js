const socket = io();

// ==========================================
// EFEK SUARA (WEB AUDIO API SYNTHESIZER)
// ==========================================
let soundEnabled = true;
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playTone(freq, duration = 0.12, type = 'sine', delay = 0) {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.14, audioCtx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + delay);
    osc.stop(audioCtx.currentTime + delay + duration);
  } catch (_) {}
}

function playSoundEffect(kind) {
  if (!soundEnabled) return;
  if (kind === 'correct') {
    playTone(523.25, 0.12, 'triangle', 0);
    playTone(659.25, 0.12, 'triangle', 0.1);
    playTone(783.99, 0.22, 'triangle', 0.2);
  } else if (kind === 'close') {
    playTone(440, 0.12, 'sine', 0);
    playTone(415, 0.15, 'sine', 0.12);
  } else if (kind === 'tick') {
    playTone(800, 0.05, 'sine', 0);
  } else if (kind === 'turn') {
    playTone(440, 0.12, 'triangle', 0);
    playTone(587.33, 0.18, 'triangle', 0.12);
  }
}

// ==========================================
// STATE FRONTEND
// ==========================================
const avatarColors = [
  '#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6',
  '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4'
];
let selectedAvatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];
let currentRoomState = null;
let mySecretWord = '';

// ELEMEN DOM
const landingScreen = document.getElementById('landingScreen');
const gameApp = document.getElementById('gameApp');
const playerNameInput = document.getElementById('playerNameInput');
const roomCodeInput = document.getElementById('roomCodeInput');
const landingError = document.getElementById('landingError');
const publicRoomsList = document.getElementById('publicRoomsList');

// Inisialisasi Pemilih Warna Avatar
const avatarPicker = document.getElementById('avatarPicker');
avatarColors.forEach((col) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `avatar-color-dot ${col === selectedAvatarColor ? 'active' : ''}`;
  btn.style.background = col;
  btn.onclick = () => {
    document.querySelectorAll('.avatar-color-dot').forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    selectedAvatarColor = col;
  };
  avatarPicker.appendChild(btn);
});

// Cek apakah ada parameter ?room=KODE di URL
const urlParams = new URLSearchParams(window.location.search);
const invitedRoom = urlParams.get('room');
if (invitedRoom) {
  roomCodeInput.value = invitedRoom.toUpperCase().slice(0, 5);
}

// Simpan & muat nama pemain terakhir dari localStorage
const savedName = localStorage.getItem('tg_player_name');
if (savedName) playerNameInput.value = savedName;

function getPlayerProfile() {
  const name = playerNameInput.value.trim() || `Pemain${Math.floor(100 + Math.random() * 899)}`;
  localStorage.setItem('tg_player_name', name);
  return { playerName: name, avatarColor: selectedAvatarColor };
}

// Buat Room Baru
document.getElementById('btnCreateRoom').addEventListener('click', () => {
  landingError.textContent = '';
  const profile = getPlayerProfile();
  const settings = {
    maxPlayers: Number(document.getElementById('setMaxPlayers').value),
    maxRounds: Number(document.getElementById('setMaxRounds').value),
    drawTime: Number(document.getElementById('setDrawTime').value),
    isPublic: document.getElementById('setIsPublic').checked
  };

  socket.emit('room:create', { ...profile, settings }, (res) => {
    if (res?.ok) {
      enterGameScreen(res.code);
    } else {
      landingError.textContent = res?.error || 'Gagal membuat room.';
    }
  });
});

// Gabung via Kode Room
function joinRoomByCode(codeToJoin) {
  landingError.textContent = '';
  const code = (codeToJoin || roomCodeInput.value).trim().toUpperCase();
  if (!code) {
    landingError.textContent = 'Masukkan kode room terlebih dahulu!';
    return;
  }
  const profile = getPlayerProfile();
  socket.emit('room:join', { roomCode: code, ...profile }, (res) => {
    if (res?.ok) {
      enterGameScreen(res.code);
    } else {
      landingError.textContent = res?.error || 'Gagal bergabung ke room.';
    }
  });
}

document.getElementById('btnJoinCode').addEventListener('click', () => joinRoomByCode());
roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoomByCode();
});

function enterGameScreen(code) {
  landingScreen.classList.add('hidden');
  gameApp.classList.remove('hidden');
  window.history.replaceState({}, '', `?room=${code}`);
  clearLocalCanvas();
}

// Update Daftar Room Publik di Landing
socket.on('rooms:public_list', (list) => {
  if (!list || list.length === 0) {
    publicRoomsList.innerHTML = '<div class="empty-rooms">Belum ada room publik aktif. Buat room pertama!</div>';
    return;
  }
  publicRoomsList.innerHTML = '';
  list.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'public-room-item';
    const stateLabel = r.state === 'lobby' ? 'Menunggu' : `Ronde ${r.round}/${r.maxRounds}`;
    item.innerHTML = `
      <div>
        <strong>#${r.code}</strong> • Host: ${escapeHtml(r.hostName)}
        <div style="font-size:11px; color:#64748b;">${r.playerCount}/${r.maxPlayers} Pemain • ${stateLabel}</div>
      </div>
      <button class="btn-primary" style="padding: 6px 12px; font-size: 12px;">Gabung</button>
    `;
    item.querySelector('button').onclick = () => joinRoomByCode(r.code);
    publicRoomsList.appendChild(item);
  });
});

// ==========================================
// KANVAS INTERAKTIF & SINKRONISASI REAL-TIME
// ==========================================
const canvas = document.getElementById('drawCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let isDrawing = false;
let currentTool = 'brush'; // 'brush' | 'bucket' | 'eraser'
let brushColor = '#0f172a';
let brushSize = 5;
let lastPoint = null;
let currentStrokeId = null;

const paletteColors = [
  '#0f172a', '#ef4444', '#f97316', '#f59e0b', '#10b981',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
  '#78350f', '#94a3b8'
];

// Inisialisasi Palet Warna Kanvas
const colorPaletteEl = document.getElementById('colorPalette');
paletteColors.forEach((col, i) => {
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = `color-swatch ${i === 0 ? 'active' : ''}`;
  sw.style.background = col;
  sw.onclick = () => {
    document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('active'));
    sw.classList.add('active');
    brushColor = col;
    if (currentTool === 'eraser') setActiveTool('brush');
  };
  colorPaletteEl.appendChild(sw);
});

function setActiveTool(tool) {
  currentTool = tool;
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
});

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    brushSize = Number(btn.dataset.size);
  });
});

document.getElementById('btnUndo').addEventListener('click', () => {
  if (isMyTurnToDraw()) socket.emit('canvas:undo');
});

document.getElementById('btnClear').addEventListener('click', () => {
  if (isMyTurnToDraw()) socket.emit('canvas:clear');
});

function isMyTurnToDraw() {
  return (
    currentRoomState &&
    currentRoomState.state === 'drawing' &&
    currentRoomState.currentDrawerId === socket.id
  );
}

function clearLocalCanvas() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function getNormalizedPos(e) {
  const rect = canvas.getBoundingClientRect();
  const touch = e.touches?.[0] || e.changedTouches?.[0];
  const clientX = touch ? touch.clientX : e.clientX;
  const clientY = touch ? touch.clientY : e.clientY;
  return {
    x: Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1),
    y: Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1)
  };
}

function drawSegment(x0, y0, x1, y1, color, size) {
  ctx.save();
  ctx.beginPath();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
  ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
  ctx.stroke();
  ctx.restore();
}

// Flood Fill (Bucket Tool)
function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function floodFillCanvas(normX, normY, fillHex) {
  const startX = Math.floor(normX * canvas.width);
  const startY = Math.floor(normY * canvas.height);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const width = canvas.width;
  const height = canvas.height;

  const startIdx = (startY * width + startX) * 4;
  const startR = data[startIdx];
  const startG = data[startIdx + 1];
  const startB = data[startIdx + 2];

  const [fillR, fillG, fillB] = hexToRgb(fillHex);
  if (
    Math.abs(startR - fillR) < 10 &&
    Math.abs(startG - fillG) < 10 &&
    Math.abs(startB - fillB) < 10
  ) {
    return;
  }

  const stack = [[startX, startY]];
  const visited = new Uint8Array(width * height);

  const matchStartColor = (idx) => {
    return (
      Math.abs(data[idx] - startR) <= 32 &&
      Math.abs(data[idx + 1] - startG) <= 32 &&
      Math.abs(data[idx + 2] - startB) <= 32
    );
  };

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const pIdx = y * width + x;
    if (visited[pIdx]) continue;

    const rgbaIdx = pIdx * 4;
    if (!matchStartColor(rgbaIdx)) continue;

    visited[pIdx] = 1;
    data[rgbaIdx] = fillR;
    data[rgbaIdx + 1] = fillG;
    data[rgbaIdx + 2] = fillB;
    data[rgbaIdx + 3] = 255;

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  ctx.putImageData(imgData, 0, 0);
}

function handlePointerDown(e) {
  if (!isMyTurnToDraw()) return;
  e.preventDefault();
  const pos = getNormalizedPos(e);
  currentStrokeId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (currentTool === 'bucket') {
    floodFillCanvas(pos.x, pos.y, brushColor);
    socket.emit('canvas:fill', {
      x: pos.x,
      y: pos.y,
      color: brushColor,
      strokeId: currentStrokeId
    });
    return;
  }

  isDrawing = true;
  lastPoint = pos;
  const activeColor = currentTool === 'eraser' ? '#ffffff' : brushColor;
  drawSegment(pos.x, pos.y, pos.x, pos.y, activeColor, brushSize);
  socket.emit('canvas:stroke', {
    x0: pos.x,
    y0: pos.y,
    x1: pos.x,
    y1: pos.y,
    color: activeColor,
    size: brushSize,
    strokeId: currentStrokeId
  });
}

function handlePointerMove(e) {
  if (!isDrawing || !isMyTurnToDraw()) return;
  e.preventDefault();
  const pos = getNormalizedPos(e);
  const activeColor = currentTool === 'eraser' ? '#ffffff' : brushColor;
  drawSegment(lastPoint.x, lastPoint.y, pos.x, pos.y, activeColor, brushSize);
  socket.emit('canvas:stroke', {
    x0: lastPoint.x,
    y0: lastPoint.y,
    x1: pos.x,
    y1: pos.y,
    color: activeColor,
    size: brushSize,
    strokeId: currentStrokeId
  });
  lastPoint = pos;
}

function handlePointerUp() {
  isDrawing = false;
  lastPoint = null;
}

canvas.addEventListener('mousedown', handlePointerDown);
canvas.addEventListener('mousemove', handlePointerMove);
window.addEventListener('mouseup', handlePointerUp);

canvas.addEventListener('touchstart', handlePointerDown, { passive: false });
canvas.addEventListener('touchmove', handlePointerMove, { passive: false });
window.addEventListener('touchend', handlePointerUp);

// Event Kanvas dari Server
socket.on('canvas:stroke', (s) => {
  drawSegment(s.x0, s.y0, s.x1, s.y1, s.color, s.size);
});

socket.on('canvas:fill', (f) => {
  floodFillCanvas(f.x, f.y, f.color);
});

socket.on('canvas:clear', () => {
  clearLocalCanvas();
});

function replayCanvasActions(actions) {
  clearLocalCanvas();
  (actions || []).forEach((act) => {
    if (act.type === 'stroke') {
      drawSegment(act.x0, act.y0, act.x1, act.y1, act.color, act.size);
    } else if (act.type === 'fill') {
      floodFillCanvas(act.x, act.y, act.color);
    }
  });
}

socket.on('canvas:history', replayCanvasActions);
socket.on('canvas:rebuild', replayCanvasActions);

// ==========================================
// RENDER STATE ROOM & SHUFFLE BAG
// ==========================================
socket.on('room:state', (state) => {
  const prevState = currentRoomState?.state;
  currentRoomState = state;

  if (prevState !== state.state && (state.state === 'choosing_word' || state.state === 'drawing')) {
    playSoundEffect('turn');
  }

  // Update Kode Room
  document.getElementById('headerRoomCode').textContent = state.code;
  document.getElementById('sidebarRoomCode').textContent = `#${state.code}`;
  document.getElementById('lobbyCodeTitle').textContent = `#${state.code}`;

  // Update Indikator Ronde & Giliran
  const roundEl = document.getElementById('roundIndicator');
  if (state.state === 'lobby') {
    roundEl.textContent = `Lobby • Maks ${state.settings.maxRounds} Ronde`;
  } else {
    const turnNum = Math.min(state.currentTurnIndex + 1, state.totalTurnsInRound);
    roundEl.textContent = `Ronde ${state.currentRound}/${state.settings.maxRounds} • Giliran ${turnNum}/${state.totalTurnsInRound}`;
  }

  // Update Pengaturan di Lobby
  document.getElementById('lblMaxPlayers').textContent = `${state.settings.maxPlayers} Orang`;
  document.getElementById('lblMaxRounds').textContent = `${state.settings.maxRounds} Ronde`;
  document.getElementById('lblDrawTime').textContent = `${state.settings.drawTime} Detik`;

  const amIHost = state.hostId === socket.id;
  const amIDrawer = state.currentDrawerId === socket.id;

  document.getElementById('btnStartGame').classList.toggle('hidden', !amIHost);
  document.getElementById('waitingHostNotice').classList.toggle('hidden', amIHost);

  // Update Tampilan Kata / Hint di Header
  const wordLabel = document.getElementById('wordRoleLabel');
  const wordDisplay = document.getElementById('wordDisplay');

  if (state.state === 'lobby') {
    wordLabel.textContent = 'MENUNGGU PERMAINAN DIMULAI';
    wordDisplay.textContent = 'SIAP BERMAIN';
  } else if (state.state === 'choosing_word') {
    wordLabel.textContent = 'MEMILIH KATA';
    wordDisplay.textContent = '? ? ?';
  } else if (state.state === 'drawing') {
    if (amIDrawer) {
      wordLabel.textContent = 'KATA YANG HARUS KAMU GAMBAR';
      wordDisplay.textContent = mySecretWord || '...';
    } else {
      wordLabel.textContent = `TEBAK GAMBAR INI (${state.wordLetterCounts} HURUF)`;
      wordDisplay.textContent = state.maskedWord;
    }
  } else if (state.state === 'turn_reveal' || state.state === 'game_over') {
    wordLabel.textContent = 'JAWABAN GILIRAN INI';
    wordDisplay.textContent = state.revealedWord || '-';
  }

  // Update Timer
  updateTimerUI(state.timeLeft);

  // Render Antrean Acak (Shuffle Bag Queue Bar)
  renderShuffleQueue(state.queueStatus);

  // Render Daftar Pemain (Leaderboard Kiri)
  renderPlayersList(state.players, state.settings.maxPlayers);

  // Tampilkan / Sembunyikan Toolbar Drawer & Kunci Kanvas
  const toolbar = document.getElementById('drawerToolbar');
  toolbar.style.display = (state.state === 'drawing' && amIDrawer) ? 'flex' : 'none';
  canvas.classList.toggle('locked', !(state.state === 'drawing' && amIDrawer));

  // Atur Input Chat
  const guessInput = document.getElementById('guessInput');
  const me = state.players.find(p => p.id === socket.id);
  if (state.state === 'drawing' && amIDrawer) {
    guessInput.placeholder = 'Kamu sedang menggambar...';
  } else if (state.state === 'drawing' && me?.guessed) {
    guessInput.placeholder = '✅ Kamu sudah berhasil menebak!';
  } else {
    guessInput.placeholder = 'Ketik tebakanmu di sini...';
  }

  // Tampilkan Overlay sesuai State
  const overlays = {
    lobby: document.getElementById('overlay-lobby'),
    chooseDrawer: document.getElementById('overlay-choose-drawer'),
    chooseGuesser: document.getElementById('overlay-choose-guesser'),
    reveal: document.getElementById('overlay-reveal'),
    podium: document.getElementById('overlay-podium')
  };
  Object.values(overlays).forEach(el => el.classList.remove('show'));

  if (state.state === 'lobby') {
    overlays.lobby.classList.add('show');
  } else if (state.state === 'choosing_word') {
    if (amIDrawer) {
      overlays.chooseDrawer.classList.add('show');
    } else {
      document.getElementById('choosingDrawerName').textContent = state.currentDrawerName;
      overlays.chooseGuesser.classList.add('show');
    }
  } else if (state.state === 'turn_reveal') {
    renderTurnReveal(state);
    overlays.reveal.classList.add('show');
  } else if (state.state === 'game_over') {
    renderFinalPodium(state, amIHost);
    overlays.podium.classList.add('show');
  }
});

// Terima Kata Rahasia Khusus untuk Drawer
socket.on('drawer:secret_word', (secretWord) => {
  mySecretWord = secretWord;
  if (currentRoomState?.state === 'drawing' && currentRoomState?.currentDrawerId === socket.id) {
    document.getElementById('wordRoleLabel').textContent = 'KATA YANG HARUS KAMU GAMBAR';
    document.getElementById('wordDisplay').textContent = secretWord;
  }
});

// Terima 3 Pilihan Kata untuk Drawer
socket.on('word:choices', (choices) => {
  const container = document.getElementById('wordChoicesContainer');
  container.innerHTML = '';
  (choices || []).forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'word-choice-btn';
    btn.innerHTML = `
      <span class="word-choice-text">${escapeHtml(item.word)}</span>
      <span class="word-diff diff-${item.difficulty}">${item.difficulty} • ${item.letterCount} Huruf</span>
    `;
    btn.onclick = () => {
      mySecretWord = item.word;
      socket.emit('word:select', item.word);
    };
    container.appendChild(btn);
  });
});

// Update Detik Timer
socket.on('room:timer', (timeLeft) => {
  if (currentRoomState) currentRoomState.timeLeft = timeLeft;
  updateTimerUI(timeLeft);
  if (timeLeft <= 8 && timeLeft > 0 && currentRoomState?.state === 'drawing') {
    playSoundEffect('tick');
  }
});

function updateTimerUI(seconds) {
  const badge = document.getElementById('timerBadge');
  const val = document.getElementById('timerValue');
  val.textContent = `${Math.max(0, seconds || 0)}s`;
  badge.classList.toggle('danger', seconds > 0 && seconds <= 10);
}

function renderShuffleQueue(queueStatus = []) {
  const container = document.getElementById('queueContainer');
  container.innerHTML = '';
  queueStatus.forEach((q, idx) => {
    const chip = document.createElement('div');
    chip.className = `q-chip ${q.status}`;
    let icon = '⏳';
    if (q.status === 'done') icon = '✓';
    else if (q.status === 'current') icon = '✏️';
    chip.innerHTML = `<span>${icon}</span><span>${idx + 1}. ${escapeHtml(q.name)}</span>`;
    container.appendChild(chip);
  });
}

function renderPlayersList(players = [], maxPlayers = 10) {
  document.getElementById('playerCountHeader').textContent = `👥 Pemain (${players.length}/${maxPlayers})`;
  const listEl = document.getElementById('playerList');
  listEl.innerHTML = '';

  const sorted = [...players].sort((a, b) => b.score - a.score);
  sorted.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = `player-row ${p.isDrawer ? 'is-drawer' : ''} ${p.guessed && !p.isDrawer ? 'has-guessed' : ''}`;
    const isMe = p.id === socket.id ? ' (Kamu)' : '';
    const hostCrown = p.isHost ? '👑 ' : '';
    const statusIcon = p.isDrawer ? '✏️' : (p.guessed ? '✅' : '💭');

    row.innerHTML = `
      <div class="player-left">
        <span class="rank-num">#${idx + 1}</span>
        <div class="avatar" style="background:${p.color}">${escapeHtml(p.name.charAt(0).toUpperCase())}</div>
        <div class="player-meta">
          <span class="player-name">${hostCrown}${escapeHtml(p.name)}${isMe}</span>
          <span class="player-score">${p.score} poin</span>
        </div>
      </div>
      <span style="font-size:16px;">${statusIcon}</span>
    `;
    listEl.appendChild(row);
  });
}

function renderTurnReveal(state) {
  document.getElementById('revealAnswerWord').textContent = state.revealedWord || '-';
  const list = document.getElementById('revealScoresList');
  list.innerHTML = '';

  const sortedByGain = [...state.players].sort((a, b) => b.turnGain - a.turnGain);
  sortedByGain.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'reveal-row';
    const roleTag = p.id === state.currentDrawerId ? ' 🎨 (Pelukis)' : '';
    const gainText = p.turnGain > 0 ? `+${p.turnGain} pts` : '+0 pts';
    row.innerHTML = `
      <span>${escapeHtml(p.name)}${roleTag}</span>
      <span class="${p.turnGain > 0 ? 'score-gain' : ''}">${gainText}</span>
    `;
    list.appendChild(row);
  });
}

function renderFinalPodium(state, amIHost) {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const first = sorted[0];
  const second = sorted[1];
  const third = sorted[2];

  const pod = document.getElementById('podiumContainer');
  pod.innerHTML = '';

  if (second) {
    pod.innerHTML += `
      <div class="podium-col">
        <div style="font-weight:700; margin-bottom:6px;">🥈 ${escapeHtml(second.name)}</div>
        <div class="podium-bar podium-2">
          <span style="font-size:22px;">#2</span>
          <span style="font-size:12px;">${second.score} pts</span>
        </div>
      </div>
    `;
  }
  if (first) {
    pod.innerHTML += `
      <div class="podium-col">
        <div style="font-weight:700; margin-bottom:6px; color:#fbbf24;">👑 ${escapeHtml(first.name)}</div>
        <div class="podium-bar podium-1">
          <span style="font-size:26px;">#1</span>
          <span style="font-size:13px;">${first.score} pts</span>
        </div>
      </div>
    `;
  }
  if (third) {
    pod.innerHTML += `
      <div class="podium-col">
        <div style="font-weight:700; margin-bottom:6px;">🥉 ${escapeHtml(third.name)}</div>
        <div class="podium-bar podium-3">
          <span style="font-size:20px;">#3</span>
          <span style="font-size:12px;">${third.score} pts</span>
        </div>
      </div>
    `;
  }

  const btnAgain = document.getElementById('btnPlayAgain');
  btnAgain.style.display = amIHost ? 'inline-block' : 'none';
}

// ==========================================
// TOMBOL AKSI ROOM & LIVE CHAT
// ==========================================
document.getElementById('btnStartGame').addEventListener('click', () => {
  socket.emit('game:start', null, (res) => {
    if (res && !res.ok) {
      addChatMessage({ type: 'system-close', text: `⚠️ ${res.error}` });
    }
  });
});

document.getElementById('btnPlayAgain').addEventListener('click', () => {
  socket.emit('game:restart');
});

function copyRoomInviteLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    addChatMessage({
      type: 'system-info',
      text: `📋 Link undangan room berhasil disalin: ${url}`
    });
  });
}

document.getElementById('btnInviteLink').addEventListener('click', copyRoomInviteLink);
document.getElementById('btnCopyInviteLobby').addEventListener('click', copyRoomInviteLink);

document.getElementById('btnSoundToggle').addEventListener('click', (e) => {
  soundEnabled = !soundEnabled;
  e.currentTarget.textContent = soundEnabled ? '🔊' : '🔇';
});

document.getElementById('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('guessInput');
  const val = input.value.trim();
  if (!val) return;
  input.value = '';
  socket.emit('chat:send', val);
});

socket.on('chat:message', (msg) => {
  addChatMessage(msg);
  if (msg.sound) playSoundEffect(msg.sound);
});

function addChatMessage(msg) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  if (msg.type === 'normal') {
    div.className = 'chat-item';
    div.innerHTML = `<strong style="color:${msg.color || '#0f172a'}">${escapeHtml(msg.sender)}:</strong> ${escapeHtml(msg.text)}`;
  } else {
    div.className = `chat-item ${msg.type || 'system-info'}`;
    div.textContent = msg.text;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
