"use strict";

// Modo de juego 100% en el navegador. Usa chess.js (reglas) + Stockfish WASM
// (rival y evaluación) + localStorage (Elo). Reutiliza helpers globales de
// app.js (parseFen, GLYPH, pieceInfo, moveDescription, moveShort, svg,
// getAnalysisEngine, analysisEngine) y de analysis.js (classify, sideToMoveCp,
// explain, LABEL_COLOR).

const PG = {
  chess: null, opp: null,
  fen: null, legal: {},
  userColor: "white", engineElo: 1000, mode: "adaptive",
  cpLosses: [], depth: 12,
  flipped: false, selected: null, busy: false, over: true,
  lastMove: null, hint: null, moveNo: 0, sound: true,
};

// ---------- Sonidos (Web Audio) ----------
let _audioCtx = null;
function beep(freq, dur, type, gain) {
  if (!PG.sound) return;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = _audioCtx.createOscillator();
    const g = _audioCtx.createGain();
    o.type = type || "sine"; o.frequency.value = freq; g.gain.value = gain || 0.08;
    o.connect(g); g.connect(_audioCtx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, _audioCtx.currentTime + (dur || 0.08));
    o.stop(_audioCtx.currentTime + (dur || 0.08));
  } catch (e) { /* */ }
}
function soundMove() { beep(330, 0.07, "sine"); }
function soundCapture() { beep(200, 0.10, "square", 0.06); }
function soundCheck() { beep(660, 0.12, "triangle", 0.07); }
function soundBlunder() { beep(140, 0.22, "sawtooth", 0.06); }
function soundWin() { beep(523, 0.12); setTimeout(() => beep(659, 0.12), 120); setTimeout(() => beep(784, 0.18), 250); }
function soundLose() { beep(300, 0.18, "sine"); setTimeout(() => beep(180, 0.28, "sine"), 160); }

// ---------- Pestañas ----------
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.getElementById("tab-analyze").classList.toggle("hidden", name !== "analyze");
  document.getElementById("tab-play").classList.toggle("hidden", name !== "play");
}
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// ---------- Perfil / Elo (localStorage) ----------
const PROFILE_KEY = "ajedrez_profile";
function loadProfile() {
  try { const p = JSON.parse(localStorage.getItem(PROFILE_KEY)); if (p && typeof p.elo === "number") return p; } catch (e) { /* */ }
  return { elo: 1000, games: 0, wins: 0, draws: 0, losses: 0, last_acpl: null, last_result: null, delta: 0, elo_history: [] };
}
function saveProfile(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) { /* */ } }
function profileView(p) { return Object.assign({}, p, { rank: eloRank(p.elo) }); }

function eloRank(elo) {
  if (elo >= 2200) return "Maestro";
  if (elo >= 2000) return "Experto";
  if (elo >= 1800) return "Avanzado";
  if (elo >= 1500) return "Intermedio alto";
  if (elo >= 1200) return "Intermedio";
  if (elo >= 900) return "Principiante avanzado";
  return "Principiante";
}
function acplToElo(acpl) { return Math.max(400, Math.min(2600, 2600 - 14 * acpl)); }
function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

function updateProfile(score, status) {
  const p = loadProfile();
  const userElo = p.elo;
  const expected = 1 / (1 + Math.pow(10, (PG.engineElo - userElo) / 400));
  let nw = userElo + 32 * (score - expected);
  let acpl = null;
  if (PG.cpLosses.length >= 6) { acpl = avg(PG.cpLosses); nw = 0.85 * nw + 0.15 * acplToElo(acpl); }
  else if (PG.cpLosses.length) acpl = avg(PG.cpLosses);
  const delta = Math.max(-40, Math.min(40, Math.round(nw) - userElo));
  nw = Math.max(400, Math.min(2800, userElo + delta));
  p.delta = nw - userElo; p.elo = nw; p.games++;
  if (score === 1) p.wins++; else if (score === 0) p.losses++; else p.draws++;
  p.last_acpl = acpl != null ? Math.round(acpl * 10) / 10 : null;
  p.last_result = score === 1 ? "win" : score === 0 ? "loss" : "draw";
  p.last_status = status;
  (p.elo_history = p.elo_history || []).push({ elo: nw, result: p.last_result, date: new Date().toISOString().slice(0, 10) });
  p.elo_history = p.elo_history.slice(-100);
  saveProfile(p);
  return profileView(p);
}

