const el = (id) => document.getElementById(id);
const screens = ['entrada', 'lobby', 'jogo', 'resultado', 'podio'];
function showScreen(name) {
  for (const s of screens) el('screen-' + s).classList.toggle('active', s === name);
}

let ws;
let meId = null;
let currentRoom = null;
let countdownTimer = null;
let draftAnswers = {};

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    showToast('Conexão perdida. Recarregue a página.');
  };
}
connect();

function send(msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

let toastTimeout = null;
function showToast(texto) {
  const t = el('toast');
  t.textContent = texto;
  t.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.add('hidden'), 3500);
}

function handleMessage(msg) {
  if (msg.type === 'error') {
    showToast(msg.message);
    return;
  }
  if (msg.type === 'joined') {
    meId = msg.you;
    currentRoom = msg.room;
    renderLobby(currentRoom);
    showScreen('lobby');
    return;
  }
  if (msg.type === 'room_state') {
    currentRoom = msg.room;
    if (currentRoom.phase === 'lobby') renderLobby(currentRoom);
    return;
  }
  if (msg.type === 'round_start') {
    draftAnswers = {};
    renderRound(msg);
    showScreen('jogo');
    return;
  }
  if (msg.type === 'frozen') {
    el('banner-texto').textContent = msg.by + ' parou primeiro!';
    el('banner-parou').classList.remove('hidden');
    document.querySelectorAll('#campos-categorias input').forEach(i => i.disabled = true);
    el('btn-parei').disabled = true;
    send({ type: 'submit_final', answers: draftAnswers });
    return;
  }
  if (msg.type === 'round_results') {
    renderResultado(msg);
    showScreen('resultado');
    return;
  }
  if (msg.type === 'challenge_open') {
    abrirVotacao(msg);
    return;
  }
  if (msg.type === 'challenge_result') {
    aplicarResultadoVotacao(msg);
    return;
  }
  if (msg.type === 'game_over') {
    renderPodio(msg.leaderboard);
    showScreen('podio');
    return;
  }
}

// ---------- entrada ----------
el('btn-mostrar-entrar').onclick = () => {
  el('bloco-entrar-codigo').classList.remove('hidden');
};
el('btn-criar-sala').onclick = () => {
  const nick = el('input-nickname').value.trim();
  if (!nick) return showToast('Digite seu apelido.');
  send({ type: 'create_room', nickname: nick });
};
el('btn-entrar-sala').onclick = () => {
  const nick = el('input-nickname').value.trim();
  const code = el('input-codigo').value.trim().toUpperCase();
  if (!nick) return showToast('Digite seu apelido.');
  if (!code) return showToast('Digite o código da sala.');
  send({ type: 'join_room', nickname: nick, code });
};

// ---------- lobby ----------
function renderLobby(room) {
  el('lobby-codigo').textContent = room.code;
  el('lobby-contagem').textContent = `Jogadores (${room.players.length}/10)`;

  const lista = el('lista-jogadores');
  lista.innerHTML = '';
  for (const p of room.players) {
    const div = document.createElement('div');
    div.className = 'jogador-item';
    div.innerHTML = `<div class="avatar">${p.nickname.slice(0, 2).toUpperCase()}</div>
      <span class="jogador-nome">${p.nickname}${p.id === meId ? ' (você)' : ''}</span>
      ${p.id === room.hostId ? '<span class="crown">👑</span>' : ''}`;
    lista.appendChild(div);
  }

  const souHost = meId === room.hostId;
  el('config-host').classList.toggle('hidden', !souHost);
  el('btn-iniciar').classList.toggle('hidden', !souHost);
  el('lobby-espera').classList.toggle('hidden', souHost);

  if (souHost) {
    const chipsWrap = el('chips-rodadas');
    chipsWrap.innerHTML = '';
    [5, 6, 7, 8, 9, 10].forEach(n => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (n === room.totalRounds ? ' selected' : '');
      chip.textContent = n;
      chip.onclick = () => send({ type: 'set_rounds', rounds: n });
      chipsWrap.appendChild(chip);
    });
  }
}
el('btn-iniciar').onclick = () => {
  if (!currentRoom || currentRoom.players.length < 2) {
    return showToast('Precisa de pelo menos 2 jogadores pra começar.');
  }
  send({ type: 'start_game' });
};
el('btn-voltar-lobby').onclick = () => {
  location.reload();
};

// ---------- jogo ----------
function renderRound(msg) {
  el('jogo-rodada').textContent = `Rodada ${msg.currentRound}/${msg.totalRounds}`;
  el('jogo-letra').textContent = msg.letter;
  el('banner-parou').classList.add('hidden');
  el('btn-parei').disabled = false;

  const wrap = el('campos-categorias');
  wrap.innerHTML = '';
  for (const cat of msg.categories) {
    const item = document.createElement('div');
    item.className = 'campo-item';
    item.innerHTML = `<label>${cat}</label><input type="text" data-cat="${cat}" autocomplete="off" />`;
    wrap.appendChild(item);
    const input = item.querySelector('input');
    input.oninput = () => {
      draftAnswers[cat] = input.value;
      send({ type: 'draft', category: cat, value: input.value });
    };
  }

  let remaining = Math.floor(msg.maxMs / 1000);
  updateTimerDisplay(remaining);
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { clearInterval(countdownTimer); return; }
    updateTimerDisplay(remaining);
  }, 1000);
}
function updateTimerDisplay(seconds) {
  const t = el('jogo-timer');
  t.textContent = seconds + 's';
  t.classList.toggle('urgente', seconds <= 10);
}
el('btn-parei').onclick = () => {
  send({ type: 'parei', answers: draftAnswers });
};

