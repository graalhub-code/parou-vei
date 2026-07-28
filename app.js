const el = (id) => document.getElementById(id);
function capitalizeFirst(texto) {
  if (!texto) return texto;
  return texto.charAt(0).toLocaleUpperCase('pt-BR') + texto.slice(1);
}
const screens = ['entrada', 'lobby', 'config', 'jogo', 'resultado', 'desempate', 'podio'];
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
  if (msg.type === 'tiebreak_start') {
    renderDesempate(msg);
    showScreen('desempate');
    return;
  }
  if (msg.type === 'tiebreak_result') {
    ultimoResultadoDesempate = msg;
    return;
  }
  if (msg.type === 'game_over') {
    renderPodio(msg.leaderboard, msg.stats);
    showScreen('podio');
    return;
  }
}
let ultimoResultadoDesempate = null;

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
  el('btn-abrir-config').classList.toggle('hidden', !souHost);
  el('btn-iniciar').classList.toggle('hidden', !souHost);
  el('lobby-espera').classList.toggle('hidden', souHost);

  if (souHost && document.activeElement !== el('input-codigo-editar')) {
    el('input-codigo-editar').value = room.code;
  }

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

    const chipsVotacao = el('chips-votacao');
    chipsVotacao.innerHTML = '';
    [5000, 10000, 15000, 20000].forEach(ms => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (ms === room.voteDurationMs ? ' selected' : '');
      chip.textContent = (ms / 1000) + 's';
      chip.onclick = () => send({ type: 'set_vote_duration', voteDurationMs: ms });
      chipsVotacao.appendChild(chip);
    });

    el('toggle-desempate').checked = room.tiebreakEnabled !== false;
    el('toggle-desempate').onchange = (e) => send({ type: 'set_tiebreak', enabled: e.target.checked });
    el('toggle-bahia').checked = !!room.bahiaEnabled;
    el('toggle-bahia').onchange = (e) => send({ type: 'set_bahia', enabled: e.target.checked });
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
el('btn-abrir-config').onclick = () => showScreen('config');
el('btn-fechar-config').onclick = () => showScreen('lobby');
el('btn-salvar-codigo').onclick = () => {
  const novoCodigo = el('input-codigo-editar').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(novoCodigo)) {
    return showToast('O código precisa ter de 4 a 8 letras ou números.');
  }
  send({ type: 'set_room_code', code: novoCodigo });
};
el('btn-chamada-voz').onclick = () => {
  if (!currentRoom) return;
  window.open(`https://meet.jit.si/parouvei-${currentRoom.code}`, '_blank');
};

