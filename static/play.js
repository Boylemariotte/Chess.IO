"use strict";

// Modo de juego. Reutiliza helpers globales de app.js: parseFen, GLYPH,
// pieceInfo, moveDescription, moveShort. Todo su estado vive en el objeto P
// para no colisionar con las variables de app.js.

const P = {
  fen: null,
  legal: {},
  yourColor: "white",   // "white" | "black"
  flipped: false,
  selected: null,
  busy: false,
  over: true,
  lastMove: null,       // uci de la última jugada (para resaltar)
  hint: null,           // uci de la pista actual
  moveNo: 0,
  sound: true,
};

// ---------- Sonidos (Web Audio, sin archivos) ----------

let _audioCtx = null;
function beep(freq, dur, type, gain) {
  if (!P.sound) return;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = _audioCtx.createOscillator();
    const g = _audioCtx.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.value = gain || 0.08;
    o.connect(g); g.connect(_audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, _audioCtx.currentTime + (dur || 0.08));
    o.stop(_audioCtx.currentTime + (dur || 0.08));
  } catch (e) { /* sin audio */ }
}
function soundMove() { beep(330, 0.07, "sine"); }
function soundCapture() { beep(200, 0.10, "square", 0.06); }
function soundCheck() { beep(660, 0.12, "triangle", 0.07); }
function soundBlunder() { beep(140, 0.22, "sawtooth", 0.06); }
function soundWin() { beep(523, 0.12); setTimeout(() => beep(659, 0.12), 120); setTimeout(() => beep(784, 0.18), 250); }
function soundLose() { beep(300, 0.18, "sine"); setTimeout(() => beep(180, 0.28, "sine"), 160); }

// ---------- Navegación (delega a navigateTo de app.js) ----------

function switchTab(name) {
  if (typeof navigateTo === "function") navigateTo(name);
}

// ---------- Tablero ----------

function playSquareCenter(name) {
  const f = "abcdefgh".indexOf(name[0]);
  const r = 8 - parseInt(name[1], 10);
  const dx = P.flipped ? 7 - f : f;
  const dy = P.flipped ? 7 - r : r;
  return { x: dx + 0.5, y: dy + 0.5 };
}

function pieceAt(name) {
  const board = parseFen(P.fen);
  const f = "abcdefgh".indexOf(name[0]);
  const r = 8 - parseInt(name[1], 10);
  return board[r][f];
}

function renderPlayBoard() {
  const board = parseFen(P.fen);
  const el = document.getElementById("play-board");
  el.innerHTML = "";
  const lastSq = P.lastMove ? { from: P.lastMove.slice(0, 2), to: P.lastMove.slice(2, 4) } : null;
  const dests = P.selected ? (P.legal[P.selected] || []) : [];

  for (let dr = 0; dr < 8; dr++) {
    for (let df = 0; df < 8; df++) {
      const r = P.flipped ? 7 - dr : dr;
      const f = P.flipped ? 7 - df : df;
      const isLight = (r + f) % 2 === 0;
      const name = "abcdefgh"[f] + (8 - r);
      const sq = document.createElement("div");
      sq.className = "sq " + (isLight ? "light" : "dark");
      sq.dataset.square = name;

      if (lastSq && (name === lastSq.from || name === lastSq.to)) sq.classList.add("to");
      if (name === P.selected) sq.classList.add("selected");

      // Coordenadas en los bordes.
      const labelClass = isLight ? "coord-on-light" : "coord-on-dark";
      if (df === 0) { const s = document.createElement("span"); s.className = "coord rank " + labelClass; s.textContent = 8 - r; sq.appendChild(s); }
      if (dr === 7) { const s = document.createElement("span"); s.className = "coord file " + labelClass; s.textContent = "abcdefgh"[f]; sq.appendChild(s); }

      const piece = board[r][f];
      if (piece) {
        const span = document.createElement("span");
        span.className = piece.color === "w" ? "piece-w" : "piece-b";
        span.textContent = GLYPH[piece.type];
        sq.appendChild(span);
      }
      // Punto de destino legal.
      if (dests.includes(name)) {
        const dot = document.createElement("span");
        dot.className = piece ? "legal-dot capture" : "legal-dot";
        sq.appendChild(dot);
      }
      sq.addEventListener("click", () => onSquareClick(name));
      el.appendChild(sq);
    }
  }
  drawHintArrow();
}