// ---------- resultado ----------
function renderResultado(msg) {
  clearInterval(countdownTimer);
  const lista = el('resultado-lista');
  lista.innerHTML = '';
  for (const cat of Object.keys(msg.perCategory)) {
    const bloco = document.createElement('div');
    bloco.className = 'categoria-bloco';
    const linhas = msg.perCategory[cat].map(e => {
      const cls = e.points === 10 ? 'ok' : e.points === 5 ? 'dup' : 'zero';
      const valor = e.value || '(em branco)';
      const podeDuvidar = e.points > 0 && e.playerId !== meId;
      const btn = podeDuvidar
        ? `<button class="btn-duvidar" data-cat="${cat}" data-player="${e.playerId}">duvidar</button>`
        : '';
      return `<div class="resposta-linha ${cls}" data-cat="${cat}" data-player="${e.playerId}">
        <span>${e.nickname} — ${valor}${btn}</span><span class="pontos-valor">+${e.points}</span></div>`;
    }).join('');
    bloco.innerHTML = `<h3>${cat}</h3>${linhas}`;
    lista.appendChild(bloco);
  }

  lista.querySelectorAll('.btn-duvidar').forEach(btn => {
    btn.onclick = () => {
      send({ type: 'challenge', category: btn.dataset.cat, targetPlayerId: btn.dataset.player });
    };
  });

  const souHost = meId === currentRoom?.hostId;
  el('btn-proxima-rodada').classList.toggle('hidden', !souHost);
  el('resultado-espera').classList.toggle('hidden', souHost);
}
el('btn-proxima-rodada').onclick = () => send({ type: 'next_round' });

// ---------- votação de dúvida ----------
let votacaoInterval = null;

function abrirVotacao(msg) {
  el('votacao-titulo').textContent = `${msg.raisedBy} duvidou da resposta de ${msg.targetNickname}`;
  el('votacao-resposta').textContent = `${msg.targetNickname} — ${msg.value}`;
  el('votacao-status').textContent = '';
  el('overlay-votacao').classList.remove('hidden');

  const souAlvo = msg.targetPlayerId === meId;
  el('btn-voto-valido').classList.toggle('hidden', souAlvo);
  el('btn-voto-invalido').classList.toggle('hidden', souAlvo);
  if (souAlvo) el('votacao-status').textContent = 'Sua resposta está em votação. Aguarde.';

  let restante = Math.floor(msg.voteMs / 1000);
  el('votacao-timer').textContent = restante + 's';
  clearInterval(votacaoInterval);
  votacaoInterval = setInterval(() => {
    restante -= 1;
    if (restante < 0) { clearInterval(votacaoInterval); return; }
    el('votacao-timer').textContent = restante + 's';
  }, 1000);
}

el('btn-voto-valido').onclick = () => {
  send({ type: 'vote_challenge', valid: true });
  el('votacao-status').textContent = 'Voto enviado. Aguardando os outros...';
  el('btn-voto-valido').disabled = true;
  el('btn-voto-invalido').disabled = true;
};
el('btn-voto-invalido').onclick = () => {
  send({ type: 'vote_challenge', valid: false });
  el('votacao-status').textContent = 'Voto enviado. Aguardando os outros...';
  el('btn-voto-valido').disabled = true;
  el('btn-voto-invalido').disabled = true;
};

function aplicarResultadoVotacao(msg) {
  clearInterval(votacaoInterval);
  el('overlay-votacao').classList.add('hidden');
  el('btn-voto-valido').disabled = false;
  el('btn-voto-invalido').disabled = false;

  if (msg.derrubado) {
    const linha = document.querySelector(
      `.resposta-linha[data-cat="${msg.category}"][data-player="${msg.targetPlayerId}"]`
    );
    if (linha) {
      linha.classList.remove('ok', 'dup');
      linha.classList.add('zero');
      linha.querySelector('.pontos-valor').textContent = '+0';
      const btn = linha.querySelector('.btn-duvidar');
      if (btn) btn.remove();
    }
  }
}

// ---------- podio ----------
function renderPodio(leaderboard) {
  const cores = ['#FAC775', '#D3D1C7', '#F0997B'];
  const medalhas = ['🥇', '🥈', '🥉'];
  const alturas = [90, 60, 44];
  const top3 = leaderboard.slice(0, 3);
  const ordemVisual = top3.length === 3 ? [top3[1], top3[0], top3[2]] : top3;

  const podio = el('podio');
  podio.innerHTML = '';
  ordemVisual.forEach((p, i) => {
    if (!p) return;
    const posicaoReal = top3.indexOf(p);
    const div = document.createElement('div');
    div.className = 'podio-item';
    div.innerHTML = `
      <span class="trofeu">${medalhas[posicaoReal]}</span>
      <div class="podio-barra" style="height:${alturas[posicaoReal]}px;background:${cores[posicaoReal]}">
        <span>${posicaoReal + 1}º</span>
      </div>
      <p class="podio-nome">${p.nickname}</p>
      <p class="podio-pts">${p.score} pts</p>`;
    podio.appendChild(div);
  });

  const souHost = meId === currentRoom?.hostId;
  el('btn-jogar-de-novo').classList.toggle('hidden', !souHost);
}
el('btn-jogar-de-novo').onclick = () => send({ type: 'play_again' });
