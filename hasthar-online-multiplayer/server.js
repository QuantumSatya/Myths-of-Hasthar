const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const LOG_FILE = path.join(__dirname, 'game_log.json');

/* ===================== GAME LOG (persisted to disk) ===================== */
let gameLog = [];
try { gameLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { gameLog = []; }
function saveLog() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(gameLog, null, 2)); } catch (e) { console.error('log save failed', e); }
}
function recordGameResult(room) {
  const g = room.game;
  const entry = {
    timestamp: new Date().toISOString(),
    numPlayers: g.numPlayers,
    hasthar: g.setupCounts.Hasthar,
    burglar: g.setupCounts.Burglar,
    goddess: g.setupCounts.Devi,
    sacredLine: g.setupCounts.SacredLine,
    dollsPerPlayer: g.startingDolls,
    turns: g.turnCount,
    winner: g.winner,
    winnerGold: g.winner === 'NONE' ? 0 : g.gold[g.winner]
  };
  gameLog.push(entry);
  saveLog();
}

/* ===================== ROOM / LOBBY STATE ===================== */
// Single room per server instance — one game at a time, which fits "play in the same room" use case.
const room = {
  seats: [],          // array of { token, name, ws } in join order, seat name = `Player ${index+1}`
  hostToken: null,
  config: null,        // { numPlayers, counts, startingDolls } chosen by host
  phase: 'lobby',       // lobby | playing
  game: null
};

function seatName(i) { return `Player ${i + 1}`; }