// ---------- Animación de movimiento ----------

function squareToPercent(name) {
  const f = "abcdefgh".indexOf(name[0]);
  const r = 8 - parseInt(name[1], 10);
  const df = P.flipped ? 7 - f : f;
  const dr = P.flipped ? 7 - r : r;
  return { left: df * 12.5, top: dr * 12.5 };
}

function animatePiece(fromSq, toSq, glyph, colorClass, callback) {
  const animator = document.getElementById("piece-animator");
  if (!animator) { callback(); return; }

  const fromPos = squareToPercent(fromSq);
  const toPos   = squareToPercent(toSq);

  // Oculta la pieza original en la casilla de origen
  const fromEl = document.querySelector(`#play-board [data-square="${fromSq}"]`);
  if (fromEl) fromEl.classList.add("piece-animating");

  // Configura el elemento volador sin transición (posición inicial instantánea)
  animator.className = colorClass;
  animator.textContent = glyph;
  animator.style.transition = "none";
  animator.style.left = fromPos.left + "%";
  animator.style.top  = fromPos.top  + "%";
  animator.style.display = "flex";

  void animator.offsetWidth; // fuerza reflow para que la transición arranque

  // Activa la transición y mueve a destino
  animator.style.transition = "left 0.2s cubic-bezier(.4,0,.2,1), top 0.2s cubic-bezier(.4,0,.2,1)";
  animator.style.left = toPos.left + "%";
  animator.style.top  = toPos.top  + "%";

  setTimeout(() => {
    animator.style.display = "none";
    if (fromEl) fromEl.classList.remove("piece-animating");
    callback();
  }, 220);
}

function drawHintArrow() {
  const svgEl = document.getElementById("play-arrows");
  svgEl.innerHTML = "";
  if (!P.hint) return;
  const a = playSquareCenter(P.hint.slice(0, 2));
  const b = playSquareCenter(P.hint.slice(2, 4));
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ex = b.x - (dx / len) * 0.32, ey = b.y - (dy / len) * 0.32;
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const m = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  m.setAttribute("id", "phint"); m.setAttribute("markerWidth", 4); m.setAttribute("markerHeight", 4);
  m.setAttribute("refX", 2.4); m.setAttribute("refY", 2); m.setAttribute("orient", "auto"); m.setAttribute("markerUnits", "strokeWidth");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M0,0 L4,2 L0,4 z"); path.setAttribute("fill", "rgba(241,196,15,.95)");
  m.appendChild(path); defs.appendChild(m); svgEl.appendChild(defs);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", a.x); line.setAttribute("y1", a.y); line.setAttribute("x2", ex); line.setAttribute("y2", ey);
  line.setAttribute("stroke", "rgba(241,196,15,.95)"); line.setAttribute("stroke-width", 0.16); line.setAttribute("stroke-linecap", "round");
  line.setAttribute("marker-end", "url(#phint)");
  svgEl.appendChild(line);
}

// ---------- Interacción ----------

function onSquareClick(name) {
  if (P.busy || P.over) return;
  P.hint = null;
  if (P.selected) {
    const dests = P.legal[P.selected] || [];
    if (dests.includes(name)) {
      const from = P.selected;
      P.selected = null;
      if (needsPromotion(from, name)) { showPromotion(from, name); renderPlayBoard(); return; }
      const piece = pieceAt(from);
      if (piece) {
        // Bloquea clics, actualiza estado visual y lanza animación antes del envío al servidor
        P.busy = true;
        setPlayStatus("Pensando…", "thinking");
        renderPlayBoard(); // limpia selección y puntos de destino
        animatePiece(from, name, GLYPH[piece.type],
          piece.color === "w" ? "piece-w" : "piece-b",
          () => doMove(from, name, null));
      } else {
        doMove(from, name, null);
      }
      return;
    }
  }
  // Seleccionar una pieza propia con jugadas legales.
  if (P.legal[name]) { P.selected = name; } else { P.selected = null; }
  renderPlayBoard();
}

