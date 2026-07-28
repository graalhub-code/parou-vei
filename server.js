const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CATEGORY_POOL = [
  'Nome', 'Cor', 'Animal', 'Fruta', 'Objeto', 'Profissão', 'País', 'Filme',
  'Marca', 'Comida', 'Esporte', 'Cantor ou banda', 'Personagem', 'Roupa',
  'Instrumento musical', 'Time de futebol', 'Sobrenome', 'Cidade', 'Bebida', 'Verbo',
];
const BAHIA_CATEGORY_POOL = [
  'Gíria baiana', 'Comida baiana', 'Ponto turístico da Bahia', 'Cantor ou banda baiano',
  'Bloco de carnaval', 'Expressão baiana', 'Praia baiana', 'Prato típico baiano',
];
const CATEGORIES_PER_ROUND = 4;
const MAX_PLAYERS = 10;
const ROUND_MAX_MS = 60000;
const FREEZE_GRACE_MS = 1000;
const DEFAULT_VOTE_MS = 10000;
const VOTE_DURATION_OPTIONS = [5000, 10000, 15000, 20000];
const TIEBREAK_MS = 20000;
const LETTERS = 'ABCDEFGHIJLMNOPQRSTU'.split('');

const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function capitalizeFirst(text) {
  if (!text) return text;
  return text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1);
}

function pickRoundCategories(room, count = CATEGORIES_PER_ROUND) {
  if (room.remainingCategories.length < count) {
    room.remainingCategories = [...CATEGORY_POOL];
  }
  const pool = [...room.remainingCategories];
  const picked = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  room.remainingCategories = room.remainingCategories.filter(c => !picked.includes(c));
  return picked;
}

function pickBahiaRoundNumbers(totalRounds) {
  if (totalRounds <= 2) return [];
  const quantidade = Math.min(totalRounds - 2, Math.max(2, Math.ceil(totalRounds / 3)));
  const candidatos = [];
  for (let r = 2; r <= totalRounds - 1; r++) candidatos.push(r);
  const escolhidas = [];
  for (let i = 0; i < quantidade && candidatos.length > 0; i++) {
    const idx = Math.floor(Math.random() * candidatos.length);
    escolhidas.push(candidatos[idx]);
    candidatos.splice(idx, 1);
  }
  return escolhidas;
}

function pickRandomCategories(pool, count) {
  const copy = [...pool];
  const picked = [];
  for (let i = 0; i < count && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return picked;
}

function buildLeaderboard(room) {
  const order = room.tiebreakOrder || [];
  return room.players
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return 0;
    })
    .map(p => ({ id: p.id, nickname: p.nickname, score: p.score }));
}

function roomPublicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    letter: room.letter,
    categories: room.currentCategories || [],
    bahiaCategory: room.currentBahiaCategory || null,
    voteDurationMs: room.voteDurationMs,
    tiebreakEnabled: room.tiebreakEnabled,
    bahiaEnabled: room.bahiaEnabled,
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
  const isBahia = room.bahiaEnabled && (room.bahiaRoundNumbers || []).includes(room.currentRound);
  room.isBahiaRound = isBahia;
  let bahiaCategory = null;
  if (isBahia) {
    const normais = pickRoundCategories(room, CATEGORIES_PER_ROUND - 1);
    bahiaCategory = pickRandomCategories(BAHIA_CATEGORY_POOL, 1)[0];
    const posicao = Math.floor(Math.random() * (normais.length + 1));
    normais.splice(posicao, 0, bahiaCategory);
    room.currentCategories = normais;
  } else {
    room.currentCategories = pickRoundCategories(room);
  }
  room.currentBahiaCategory = bahiaCategory;
  room.answers = {};
  room.frozen = false;
  room.freezeDeadline = null;
  for (const p of room.players) room.answers[p.id] = {};

  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => finalizeRound(room, null), ROUND_MAX_MS);

  broadcast(room, {
    type: 'round_start',
    letter: room.letter,
    categories: room.currentCategories,
    bahiaCategory,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    maxMs: ROUND_MAX_MS,
    isBahia,
  });
}