// ---------- Motor: fuerza del rival ----------
function configureStrength(engine, elo) {
  if (elo >= 1350) {
    engine.setoption("UCI_LimitStrength", "true");
    engine.setoption("UCI_Elo", Math.min(2850, elo));
  } else {
    engine.setoption("UCI_LimitStrength", "false");
    engine.setoption("Skill Level", Math.max(0, Math.min(20, Math.round((elo - 700) / 90))));
  }
}

// ---------- Utilidades de reglas ----------
function legalMap(c) {
  const m = {};
  for (const mv of c.moves({ verbose: true })) (m[mv.from] = m[mv.from] || []).push(mv.to);
  return m;
}
function gameStatus(c) {
  if (c.in_checkmate()) return "checkmate";
  if (c.in_stalemate()) return "stalemate";
  if (c.insufficient_material() || c.in_threefold_repetition() || c.in_draw()) return "draw";
  return "playing";
}

// ---------- Tablero ----------
function playSquareCenter(name) {
  const f = "abcdefgh".indexOf(name[0]);
  const r = 8 - parseInt(name[1], 10);
  const dx = PG.flipped ? 7 - f : f;
  const dy = PG.flipped ? 7 - r : r;
  return { x: dx + 0.5, y: dy + 0.5 };
}
function pieceAt(name) {
  const board = parseFen(PG.fen);
  const f = "abcdefgh".indexOf(name[0]);
  const r = 8 - parseInt(name[1], 10);
  return board[r][f];
}
function renderPlayBoard() {
  const board = parseFen(PG.fen);
  const el = document.getElementById("play-board");
  el.innerHTML = "";
  const lastSq = PG.lastMove ? { from: PG.lastMove.slice(0, 2), to: PG.lastMove.slice(2, 4) } : null;
  const dests = PG.selected ? (PG.legal[PG.selected] || []) : [];
  for (let dr = 0; dr < 8; dr++) {
    for (let df = 0; df < 8; df++) {
      const r = PG.flipped ? 7 - dr : dr;
      const f = PG.flipped ? 7 - df : df;
      const isLight = (r + f) % 2 === 0;
      const name = "abcdefgh"[f] + (8 - r);
      const sq = document.createElement("div");
      sq.className = "sq " + (isLight ? "light" : "dark");
      sq.dataset.square = name;
      if (lastSq && (name === lastSq.from || name === lastSq.to)) sq.classList.add("to");
      if (name === PG.selected) sq.classList.add("selected");
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
function drawHintArrow() {
  const svgEl = document.getElementById("play-arrows");
  svgEl.innerHTML = "";
  if (!PG.hint) return;
  const a = playSquareCenter(PG.hint.slice(0, 2));
  const b = playSquareCenter(PG.hint.slice(2, 4));
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
  if (PG.busy || PG.over) return;
  PG.hint = null;
  if (PG.selected) {
    const dests = PG.legal[PG.selected] || [];
    if (dests.includes(name)) {
      const from = PG.selected;
      PG.selected = null;
      if (needsPromotion(from, name)) { showPromotion(from, name); renderPlayBoard(); return; }
      userMove(from, name, null);
      return;
    }
  }
  if (PG.legal[name]) PG.selected = name; else PG.selected = null;
  renderPlayBoard();
}
function needsPromotion(from, to) {
  const piece = pieceAt(from);
  if (!piece || piece.type !== "p") return false;
  return to[1] === "8" || to[1] === "1";
}
function showPromotion(from, to) {
  const overlay = document.getElementById("promo-overlay");
  const white = PG.userColor === "white";
  const opts = [["q", "♛"], ["r", "♜"], ["b", "♝"], ["n", "♞"]];
  overlay.innerHTML = "<div class='promo-title'>Corona a:</div><div class='promo-row'></div>";
  const row = overlay.querySelector(".promo-row");
  opts.forEach(([code, glyph]) => {
    const b = document.createElement("button");
    b.className = "promo-piece " + (white ? "piece-w" : "piece-b");
    b.textContent = glyph;
    b.addEventListener("click", () => { overlay.classList.add("hidden"); userMove(from, to, code); });
    row.appendChild(b);
  });
  overlay.classList.remove("hidden");
}

// ---------- Lógica de la partida ----------
async function startGame() {
  const color = document.getElementById("play-color").value;
  const mode = document.getElementById("play-mode").value;
  const elo = parseInt(document.getElementById("play-elo").value, 10) || 1000;
  setPlayStatus("Preparando partida…", "thinking");

  const profile = loadProfile();
  const userColor = color === "random" ? (Math.random() < 0.5 ? "white" : "black") : color;
  let engineElo = mode === "adaptive" ? profile.elo : elo;
  engineElo = Math.max(500, Math.min(2800, engineElo));

  PG.chess = new Chess();
  PG.userColor = userColor; PG.engineElo = engineElo; PG.mode = mode;
  PG.cpLosses = []; PG.over = false; PG.busy = false;
  PG.selected = null; PG.hint = null; PG.lastMove = null; PG.moveNo = 0;
  PG.flipped = userColor === "black";

  try {
    const ana = getAnalysisEngine();
    await ana.init();
    if (!PG.opp) PG.opp = new Engine("js/engine/stockfish.js");
    await PG.opp.init();
    PG.opp.newGame();
    configureStrength(PG.opp, engineElo);
  } catch (e) { setPlayStatus("⚠ No se pudo iniciar el motor.", "error"); return; }

  document.getElementById("play-history").innerHTML = "";
  document.getElementById("play-feedback").innerHTML = "<em>Haz tu jugada para ver la evaluación.</em>";
  document.getElementById("play-analyze").classList.add("hidden");
  document.getElementById("promo-overlay").classList.add("hidden");
  document.getElementById("play-area").classList.remove("hidden");
  renderPlayTags();
  renderEloPanel(profileView(profile), false);

  if (userColor === "black") {
    PG.busy = true; setPlayStatus("Pensando…", "thinking");
    const reply = await PG.opp.bestmove(PG.chess.fen(), 500);
    PG.chess.move({ from: reply.bestmove.slice(0, 2), to: reply.bestmove.slice(2, 4), promotion: reply.bestmove[4] || "q" });
    PG.lastMove = reply.bestmove; PG.busy = false;
  }
  PG.fen = PG.chess.fen(); PG.legal = legalMap(PG.chess);
  renderPlayBoard();
  setPlayStatus(PG.chess.in_check() ? "¡Jaque! Te toca." : "Te toca mover.", "");
}

async function userMove(from, to, promo) {
  PG.busy = true;
  setPlayStatus("Pensando…", "thinking");
  try {
    const c = PG.chess;
    const fenBefore = c.fen();
    const ana = getAnalysisEngine();

    const best = await ana.analyse(fenBefore, PG.depth);
    const cpBefore = sideToMoveCp(best);
    const bestUci = best.bestmove;
    let bestSan = bestUci;
    { const t = new Chess(fenBefore); const bm = t.move({ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), promotion: bestUci[4] || "q" }); if (bm) bestSan = bm.san; }
    const onlyMove = c.moves().length === 1;

    const mv = c.move({ from, to, promotion: promo || "q" });
    if (!mv) { PG.busy = false; renderPlayBoard(); return; }
    const playedUci = mv.from + mv.to + (mv.promotion || "");

    let after = { scoreCp: null, mate: null, pv: [] };
    let cpAfter;
    let st = gameStatus(c);
    if (st !== "playing") cpAfter = c.in_checkmate() ? 10000 : 0;
    else { after = await ana.analyse(c.fen(), PG.depth); cpAfter = -sideToMoveCp(after); }

    let cpLoss = Math.max(0, cpBefore - cpAfter);
    let isBest = (playedUci === bestUci) || (playedUci.slice(0, 4) === bestUci.slice(0, 4));
    if (c.in_checkmate()) { cpLoss = 0; isBest = true; }
    const [label, symbol] = classify(cpLoss, isBest, onlyMove);
    PG.cpLosses.push(cpLoss);
    const expl = explain(c, best, after, bestSan, isBest, cpLoss, label);
    const yourMove = {
      san: mv.san, uci: playedUci, label, symbol, cp_loss: cpLoss,
      best_san: bestSan, best_uci: bestUci, is_best: isBest,
      color_hex: LABEL_COLOR[label] || "#888", explanation: expl,
    };

    let engineMove = null;
    if (st === "playing") {
      const reply = await PG.opp.bestmove(c.fen(), 500);
      const rmv = c.move({ from: reply.bestmove.slice(0, 2), to: reply.bestmove.slice(2, 4), promotion: reply.bestmove[4] || "q" });
      engineMove = { uci: reply.bestmove, san: rmv ? rmv.san : reply.bestmove };
      st = gameStatus(c);
    }

    PG.fen = c.fen(); PG.legal = legalMap(c);
    PG.lastMove = engineMove ? engineMove.uci : playedUci;
    PG.moveNo += 1; PG.selected = null; PG.hint = null;
    showFeedback(yourMove, engineMove);
    appendHistory(yourMove, engineMove);
    renderPlayBoard();
    document.getElementById("play-analyze").classList.remove("hidden");

    if (yourMove.label === "Blunder") { soundBlunder(); flashBlunder(); }
    else if ((engineMove && engineMove.san.includes("x")) || yourMove.san.includes("x")) soundCapture();
    else soundMove();
    if (c.in_check()) soundCheck();

    PG.busy = false;
    if (st !== "playing") endGame(st);
    else setPlayStatus(c.in_check() ? "¡Jaque! Te toca." : "Te toca mover.", c.in_check() ? "check" : "");
  } catch (e) {
    PG.busy = false;
    setPlayStatus("⚠ Error: " + e.message, "error");
  }
}

function endGame(status) {
  PG.over = true; PG.selected = null;
  const c = PG.chess;
  let score;
  if (status === "checkmate") {
    const winnerWhite = c.turn() === "b";   // el lado que mueve está ahogado/mate
    score = (winnerWhite === (PG.userColor === "white")) ? 1 : 0;
  } else if (status === "resign") score = 0;
  else score = 0.5;

  const profile = updateProfile(score, status);
  const res = profile.last_result;
  let msg;
  if (status === "checkmate") msg = res === "win" ? "♚ ¡Jaque mate! Ganaste 🎉" : "♚ Jaque mate. Perdiste.";
  else if (status === "stalemate") msg = "Tablas por ahogado.";
  else if (status === "draw") msg = "Tablas.";
  else if (status === "resign") msg = "Te rendiste.";
  else msg = "Partida terminada.";
  setPlayStatus(msg, res === "win" ? "win" : res === "loss" ? "error" : "");
  if (res === "win") soundWin(); else if (res === "loss") soundLose();
  renderEloPanel(profile, true);
}

function takebackMove() {
  if (PG.over || PG.busy) return;
  const c = PG.chess;
  if (PG.cpLosses.length === 0) return;
  if (c.history().length && c.turn() === (PG.userColor === "white" ? "w" : "b")) c.undo();
  if (c.history().length) c.undo();
  PG.cpLosses.pop();
  PG.fen = c.fen(); PG.legal = legalMap(c);
  PG.selected = null; PG.hint = null; PG.lastMove = null;
  PG.moveNo = Math.max(0, PG.moveNo - 1);
  const list = document.getElementById("play-history");
  if (list.lastChild) list.removeChild(list.lastChild);
  document.getElementById("play-feedback").innerHTML = "<em>Jugada deshecha. Te toca mover.</em>";
  renderPlayBoard();
  setPlayStatus("Te toca mover.", "");
}

async function getHint() {
  if (PG.busy || PG.over) return;
  const r = await getAnalysisEngine().analyse(PG.chess.fen(), PG.depth);
  const bu = r.bestmove;
  let bs = bu;
  const t = new Chess(PG.chess.fen());
  const m = t.move({ from: bu.slice(0, 2), to: bu.slice(2, 4), promotion: bu[4] || "q" });
  if (m) bs = m.san;
  PG.hint = bu;
  setPlayStatus("Pista: prueba " + moveDescription({ san: bs, uci: bu }), "");
  renderPlayBoard();
}

function resignGame() { if (!PG.over) endGame("resign"); }

function analyzeThisGame() {
  const c = PG.chess;
  c.header("White", PG.userColor === "white" ? "Tú" : "IA (" + PG.engineElo + ")",
           "Black", PG.userColor === "black" ? "Tú" : "IA (" + PG.engineElo + ")",
           "Result", c.in_checkmate() ? (c.turn() === "w" ? "0-1" : "1-0") : "*");
  document.getElementById("pgn").value = c.pgn();
  switchTab("analyze");
  analyze();
}

function flipPlay() { PG.flipped = !PG.flipped; renderPlayBoard(); }
function toggleSound() {
  PG.sound = !PG.sound;
  document.getElementById("play-sound").textContent = PG.sound ? "🔊" : "🔇";
  if (PG.sound) beep(440, 0.05);
}

// ---------- Feedback / historial / tags ----------
function showFeedback(ym, em) {
  let html = `<span class="badge" style="background:${ym.color_hex}">${ym.label} ${ym.symbol}</span> ` +
    `<strong>${pieceInfo(ym.san).glyph} ${moveDescription(ym)}</strong>`;
  if (!ym.is_best) html += `<div class="best">Lo mejor era: <strong>${moveDescription({ san: ym.best_san, uci: ym.best_uci })}</strong></div>`;
  else html += `<div class="best">¡La mejor jugada! ✓</div>`;
  if (ym.explanation) html += `<div class="why" style="margin-top:6px">💡 ${ym.explanation}</div>`;
  if (em) html += `<div class="reply">↩ El rival jugó: <strong>${pieceInfo(em.san).glyph} ${moveDescription(em)}</strong></div>`;
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
  row.innerHTML = `<div class="no">${PG.moveNo}.</div>` + yourCell + engCell;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}
function renderPlayTags() {
  const youTxt = `🧑 Tú (${PG.userColor === "white" ? "blancas" : "negras"})`;
  const aiTxt = `🤖 IA — Elo ${PG.engineElo} (${eloRank(PG.engineElo)})`;
  document.getElementById("ptag-bottom").textContent = youTxt;
  document.getElementById("ptag-top").textContent = aiTxt;
}

// ---------- Panel de Elo + gráfico ----------
function renderEloPanel(profile, afterGame) {
  const el = document.getElementById("elo-panel");
  let deltaHtml = "";
  if (afterGame && profile.delta !== undefined) {
    const d = profile.delta, sign = d > 0 ? "+" : "";
    const color = d > 0 ? "#2ecc71" : d < 0 ? "#e74c3c" : "#9aa0a6";
    deltaHtml = `<span class="elo-delta" style="color:${color}">${sign}${d}</span>`;
  }
  let extra = "";
  if (profile.last_acpl != null) extra = `<div class="meta">Última partida — pérdida media: ${profile.last_acpl} centipeones por jugada</div>`;
  el.innerHTML = `
    <div class="elo-head">
      <div class="elo-big">${profile.elo} ${deltaHtml}<span class="elo-unit">Elo estimado</span></div>
      <div class="elo-rank">${profile.rank}</div>
    </div>
    <div class="meta">Partidas jugadas: ${profile.games} · ${profile.wins}V / ${profile.draws}E / ${profile.losses}D</div>
    ${extra}`;
  document.getElementById("elo-card").classList.remove("hidden");
  renderEloGraph(profile.elo_history);
}
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
  const rc = { win: "#2ecc71", loss: "#e74c3c", draw: "#9aa0a6" };
  history.forEach((h, i) => g.appendChild(svg("circle", { cx: xFor(i), cy: yFor(h.elo), r: 2.8, fill: rc[h.result] || "#888" })));
  const last = svg("text", { x: W - pad, y: yFor(elos[n - 1]) - 4, "text-anchor": "end", fill: "#e8e8e8", "font-size": "11" });
  last.textContent = elos[n - 1];
  g.appendChild(last);
}

function flashBlunder() {
  const fb = document.getElementById("play-feedback");
  fb.classList.add("blunder-flash");
  setTimeout(() => fb.classList.remove("blunder-flash"), 700);
}
function setPlayStatus(text, cls) {
  const el = document.getElementById("play-status");
  el.textContent = text; el.className = cls || "";
}

// ---------- Eventos ----------
document.getElementById("play-mode").addEventListener("change", (e) =>
  document.getElementById("elo-fixed-wrap").classList.toggle("hidden", e.target.value !== "fixed"));
document.getElementById("play-start").addEventListener("click", startGame);
document.getElementById("play-resign").addEventListener("click", resignGame);
document.getElementById("play-hint").addEventListener("click", getHint);
document.getElementById("play-flip").addEventListener("click", flipPlay);
document.getElementById("play-takeback").addEventListener("click", takebackMove);
document.getElementById("play-analyze").addEventListener("click", analyzeThisGame);
document.getElementById("play-sound").addEventListener("click", toggleSound);

// Mostrar el Elo guardado al abrir.
(function () { try { renderEloPanel(profileView(loadProfile()), false); } catch (e) { /* */ } })();