function needsPromotion(from, to) {
  const piece = pieceAt(from);
  if (!piece || piece.type !== "p") return false;
  const rank = to[1];
  return rank === "8" || rank === "1";
}

// Selector de pieza de coronación.
function showPromotion(from, to) {
  const overlay = document.getElementById("promo-overlay");
  const white = P.yourColor === "white";
  const opts = [["q", "♛"], ["r", "♜"], ["b", "♝"], ["n", "♞"]];
  overlay.innerHTML = "<div class='promo-title'>Corona a:</div><div class='promo-row'></div>";
  const row = overlay.querySelector(".promo-row");
  opts.forEach(([code, glyph]) => {
    const b = document.createElement("button");
    b.className = "promo-piece " + (white ? "piece-w" : "piece-b");
    b.textContent = glyph;
    b.addEventListener("click", () => { overlay.classList.add("hidden"); doMove(from, to, code); });
    row.appendChild(b);
  });
  overlay.classList.remove("hidden");
}

async function doMove(from, to, promo) {
  P.busy = true;
  try {
    const data = await postJSON("/play/move", { from, to, promotion: promo });
    if (data.error) { setPlayStatus("⚠ " + data.error, "error"); P.busy = false; renderPlayBoard(); return; }
    handleMoveResponse(data);
  } catch (e) {
    setPlayStatus("⚠ Error de conexión.", "error");
  }
  P.busy = false;
}

function handleMoveResponse(data) {
  const ym = data.your_move;
  const em = data.engine_move;

  P.moveNo += 1;
  showFeedback(ym, em);
  appendHistory(ym, em);
  document.getElementById("play-analyze").classList.remove("hidden");

  // Sonidos
  if (ym.label === "Blunder") soundBlunder();
  else if ((em && em.san.includes("x")) || ym.san.includes("x")) soundCapture();
  else soundMove();
  if (data.in_check) soundCheck();

  // Aplicar estado final y renderizar
  const finish = () => {
    P.fen = data.fen;
    P.legal = data.legal || {};
    P.lastMove = em ? em.uci : ym.uci;
    renderPlayBoard();
    if (ym.label === "Blunder") flashBlunder();
    if (data.status !== "playing") {
      endGame(data.status, data.profile);
    } else {
      setPlayStatus(data.in_check ? "¡Jaque! Te toca." : "Te toca mover.", data.in_check ? "check" : "");
    }
  };

  // Animar el movimiento del motor si tenemos el FEN intermedio
  if (em && data.intermediate_fen) {
    const fromSq = em.uci.slice(0, 2);
    const toSq   = em.uci.slice(2, 4);
    const tmpBoard = parseFen(data.intermediate_fen);
    const ff = "abcdefgh".indexOf(fromSq[0]);
    const fr = 8 - parseInt(fromSq[1], 10);
    const piece = tmpBoard[fr][ff];

    if (piece) {
      // Renderizar estado tras el movimiento del jugador (antes del motor)
      P.fen = data.intermediate_fen;
      P.legal = {};
      P.lastMove = ym.uci;
      renderPlayBoard();
      animatePiece(fromSq, toSq, GLYPH[piece.type],
        piece.color === "w" ? "piece-w" : "piece-b",
        finish);
      return;
    }
  }

  finish();
}

function flashBlunder() {
  const fb = document.getElementById("play-feedback");
  fb.classList.add("blunder-flash");
  setTimeout(() => fb.classList.remove("blunder-flash"), 700);
}

function showFeedback(ym, em) {
  // Entrenador eval (cp_loss)
  const evalEl = document.getElementById("entrenador-eval");
  if (evalEl) {
    if (ym.cp_loss > 0) {
      const pawn = (ym.cp_loss / 100).toFixed(2);
      evalEl.textContent = `-${pawn}`;
      evalEl.style.color = ym.cp_loss > 100 ? "#e74c3c" : ym.cp_loss > 50 ? "#e67e22" : "#8b949e";
    } else {
      evalEl.textContent = "+0.00";
      evalEl.style.color = "#1bbd7e";
    }
  }

  let html = `<div style="margin-bottom:8px"><span class="badge" style="background:${ym.color_hex}">${ym.label} ${ym.symbol}</span> ` +
    `<strong style="margin-left:6px">${pieceInfo(ym.san).glyph} ${moveDescription(ym)}</strong></div>`;
  if (!ym.is_best) {
    html += `<div class="entrenador-suggestion"><span><span class="sug-label">Sugerido</span><span class="sug-move">${ym.best_san}</span></span></div>`;
  } else {
    html += `<div style="color:#1bbd7e;font-size:.88rem;font-weight:600">La mejor jugada ✓</div>`;
  }
  if (em) html += `<div class="best" style="margin-top:8px">El rival jugó: <strong>${pieceInfo(em.san).glyph} ${moveDescription(em)}</strong></div>`;
  document.getElementById("play-feedback").innerHTML = html;
}