function broadcastLobby() {
  const payload = {
    type: 'lobby',
    phase: room.phase,
    players: room.seats.map((s, i) => ({ seat: seatName(i), name: s.name })),
    config: room.config
  };
  room.seats.forEach((s, i) => {
    sendTo(s.ws, { ...payload, youAre: seatName(i), isHost: s.token === room.hostToken });
  });
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/* ===================== GAME ENGINE (ported from the single-player build) ===================== */
function freshDeck(counts) {
  let deck = [];
  for (const [card, n] of Object.entries(counts)) for (let i = 0; i < n; i++) deck.push(card);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function startGame() {
  const players = room.seats.map((_, i) => seatName(i));
  const numPlayers = players.length;
  const counts = room.config.counts;
  const deck = freshDeck(counts);
  const handSize = Math.floor(deck.length / numPlayers);
  const hands = {};
  players.forEach(p => hands[p] = deck.splice(0, handSize));
  const leftoverToDiscard = deck.splice(0);
  const startingDolls = room.config.startingDolls;

  room.game = {
    players,
    numPlayers,
    hands,
    dolls: Object.fromEntries(players.map(p => [p, startingDolls])),
    gold: Object.fromEntries(players.map(p => [p, 0])),
    status: Object.fromEntries(players.map(p => [p, 'active'])),
    discard: leftoverToDiscard,
    turnIndex: 0,
    turnCount: 0,
    setupCounts: counts,
    startingDolls,
    winner: null,
    log: []
  };
  room.phase = 'playing';
  logMsg(`— New game. ${numPlayers} real players seated. Greed Deck: ${counts.Hasthar} Hasthar, ${counts.Burglar} Burglar, ${counts.Devi} Goddess, ${counts.SacredLine} Sacred Line, ${startingDolls} Flour Doll(s) each. —`, true);
}

function logMsg(msg, marker = false) { room.game.log.push({ msg, marker }); }
function g() { return room.game; }

function getNextActive(from) {
  const players = g().players;
  const idx = players.indexOf(from);
  for (let i = 1; i <= players.length; i++) {
    const cand = players[(idx + i) % players.length];
    if (g().status[cand] === 'active') return cand;
  }
  return null;
}
function giveGold(p, amt = 1) { g().gold[p] += amt; return amt; }
function giveDoll(p, amt = 1) { g().dolls[p] += amt; return amt; }
function removeCard(p, card) { const h = g().hands[p]; h.splice(h.indexOf(card), 1); }
function eliminate(p, killer) {
  g().status[p] = 'eliminated';
  if (killer) {
    g().gold[killer] += g().gold[p];
    logMsg(`${p} is ELIMINATED. Their ${g().gold[p]} Gold Coins pass to ${killer}.`);
    g().gold[p] = 0;
  } else {
    logMsg(`${p} is ELIMINATED.`);
  }
  g().discard.push(...g().hands[p]);
  g().hands[p] = [];
}

function playHasthar(attacker, target) {
  removeCard(attacker, 'Hasthar'); g().discard.push('Hasthar');
  logMsg(`${attacker} plays HASTHAR on ${target}.`);
  resolveHastharAttack(target, attacker);
}
function resolveHastharAttack(target, attacker) {
  if (g().hands[target].includes('SacredLine')) {
    removeCard(target, 'SacredLine'); g().discard.push('SacredLine');
    logMsg(`${target} holds a SACRED LINE — compulsorily used! The attack is extinguished. No Gold Coin, no Flour Doll lost.`);
    return;
  }
  if (g().hands[target].includes('Devi')) {
    removeCard(target, 'Devi'); g().discard.push('Devi');
    const d = giveDoll(target, 1), gg = giveGold(target, 1);
    logMsg(`${target} reveals the GODDESS — the attack is neutralized without losing any Flour Doll! Gains +${d} Flour Doll +${gg} Gold Coin.`);
    return;
  }
  if (g().dolls[target] >= 1) {
    g().dolls[target] -= 1;
    const gg = giveGold(attacker, 1);
    logMsg(`${target} sacrifices 1 Flour Doll. ${attacker} receives ${gg} Gold Coin.`);
    return;
  }
  eliminate(target, attacker);
}
function playBurglar(attacker, target, preferred) {
  removeCard(attacker, 'Burglar'); g().discard.push('Burglar');
  let resource = preferred;
  let pool = resource === 'gold' ? g().gold : g().dolls;
  let switched = false;
  if (pool[target] < 1) {
    resource = resource === 'gold' ? 'doll' : 'gold';
    pool = resource === 'gold' ? g().gold : g().dolls;
    switched = true;
  }
  const label = resource === 'gold' ? 'Gold Coin' : 'Flour Doll';
  logMsg(`${attacker} plays BURGLAR on ${target}${switched ? ` (had no ${preferred === 'gold' ? 'Gold Coin' : 'Flour Doll'}, so tries ${label} instead)` : ''}.`);
  if (pool[target] >= 1) {
    pool[target] -= 1; pool[attacker] += 1;
    logMsg(`Stolen: 1 ${label} moves from ${target} to ${attacker}.`);
  } else {
    logMsg(`${target} had nothing left to steal — turn wasted.`);
  }
}
function playDevi(p) {
  removeCard(p, 'Devi'); g().discard.push('Devi');
  const d = giveDoll(p, 1), gg = giveGold(p, 1);
  logMsg(`${p} plays GODDESS: +${d} Flour Doll +${gg} Gold Coin.`);
}
function needsRefill(p) {
  const h = g().hands[p];
  return h.length === 0 || h.every(c => c === 'SacredLine');
}
function refillHand(p) {
  const target = g().numPlayers + 1;
  let n = Math.min(target, g().discard.length);
  for (let i = 0; i < n; i++) {
    const j = Math.floor(Math.random() * g().discard.length);
    g().hands[p].push(g().discard.splice(j, 1)[0]);
  }
  if (n < target) logMsg(`Only ${n} card(s) were available in the discard pile — ${p} receives ${n} instead of ${target}.`);
  else logMsg(`${p} draws a fresh hand of ${target} cards from the discard pile.`);
}
function checkWinner() {
  const active = g().players.filter(p => g().status[p] === 'active');
  if (active.length <= 1 && !g().winner) {
    const survivors = g().players.filter(p => g().status[p] !== 'eliminated');
    if (survivors.length === 0) {
      logMsg('All players were eliminated — no winner.', true);
      g().winner = 'NONE';
      recordGameResult(room);
      return;
    }
    let best = survivors[0];
    survivors.forEach(p => { if (g().gold[p] > g().gold[best]) best = p; });
    g().winner = best;
    logMsg(`★ Game over. ${best} wins with ${g().gold[best]} Gold Coins! ★`, true);
    recordGameResult(room);
  }
}

// After any action resolves: handle refills, advance turn, stop and wait for the next real player.
function afterAction() {
  checkWinner();
  if (g().winner) return;

  g().players.forEach(p => {
    if (g().status[p] === 'active' && needsRefill(p) && g().discard.length > 0) {
      refillHand(p);
    }
  });

  checkWinner();
  if (g().winner) return;

  const cur = g().players[g().turnIndex];
  const next = getNextActive(cur);
  if (!next) return;
  g().turnIndex = g().players.indexOf(next);

  if (needsRefill(next)) {
    logMsg(`${next} has no usable cards and the discard pile is empty — turn skipped.`);
    afterAction();
  }
}

function applyAction(seat, msg) {
  const cur = g().players[g().turnIndex];
  if (g().winner) return { error: 'Game is over.' };
  if (seat !== cur) return { error: 'Not your turn.' };
  const hand = g().hands[seat];
  const { card, target, resource } = msg;
  if (!hand.includes(card)) return { error: 'You do not hold that card.' };

  if (card === 'Devi') {
    g().turnCount++;
    playDevi(seat);
  } else if (card === 'SacredLine') {
    g().turnCount++;
    removeCard(seat, 'SacredLine'); g().discard.push('SacredLine');
    logMsg(`${seat} discards a Sacred Line without using it — it only triggers automatically when attacked by Hasthar.`);
  } else if (card === 'Hasthar') {
    if (!target || g().status[target] !== 'active' || target === seat) return { error: 'Choose a valid target.' };
    g().turnCount++;
    playHasthar(seat, target);
  } else if (card === 'Burglar') {
    if (!target || g().status[target] !== 'active' || target === seat) return { error: 'Choose a valid target.' };
    if (resource !== 'gold' && resource !== 'doll') return { error: 'Choose gold or doll.' };
    g().turnCount++;
    playBurglar(seat, target, resource);
  } else {
    return { error: 'Unknown card.' };
  }
  afterAction();
  return { ok: true };
}

/* ===================== BROADCAST STATE ===================== */
function broadcastGameState() {
  room.seats.forEach((s, i) => {
    const seat = seatName(i);
    const publicPlayers = g().players.map(p => ({
      seat: p,
      dolls: p === seat ? g().dolls[p] : null,   // Flour Dolls are private — only ever sent to their own owner
      gold: g().gold[p],
      cards: g().hands[p].length,
      status: g().status[p]
    }));
    sendTo(s.ws, {
      type: 'gameState',
      players: publicPlayers,
      yourSeat: seat,
      yourHand: g().hands[seat] || [],
      currentTurn: g().players[g().turnIndex],
      discardCount: g().discard.length,
      turnCount: g().turnCount,
      winner: g().winner,
      log: g().log.slice(-40),
      isHost: s.token === room.hostToken
    });
  });
}

/* ===================== HTTP + WS SERVER ===================== */
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const STATIC_FILES = {
  '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json' },
  '/service-worker.js': { file: 'service-worker.js', type: 'application/javascript' },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
  '/icon-512-maskable.png': { file: 'icon-512-maskable.png', type: 'image/png' },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' }
};

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(indexHtml);
  } else if (req.url === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(gameLog));
  } else if (STATIC_FILES[req.url]) {
    const entry = STATIC_FILES[req.url];
    fs.readFile(path.join(__dirname, 'public', entry.file), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': entry.type });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let myToken = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join') {
      const token = msg.token || Math.random().toString(36).slice(2);
      myToken = token;
      let seatIdx = room.seats.findIndex(s => s.token === token);
      if (seatIdx === -1) {
        if (room.config && room.seats.length >= room.config.numPlayers) {
          sendTo(ws, { type: 'error', message: 'Room is full.' });
          return;
        }
        room.seats.push({ token, name: msg.name || `Player ${room.seats.length + 1}`, ws });
        seatIdx = room.seats.length - 1;
        if (room.seats.length === 1) room.hostToken = token;
      } else {
        room.seats[seatIdx].ws = ws; // reconnect
      }
      sendTo(ws, { type: 'joined', token, seat: seatName(seatIdx) });
      if (room.phase === 'lobby') {
        broadcastLobby();
      } else {
        broadcastGameState();
      }
      return;
    }

    const seatIdx = room.seats.findIndex(s => s.token === myToken);
    if (seatIdx === -1) return;
    const seat = seatName(seatIdx);
    const isHost = myToken === room.hostToken;

    if (msg.type === 'hostConfig' && isHost && room.phase === 'lobby') {
      room.config = {
        numPlayers: Math.max(2, Math.min(8, parseInt(msg.numPlayers, 10) || 3)),
        counts: {
          Hasthar: Math.max(0, parseInt(msg.counts.Hasthar, 10) || 0),
          Burglar: Math.max(0, parseInt(msg.counts.Burglar, 10) || 0),
          Devi: Math.max(0, parseInt(msg.counts.Devi, 10) || 0),
          SacredLine: Math.max(0, parseInt(msg.counts.SacredLine, 10) || 0)
        },
        startingDolls: Math.max(1, parseInt(msg.startingDolls, 10) || 2)
      };
      broadcastLobby();
      return;
    }

    if (msg.type === 'startGame' && isHost && room.phase === 'lobby') {
      if (!room.config) { sendTo(ws, { type: 'error', message: 'Set up the game first.' }); return; }
      if (room.seats.length !== room.config.numPlayers) {
        sendTo(ws, { type: 'error', message: `Waiting for ${room.config.numPlayers} players — ${room.seats.length} joined.` });
        return;
      }
      startGame();
      broadcastGameState();
      return;
    }

    if (msg.type === 'playCard' && room.phase === 'playing') {
      const result = applyAction(seat, msg);
      if (result.error) {
        sendTo(ws, { type: 'error', message: result.error });
      } else {
        broadcastGameState();
      }
      return;
    }

    if (msg.type === 'newGame' && isHost) {
      room.phase = 'lobby';
      room.game = null;
      broadcastLobby();
      return;
    }

    if (msg.type === 'getLog') {
      sendTo(ws, { type: 'gameLog', entries: gameLog });
      return;
    }
  });

  ws.on('close', () => {
    // keep the seat reserved (token-based) so a refresh/reconnect can reclaim it
  });
});

function localIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) results.push(net.address);
    }
  }
  return results;
}

server.listen(PORT, () => {
  console.log(`\nHasthar LAN server running.`);
  console.log(`On this computer, open:   http://localhost:${PORT}`);
  const ips = localIPs();
  if (ips.length) {
    console.log(`On other devices (same WiFi), open:`);
    ips.forEach(ip => console.log(`   http://${ip}:${PORT}`));
  } else {
    console.log(`Could not detect a LAN IP — check your WiFi connection.`);
  }
  console.log('');
});
