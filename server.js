const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CATEGORIES = ['nome', 'cor', 'animal', 'fruta'];
const MAX_PLAYERS = 10;
const ROUND_MAX_MS = 60000;
const FREEZE_GRACE_MS = 1000;
const CHALLENGE_VOTE_MS = 10000;
const LETTERS = 'ABCDEFGHIJLMNOPQRSTU'.split('');

const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function roomPublicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    letter: room.letter,
    categories: CATEGORIES,
    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score, connected: !!p.ws })),
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(player, msg) {
  if (player.ws && player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function broadcastState(room) {
  broadcast(room, { type: 'room_state', room: roomPublicState(room) });
}

function startRound(room) {
  room.phase = 'playing';
  room.letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  room.answers = {};
  room.frozen = false;
  room.freezeDeadline = null;
  for (const p of room.players) room.answers[p.id] = {};

  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => finalizeRound(room, null), ROUND_MAX_MS);

  broadcast(room, {
    type: 'round_start',
    letter: room.letter,
    categories: CATEGORIES,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    maxMs: ROUND_MAX_MS,
  });
}

function scoreRound(room) {
  const perCategory = {};
  for (const cat of CATEGORIES) {
    const entries = room.players.map(p => {
      const raw = (room.answers[p.id] && room.answers[p.id][cat]) || '';
      const val = raw.trim();
      const valid = val.length > 0 && val[0].toLocaleUpperCase('pt-BR') === room.letter;
      return { playerId: p.id, nickname: p.nickname, value: val, valid };
    });
    const normalizedCounts = {};
    for (const e of entries) {
      if (!e.valid) continue;
      const key = e.value.toLocaleLowerCase('pt-BR');
      normalizedCounts[key] = (normalizedCounts[key] || 0) + 1;
    }
    perCategory[cat] = entries.map(e => {
      let points = 0;
      if (e.valid) {
        const key = e.value.toLocaleLowerCase('pt-BR');
        points = normalizedCounts[key] > 1 ? 5 : 10;
      }
      return { ...e, points };
    });
  }

  const roundTotals = {};
  for (const p of room.players) roundTotals[p.id] = 0;
  for (const cat of CATEGORIES) {
    for (const e of perCategory[cat]) roundTotals[e.playerId] += e.points;
  }
  for (const p of room.players) p.score += roundTotals[p.id];

  return { perCategory, roundTotals };
}

function finalizeRound(room, stoppedByPlayerId) {
  if (room.phase !== 'playing') return;
  clearTimeout(room.roundTimer);
  room.phase = 'results';

  const { perCategory, roundTotals } = scoreRound(room);
  const stopper = room.players.find(p => p.id === stoppedByPlayerId);

  room.lastResults = { perCategory, roundTotals };
  room.activeChallenge = null;
  clearTimeout(room.challengeTimer);

  broadcast(room, {
    type: 'round_results',
    stoppedBy: stopper ? stopper.nickname : null,
    letter: room.letter,
    perCategory,
    roundTotals,
    leaderboard: room.players
      .map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
      .sort((a, b) => b.score - a.score),
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
  });
}

function resolveChallenge(room) {
  const ch = room.activeChallenge;
  if (!ch) return;
  clearTimeout(room.challengeTimer);

  const votes = Object.values(ch.votes);
  const invalidos = votes.filter(v => v === false).length;
  const validos = votes.filter(v => v === true).length;
  const derrubado = invalidos > validos;

  if (derrubado) {
    const player = room.players.find(p => p.id === ch.targetPlayerId);
    if (player) player.score -= ch.entry.points;
    const entry = room.lastResults.perCategory[ch.category].find(e => e.playerId === ch.targetPlayerId);
    if (entry) entry.points = 0;
  }

  broadcast(room, {
    type: 'challenge_result',
    category: ch.category,
    targetPlayerId: ch.targetPlayerId,
    derrubado,
    votosValidos: validos,
    votosInvalidos: invalidos,
    leaderboard: room.players
      .map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
      .sort((a, b) => b.score - a.score),
  });

  room.activeChallenge = null;
}

function nextRoundOrEnd(room) {
  room.activeChallenge = null;
  clearTimeout(room.challengeTimer);
  if (room.currentRound >= room.totalRounds) {
    room.phase = 'podium';
    broadcast(room, {
      type: 'game_over',
      leaderboard: room.players
        .map(p => ({ id: p.id, nickname: p.nickname, score: p.score }))
        .sort((a, b) => b.score - a.score),
    });
  } else {
    room.currentRound += 1;
    startRound(room);
  }
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create_room') {
      const code = genCode();
      const player = { id: ws.id, nickname: (msg.nickname || 'Jogador').slice(0, 16), ws, score: 0 };
      const room = {
        code,
        hostId: player.id,
        phase: 'lobby',
        totalRounds: 7,
        currentRound: 0,
        letter: null,
        answers: {},
        frozen: false,
        players: [player],
        roundTimer: null,
        lastResults: null,
        activeChallenge: null,
        challengeTimer: null,
      };
      rooms.set(code, room);
      ws.roomCode = code;
      sendTo(player, { type: 'joined', you: player.id, room: roomPublicState(room) });
      broadcastState(room);
      return;
    }

    if (msg.type === 'join_room') {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) return sendTo({ ws }, { type: 'error', message: 'Sala não encontrada.' });
      if (room.phase !== 'lobby') return sendTo({ ws }, { type: 'error', message: 'Essa partida já começou.' });
      if (room.players.length >= MAX_PLAYERS) return sendTo({ ws }, { type: 'error', message: 'Sala cheia (máximo 10).' });
      const player = { id: ws.id, nickname: (msg.nickname || 'Jogador').slice(0, 16), ws, score: 0 };
      room.players.push(player);
      ws.roomCode = room.code;
      sendTo(player, { type: 'joined', you: player.id, room: roomPublicState(room) });
      broadcastState(room);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (msg.type === 'set_rounds' && ws.id === room.hostId && room.phase === 'lobby') {
      const n = parseInt(msg.rounds, 10);
      if (n >= 5 && n <= 10) room.totalRounds = n;
      broadcastState(room);
      return;
    }

    if (msg.type === 'start_game' && ws.id === room.hostId && room.phase === 'lobby') {
      if (room.players.length < 2) {
        const player = room.players.find(p => p.id === ws.id);
        if (player) sendTo(player, { type: 'error', message: 'Precisa de pelo menos 2 jogadores pra começar.' });
        return;
      }
      room.currentRound = 1;
      startRound(room);
      return;
    }

    if (msg.type === 'draft' && room.phase === 'playing') {
      room.answers[ws.id] = room.answers[ws.id] || {};
      room.answers[ws.id][msg.category] = msg.value;
      return;
    }

    if (msg.type === 'parei' && room.phase === 'playing' && !room.frozen) {
      room.frozen = true;
      room.answers[ws.id] = { ...(room.answers[ws.id] || {}), ...(msg.answers || {}) };
      const stopper = room.players.find(p => p.id === ws.id);
      broadcast(room, { type: 'frozen', by: stopper ? stopper.nickname : 'alguém', graceMs: FREEZE_GRACE_MS });
      setTimeout(() => finalizeRound(room, ws.id), FREEZE_GRACE_MS);
      return;
    }

    if (msg.type === 'submit_final' && room.phase === 'playing' && room.frozen) {
      room.answers[ws.id] = { ...(room.answers[ws.id] || {}), ...(msg.answers || {}) };
      return;
    }

    if (msg.type === 'challenge' && room.phase === 'results' && !room.activeChallenge) {
      const { category, targetPlayerId } = msg;
      const catResults = room.lastResults && room.lastResults.perCategory[category];
      if (!catResults) return;
      const entry = catResults.find(e => e.playerId === targetPlayerId);
      if (!entry || entry.points === 0 || targetPlayerId === ws.id) return;
      const challenger = room.players.find(p => p.id === ws.id);
      room.activeChallenge = {
        category,
        targetPlayerId,
        entry,
        votes: {},
        raisedBy: challenger ? challenger.nickname : 'alguém',
      };
      broadcast(room, {
        type: 'challenge_open',
        category,
        targetPlayerId,
        targetNickname: entry.nickname,
        value: entry.value,
        raisedBy: room.activeChallenge.raisedBy,
        voteMs: CHALLENGE_VOTE_MS,
      });
      clearTimeout(room.challengeTimer);
      room.challengeTimer = setTimeout(() => resolveChallenge(room), CHALLENGE_VOTE_MS);
      return;
    }

    if (msg.type === 'vote_challenge' && room.activeChallenge && ws.id !== room.activeChallenge.targetPlayerId) {
      room.activeChallenge.votes[ws.id] = !!msg.valid;
      return;
    }

    if (msg.type === 'next_round' && ws.id === room.hostId && room.phase === 'results') {
      nextRoundOrEnd(room);
      return;
    }

    if (msg.type === 'play_again' && ws.id === room.hostId && room.phase === 'podium') {
      room.phase = 'lobby';
      room.currentRound = 0;
      for (const p of room.players) p.score = 0;
      broadcastState(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === ws.id);
    if (idx === -1) return;
    room.players[idx].ws = null;
    if (room.hostId === ws.id) {
      const nextHost = room.players.find(p => p.ws);
      if (nextHost) room.hostId = nextHost.id;
    }
    room.players = room.players.filter(p => p.ws || room.phase !== 'lobby');
    if (room.players.length === 0) {
      clearTimeout(room.roundTimer);
      rooms.delete(room.code);
      return;
    }
    broadcastState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Parou, vei! rodando em http://localhost:${PORT}`);
});