function appendHistory(ym, em) {
  const list = document.getElementById("play-history");
  const row = document.createElement("div");
  row.className = "move-row";
  const yourCell = `<div class="mv" title="${(ym.explanation || ym.label)}">` +
    `<span class="mini-dot" style="background:${ym.color_hex}"></span>` +
    `<span class="mv-co">${moveShort(ym)}</span>` +
    `<span class="sym" style="color:${ym.color_hex}">${ym.symbol}</span></div>`;
  const engCell = em ? `<div class="mv"><span class="mv-co">${moveShort(em)}</span></div>` : "<div></div>";
  row.innerHTML = `<div class="no">${P.moveNo}.</div>` + yourCell + engCell;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function endGame(status, profile) {
  P.over = true;
  P.selected = null;
  let msg;
  const res = profile ? profile.last_result : null;
  if (status === "checkmate") msg = res === "win" ? "♚ ¡Jaque mate! Ganaste 🎉" : "♚ Jaque mate. Perdiste.";
  else if (status === "stalemate") msg = "Tablas por ahogado.";
  else if (status === "draw") msg = "Tablas.";
  else if (status === "resign") msg = "Te rendiste.";
  else msg = "Partida terminada.";
  setPlayStatus(msg, res === "win" ? "win" : res === "loss" ? "error" : "");
  if (res === "win") soundWin();
  else if (res === "loss") soundLose();
  if (profile) renderEloPanel(profile, true);
}

// ---------- Panel de Elo ----------

function renderEloPanel(profile, afterGame) {
  const el = document.getElementById("elo-panel");
  let deltaHtml = "";
  if (afterGame && profile.delta !== undefined) {
    const d = profile.delta;
    const sign = d > 0 ? "+" : "";
    const color = d > 0 ? "#2ecc71" : d < 0 ? "#e74c3c" : "#9aa0a6";
    deltaHtml = `<span class="elo-delta" style="color:${color}">${sign}${d}</span>`;
  }
  let extra = "";
  if (profile.last_acpl != null) {
    extra = `<div class="meta">Última partida — precisión (pérdida media): ${profile.last_acpl} centipeones por jugada</div>`;
  }
  el.innerHTML = `
    <div class="elo-head">
      <div class="elo-big">${profile.elo} ${deltaHtml}<span class="elo-unit">Elo estimado</span></div>
      <div class="elo-rank">${profile.rank}</div>
    </div>
    <div class="meta">Partidas jugadas: ${profile.games} · ${profile.wins}V / ${profile.draws}E / ${profile.losses}D</div>
    ${extra}`;
  document.getElementById("elo-card").classList.remove("hidden");
  renderEloGraph(profile.elo_history);
  renderStatsCards(profile);
}

// Gráfico de evolución del Elo.
function renderEloGraph(history) {
  const g = document.getElementById("elo-graph");
  if (!history || history.length < 2) { g.classList.add("hidden"); return; }
  g.classList.remove("hidden");
  g.innerHTML = "";
  const W = 400, H = 110, pad = 10;
  const elos = history.map((h) => h.elo);
  const lo = Math.min(...elos) - 20, hi = Math.max(...elos) + 20;
  const n = history.length;
  const xFor = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
  const yFor = (e) => H - pad - ((e - lo) / (hi - lo || 1)) * (H - 2 * pad);

  let pts = "";
  history.forEach((h, i) => { pts += `${xFor(i).toFixed(1)},${yFor(h.elo).toFixed(1)} `; });
  g.appendChild(svg("polyline", { points: pts, fill: "none", stroke: "#4a90d9", "stroke-width": 1.8 }));
  const resultColor = { win: "#2ecc71", loss: "#e74c3c", draw: "#9aa0a6" };
  history.forEach((h, i) => {
    g.appendChild(svg("circle", { cx: xFor(i), cy: yFor(h.elo), r: 2.8,
      fill: resultColor[h.result] || "#888" }));
  });
  // Etiqueta del último Elo.
  const last = svg("text", { x: W - pad, y: yFor(elos[n - 1]) - 4, "text-anchor": "end",
    fill: "#e8e8e8", "font-size": "11" });
  last.textContent = elos[n - 1];
  g.appendChild(last);
}

// ---------- Deshacer / analizar / sonido ----------

async function takebackMove() {
  if (P.over || P.busy) return;
  P.busy = true;
  const data = await postJSON("/play/takeback", {});
  P.busy = false;
  if (data.error) { setPlayStatus("⚠ " + data.error, "error"); return; }
  P.fen = data.fen;
  P.legal = data.legal || {};
  P.selected = null;
  P.hint = null;
  P.lastMove = null;
  P.moveNo = Math.max(0, P.moveNo - 1);
  const list = document.getElementById("play-history");
  if (list.lastChild) list.removeChild(list.lastChild);
  document.getElementById("play-feedback").innerHTML = "<em>Jugada deshecha. Te toca mover.</em>";
  renderPlayBoard();
  setPlayStatus("Te toca mover.", "");
}

async function analyzeThisGame() {
  const data = await postJSON("/play/pgn", {});
  if (data.error) { setPlayStatus("⚠ " + data.error, "error"); return; }
  document.getElementById("pgn").value = data.pgn;
  switchTab("analyze");
  analyze();   // función global de app.js
}

function toggleSound() {
  P.sound = !P.sound;
  document.getElementById("play-sound").textContent = P.sound ? "🔊" : "🔇";
  if (P.sound) beep(440, 0.05);
}

// ---------- Acciones ----------

async function startGame() {
  const color = document.getElementById("play-color").value;
  const mode = document.getElementById("play-mode").value;
  const elo = document.getElementById("play-elo").value;
  setPlayStatus("Preparando partida…", "thinking");
  try {
    const data = await postJSON("/play/new", { color, mode, elo });
    if (data.error) { setPlayStatus("⚠ " + data.error, "error"); return; }
    P.fen = data.fen;
    P.legal = data.legal || {};
    P.yourColor = data.your_color;
    P.flipped = data.your_color === "black";
    P.over = false;
    P.busy = false;
    P.selected = null;
    P.hint = null;
    P.lastMove = data.engine_move ? data.engine_move.uci : null;
    P.moveNo = 0;
    document.getElementById("play-history").innerHTML = "";
    document.getElementById("play-feedback").innerHTML = "<em>Haz tu jugada para ver la evaluación.</em>";
    document.getElementById("play-analyze").classList.add("hidden");
    document.getElementById("promo-overlay").classList.add("hidden");
    const setupWrap = document.getElementById("play-setup-wrap");
    if (setupWrap) setupWrap.classList.add("hidden");
    document.getElementById("play-area").classList.remove("hidden");
    const chip = document.getElementById("play-status-chip-text");
    if (chip) chip.textContent = `Partida en curso · IA ${data.engine_rank}`;
    const evalEl = document.getElementById("entrenador-eval");
    if (evalEl) { evalEl.textContent = ""; }
    renderPlayTags(data);
    renderEloPanel(data.profile, false);
    renderPlayBoard();
    setPlayStatus(data.in_check ? "¡Jaque! Te toca." : "Te toca mover.", "");
  } catch (e) {
    setPlayStatus("⚠ No se pudo iniciar la partida.", "error");
  }
}

function renderPlayTags(data) {
  const youTxt = `🧑 Tú (${P.yourColor === "white" ? "blancas" : "negras"})`;
  const aiTxt = `🤖 IA — Elo ${data.engine_elo} (${data.engine_rank})`;
  // El jugador de abajo eres tú.
  document.getElementById("ptag-bottom").textContent = youTxt;
  document.getElementById("ptag-top").textContent = aiTxt;
}

async function resignGame() {
  if (P.over) return;
  const data = await postJSON("/play/resign", {});
  if (!data.error) endGame("resign", data);
}

async function getHint() {
  if (P.busy || P.over) return;
  const data = await postJSON("/play/hint", {});
  if (data.error) return;
  P.hint = data.best_uci;
  setPlayStatus(`Pista: prueba ${moveDescription({ san: data.best_san, uci: data.best_uci })}`, "");
  renderPlayBoard();
}

function flipPlay() { P.flipped = !P.flipped; renderPlayBoard(); }

// ---------- Utilidades ----------

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function setPlayStatus(text, cls) {
  const el = document.getElementById("play-status");
  el.textContent = text;
  el.className = cls || "";
}

// Renderiza las stats cards del setup.
function renderStatsCards(profile) {
  if (!profile || !profile.games) return;
  const row = document.getElementById("play-stats-row");
  if (row) row.classList.remove("hidden");

  const eloEl = document.getElementById("psc-elo-val");
  if (eloEl) eloEl.textContent = profile.elo;
  const rankEl = document.getElementById("psc-elo-rank");
  if (rankEl) rankEl.textContent = profile.rank;

  const precEl = document.getElementById("psc-prec-val");
  const precSub = document.getElementById("psc-prec-sub");
  if (precEl) {
    if (profile.last_acpl !== null && profile.last_acpl !== undefined) {
      precEl.textContent = profile.last_acpl + " cp";
      if (precSub) precSub.textContent = "centipeones por jugada";
    } else {
      precEl.textContent = "—";
    }
  }

  const balEl = document.getElementById("psc-bal-val");
  const barEl = document.getElementById("psc-bar");
  const labEl = document.getElementById("psc-bal-labels");
  if (balEl) balEl.textContent = profile.games + " partida" + (profile.games !== 1 ? "s" : "");
  if (barEl) {
    barEl.innerHTML = `
      <div class="bb-w" style="flex:${profile.wins || 0}"></div>
      <div class="bb-d" style="flex:${profile.draws || 0}"></div>
      <div class="bb-l" style="flex:${profile.losses || 0}"></div>`;
  }
  if (labEl) {
    labEl.innerHTML = `
      <span class="bw">${profile.wins}V</span>
      <span class="bd">${profile.draws}E</span>
      <span class="bl">${profile.losses}D</span>`;
  }
}

// Cargar el Elo guardado al abrir.
async function loadProfileOnStart() {
  try {
    const r = await fetch("/play/profile");
    const p = await r.json();
    if (!p.error) { renderEloPanel(p, false); renderStatsCards(p); }
  } catch (e) { /* sin perfil aun */ }
}

// ---------- Eventos ----------

// Button groups para color
document.querySelectorAll("#color-group .bgroup-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#color-group .bgroup-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("play-color").value = btn.dataset.val;
  });
});

// Button groups para dificultad
document.querySelectorAll("#diff-group .bgroup-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#diff-group .bgroup-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("play-mode").value = btn.dataset.mode;
    document.getElementById("play-elo").value = btn.dataset.elo;
  });
});

// Volver al setup
const playBackBtn = document.getElementById("play-back");
if (playBackBtn) {
  playBackBtn.addEventListener("click", () => {
    document.getElementById("play-area").classList.add("hidden");
    const setupWrap = document.getElementById("play-setup-wrap");
    if (setupWrap) setupWrap.classList.remove("hidden");
  });
}

document.getElementById("play-mode").addEventListener("change", (e) => {
  document.getElementById("elo-fixed-wrap").classList.toggle("hidden", e.target.value !== "fixed");
});
document.getElementById("play-start").addEventListener("click", startGame);
document.getElementById("play-resign").addEventListener("click", resignGame);
document.getElementById("play-hint").addEventListener("click", getHint);
document.getElementById("play-flip").addEventListener("click", flipPlay);
document.getElementById("play-takeback").addEventListener("click", takebackMove);
document.getElementById("play-analyze").addEventListener("click", analyzeThisGame);
document.getElementById("play-sound").addEventListener("click", toggleSound);

loadProfileOnStart();