// ---------- jogo ----------
function renderRound(msg) {
  el('jogo-rodada').textContent = `Rodada ${msg.currentRound}/${msg.totalRounds}`;
  el('jogo-letra').textContent = msg.letter;
  el('banner-parou').classList.add('hidden');
  el('banner-bahia').classList.toggle('hidden', !msg.isBahia);
  el('btn-parei').disabled = false;

  const wrap = el('campos-categorias');
  wrap.innerHTML = '';
  for (const cat of msg.categories) {
    const ehBaiana = msg.isBahia && cat === msg.bahiaCategory;
    const item = document.createElement('div');
    item.className = 'campo-item' + (ehBaiana ? ' baiana' : '');
    const rotulo = cat;
    item.innerHTML = `<label>${rotulo}</label><input type="text" data-cat="${cat}" autocomplete="off" />`;
    wrap.appendChild(item);
    const input = item.querySelector('input');
    input.oninput = () => {
      const cursor = input.selectionStart;
      const capitalizado = capitalizeFirst(input.value);
      if (capitalizado !== input.value) {
        input.value = capitalizado;
        input.setSelectionRange(cursor, cursor);
      }
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

// ---------- desempate ----------
let desempateInterval = null;
let desempateEnviado = false;

function renderDesempate(msg) {
  clearInterval(votacaoInterval);
  clearInterval(countdownTimer);
  desempateEnviado = false;

  const nomes = msg.players.join(' e ');
  el('desempate-titulo').textContent = `${nomes} empataram! Hora do desempate.`;
  el('desempate-categoria').textContent = msg.category;
  el('desempate-letra').textContent = msg.letter;
  el('desempate-categoria-label').textContent = msg.category;
  el('desempate-input').value = '';
  el('btn-desempate-enviar').disabled = false;

  const souParticipante = msg.playerIds.includes(meId);
  el('desempate-campo').classList.toggle('hidden', !souParticipante);
  el('btn-desempate-enviar').classList.toggle('hidden', !souParticipante);
  el('desempate-espera').classList.toggle('hidden', souParticipante);
  if (souParticipante) el('desempate-espera').textContent = 'Aguardando os jogadores empatados responderem...';

  let restante = Math.floor(msg.maxMs / 1000);
  el('desempate-timer').textContent = restante + 's';
  clearInterval(desempateInterval);
  desempateInterval = setInterval(() => {
    restante -= 1;
    if (restante <= 0) { clearInterval(desempateInterval); return; }
    el('desempate-timer').textContent = restante + 's';
  }, 1000);
}

el('desempate-input').oninput = () => {
  const cursor = el('desempate-input').selectionStart;
  const capitalizado = capitalizeFirst(el('desempate-input').value);
  if (capitalizado !== el('desempate-input').value) {
    el('desempate-input').value = capitalizado;
    el('desempate-input').setSelectionRange(cursor, cursor);
  }
};
el('btn-desempate-enviar').onclick = () => {
  if (desempateEnviado) return;
  desempateEnviado = true;
  send({ type: 'tiebreak_answer', value: el('desempate-input').value });
  el('btn-desempate-enviar').disabled = true;
  el('desempate-espera').classList.remove('hidden');
  el('desempate-espera').textContent = 'Resposta enviada. Aguardando o outro jogador...';
};

// ---------- serpentina de campeonato ----------
function lancarConfete() {
  const cores = ['#D85A30', '#5DCAA5', '#FAC775'];
  const container = el('confete');
  container.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const pedaco = document.createElement('div');
    pedaco.className = 'confete-pedaco';
    pedaco.style.left = Math.random() * 100 + '%';
    pedaco.style.background = cores[Math.floor(Math.random() * cores.length)];
    pedaco.style.height = (36 + Math.random() * 34) + 'px';
    pedaco.style.animationDuration = (3.8 + Math.random() * 2.2) + 's';
    pedaco.style.animationDelay = (Math.random() * 0.7) + 's';
    pedaco.style.setProperty('--balanco', (Math.random() * 40 - 20) + 'px');
    pedaco.style.setProperty('--giro', (Math.random() * 100 - 50) + 'deg');
    container.appendChild(pedaco);
  }
  setTimeout(() => { container.innerHTML = ''; }, 6200);
}

// ---------- podio ----------
function formatarNomes(nomes) {
  if (nomes.length === 1) return nomes[0];
  if (nomes.length === 2) return `${nomes[0]} e ${nomes[1]}`;
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

function renderPodioStats(stats) {
  const wrap = el('podio-stats');
  wrap.innerHTML = '';
  if (!stats) {
    wrap.classList.add('hidden');
    el('podio-stats-aviso').classList.add('hidden');
    return;
  }
  const itens = [];
  if (stats.maisRapido && stats.maisRapido.count > 0) {
    const vezes = stats.maisRapido.count === 1 ? 'vez' : 'vezes';
    itens.push({
      icone: '⚡',
      texto: `<strong>${formatarNomes(stats.maisRapido.players)}</strong> ${stats.maisRapido.players.length > 1 ? 'foram' : 'foi'} quem mais gritou "Parei, vei!" primeiro (${stats.maisRapido.count} ${vezes})`,
    });
  }
  if (stats.maisRepetiu && stats.maisRepetiu.count > 0) {
    const vezes = stats.maisRepetiu.count === 1 ? 'vez' : 'vezes';
    itens.push({
      icone: '🔁',
      texto: `<strong>${formatarNomes(stats.maisRepetiu.players)}</strong> ${stats.maisRepetiu.players.length > 1 ? 'foram' : 'foi'} quem mais repetiu resposta com outro jogador (${stats.maisRepetiu.count} ${vezes})`,
    });
  }
  if (itens.length === 0) {
    wrap.classList.add('hidden');
    el('podio-stats-aviso').classList.add('hidden');
    return;
  }
  for (const item of itens) {
    const div = document.createElement('div');
    div.className = 'podio-stat-item';
    div.innerHTML = `<span class="podio-stat-icone">${item.icone}</span><span class="podio-stat-texto">${item.texto}</span>`;
    wrap.appendChild(div);
  }
  wrap.classList.remove('hidden');
  el('podio-stats-aviso').classList.remove('hidden');
}

function renderPodio(leaderboard, stats) {
  lancarConfete();
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

  renderPodioStats(stats);

  const souHost = meId === currentRoom?.hostId;
  el('btn-jogar-de-novo').classList.toggle('hidden', !souHost);
  el('podio-espera').classList.toggle('hidden', souHost);
}
el('btn-jogar-de-novo').onclick = () => send({ type: 'play_again' });

el('btn-voltar-inicio').onclick = () => {
  send({ type: 'leave_room' });
  currentRoom = null;
  draftAnswers = {};
  el('input-nickname').value = '';
  el('input-codigo').value = '';
  el('bloco-entrar-codigo').classList.add('hidden');
  showScreen('entrada');
};