function scoreRound(room) {
  const perCategory = {};
  for (const cat of room.currentCategories) {
    const entries = room.players.map(p => {
      const raw = (room.answers[p.id] && room.answers[p.id][cat]) || '';
      const val = raw.trim();
      const valid = val.length > 0 && val[0].toLocaleUpperCase('pt-BR') === room.letter;
      return { playerId: p.id, nickname: p.nickname, value: capitalizeFirst(val), valid };
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
  for (const cat of room.currentCategories) {
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
    leaderboard: buildLeaderboard(room),
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
    leaderboard: buildLeaderboard(room),
  });

  room.activeChallenge = null;
}

function checkForTieOrEnd(room) {
  const sorted = room.players.slice().sort((a, b) => b.score - a.score);
  const topScore = sorted.length ? sorted[0].score : 0;
  const tied = sorted.filter(p => p.score === topScore);

  if (tied.length > 1 && room.tiebreakEnabled && !room.tiebreakDone) {
    startTiebreak(room, tied.map(p => p.id));
    return;
  }

  room.phase = 'podium';
  broadcast(room, { type: 'game_over', leaderboard: buildLeaderboard(room) });
}

function startTiebreak(room, tiedIds) {
  room.phase = 'tiebreak';
  room.tiebreakPlayers = tiedIds;
  room.tiebreakLetter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  room.tiebreakCategory = CATEGORY_POOL[Math.floor(Math.random() * CATEGORY_POOL.length)];
  room.tiebreakAnswers = {};

  clearTimeout(room.tiebreakTimer);
  room.tiebreakTimer = setTimeout(() => resolveTiebreak(room), TIEBREAK_MS);

  broadcast(room, {
    type: 'tiebreak_start',
    category: room.tiebreakCategory,
    letter: room.tiebreakLetter,
    playerIds: tiedIds,
    players: room.players.filter(p => tiedIds.includes(p.id)).map(p => p.nickname),
    maxMs: TIEBREAK_MS,
  });
}

function resolveTiebreak(room) {
  clearTimeout(room.tiebreakTimer);
  const entries = room.tiebreakPlayers.map(id => {
    const p = room.players.find(pp => pp.id === id);
    const a = room.tiebreakAnswers[id];
    const val = (a && a.value || '').trim();
    const valid = val.length > 0 && val[0].toLocaleUpperCase('pt-BR') === room.tiebreakLetter;
    return {
      id,
      nickname: p ? p.nickname : 'Jogador',
      value: capitalizeFirst(val),
      valid,
      submittedAt: a ? a.submittedAt : Infinity,
    };
  });
  entries.sort((x, y) => {
    if (x.valid !== y.valid) return x.valid ? -1 : 1;
    return x.submittedAt - y.submittedAt;
  });

  room.tiebreakDone = true;
  room.tiebreakOrder = entries.map(e => e.id);

  broadcast(room, {
    type: 'tiebreak_result',
    category: room.tiebreakCategory,
    letter: room.tiebreakLetter,
    entries,
    winnerId: entries.length ? entries[0].id : null,
  });

  room.phase = 'podium';
  broadcast(room, { type: 'game_over', leaderboard: buildLeaderboard(room) });
}

function nextRoundOrEnd(room) {
  room.activeChallenge = null;
  clearTimeout(room.challengeTimer);
  if (room.currentRound >= room.totalRounds) {
    checkForTieOrEnd(room);
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
      const player = { id: ws.id, nickname: capitalizeFirst((msg.nickname || 'Jogador').slice(0, 16).trim()), ws, score: 0 };
      const room = {
        code,
        hostId: player.id,
        phase: 'lobby',
        totalRounds: 7,
        currentRound: 0,
        letter: null,
        currentCategories: [],
        currentBahiaCategory: null,
        remainingCategories: [...CATEGORY_POOL],
        answers: {},
        frozen: false,
        players: [player],
        roundTimer: null,
        lastResults: null,
        activeChallenge: null,
        challengeTimer: null,
        voteDurationMs: DEFAULT_VOTE_MS,
        tiebreakEnabled: true,
        bahiaEnabled: false,
        bahiaRoundNumbers: [],
        isBahiaRound: false,
        tiebreakDone: false,
        tiebreakOrder: null,
        tiebreakPlayers: [],
        tiebreakTimer: null,
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
      const player = { id: ws.id, nickname: capitalizeFirst((msg.nickname || 'Jogador').slice(0, 16).trim()), ws, score: 0 };
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

    if (msg.type === 'set_vote_duration' && ws.id === room.hostId && room.phase === 'lobby') {
      const ms = parseInt(msg.voteDurationMs, 10);
      if (VOTE_DURATION_OPTIONS.includes(ms)) room.voteDurationMs = ms;
      broadcastState(room);
      return;
    }

    if (msg.type === 'set_tiebreak' && ws.id === room.hostId && room.phase === 'lobby') {
      room.tiebreakEnabled = !!msg.enabled;
      broadcastState(room);
      return;
    }

    if (msg.type === 'set_bahia' && ws.id === room.hostId && room.phase === 'lobby') {
      room.bahiaEnabled = !!msg.enabled;
      broadcastState(room);
      return;
    }

    if (msg.type === 'set_room_code' && ws.id === room.hostId && room.phase === 'lobby') {
      const newCode = (msg.code || '').toUpperCase().trim();
      if (!/^[A-Z0-9]{4,8}$/.test(newCode)) {
        const player = room.players.find(p => p.id === ws.id);
        if (player) sendTo(player, { type: 'error', message: 'Código inválido. Use de 4 a 8 letras ou números.' });
        return;
      }
      if (newCode !== room.code && rooms.has(newCode)) {
        const player = room.players.find(p => p.id === ws.id);
        if (player) sendTo(player, { type: 'error', message: 'Esse código já está em uso.' });
        return;
      }
      if (newCode !== room.code) {
        rooms.delete(room.code);
        room.code = newCode;
        rooms.set(newCode, room);
        for (const p of room.players) {
          if (p.ws) p.ws.roomCode = newCode;
        }
      }
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
      room.tiebreakDone = false;
      room.tiebreakOrder = null;
      room.bahiaRoundNumbers = room.bahiaEnabled ? pickBahiaRoundNumbers(room.totalRounds) : [];
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
        voteMs: room.voteDurationMs,
      });
      clearTimeout(room.challengeTimer);
      room.challengeTimer = setTimeout(() => resolveChallenge(room), room.voteDurationMs);
      return;
    }

    if (msg.type === 'vote_challenge' && room.activeChallenge && ws.id !== room.activeChallenge.targetPlayerId) {
      room.activeChallenge.votes[ws.id] = !!msg.valid;
      return;
    }

    if (msg.type === 'tiebreak_answer' && room.phase === 'tiebreak' && room.tiebreakPlayers.includes(ws.id)) {
      if (room.tiebreakAnswers[ws.id]) return;
      room.tiebreakAnswers[ws.id] = { value: msg.value || '', submittedAt: Date.now() };
      if (room.tiebreakPlayers.every(id => room.tiebreakAnswers[id])) {
        resolveTiebreak(room);
      }
      return;
    }

    if (msg.type === 'next_round' && ws.id === room.hostId && room.phase === 'results') {
      nextRoundOrEnd(room);
      return;
    }

    if (msg.type === 'play_again' && ws.id === room.hostId && room.phase === 'podium') {
      room.phase = 'lobby';
      room.currentRound = 0;
      room.currentCategories = [];
      room.remainingCategories = [...CATEGORY_POOL];
      room.tiebreakDone = false;
      room.tiebreakOrder = null;
      room.tiebreakPlayers = [];
      room.bahiaRoundNumbers = [];
      room.isBahiaRound = false;
      room.currentBahiaCategory = null;
      for (const p of room.players) p.score = 0;
      broadcastState(room);
      return;
    }

    if (msg.type === 'leave_room') {
      const idx = room.players.findIndex(p => p.id === ws.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.hostId === ws.id) {
          const nextHost = room.players.find(p => p.ws);
          if (nextHost) room.hostId = nextHost.id;
        }
      }
      ws.roomCode = null;
      if (room.players.length === 0) {
        clearTimeout(room.roundTimer);
        clearTimeout(room.challengeTimer);
        clearTimeout(room.tiebreakTimer);
        rooms.delete(room.code);
      } else {
        broadcastState(room);
      }
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
