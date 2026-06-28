"use strict";

const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const SVGNS = "http://www.w3.org/2000/svg";

let allGames = [];     // todas las partidas analizadas
let players = {};       // estadísticas globales por jugador
let analysis = null;    // partida seleccionada actualmente
let positions = [];     // FENs de la partida seleccionada
let current = 0;        // índice de la posición mostrada
let flipped = false;    // tablero girado (visto desde las negras)

// ---------- Utilidades ----------

function svg(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function parseFen(fen) {
  const rows = fen.split(" ")[0].split("/");
  const board = [];
  for (const row of rows) {
    const cells = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < parseInt(ch, 10); k++) cells.push(null);
      } else {
        cells.push({ type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? "w" : "b" });
      }
    }
    board.push(cells);
  }
  return board;
}

function squareName(f, r) { return "abcdefgh"[f] + (8 - r); }

// Centro de una casilla (ej. "e4") en el viewBox 0..8 del SVG de flechas,
// teniendo en cuenta si el tablero está girado.
function squareCenter(name) {
  const f = "abcdefgh".indexOf(name[0]);
  const rank = parseInt(name[1], 10);
  const r = 8 - rank;
  const dx = flipped ? 7 - f : f;
  const dy = flipped ? 7 - r : r;
  return { x: dx + 0.5, y: dy + 0.5 };
}

function uciSquares(uci) { return { from: uci.slice(0, 2), to: uci.slice(2, 4) }; }

// ---------- Tablero ----------

function renderBoard(fen, highlight) {
  const board = parseFen(fen);
  const el = document.getElementById("board");
  el.innerHTML = "";
  // dr, df = posición en pantalla; r, f = posición real (según giro).
  for (let dr = 0; dr < 8; dr++) {
    for (let df = 0; df < 8; df++) {
      const r = flipped ? 7 - dr : dr;
      const f = flipped ? 7 - df : df;
      const sq = document.createElement("div");
      const isLight = (r + f) % 2 === 0;
      sq.className = "sq " + (isLight ? "light" : "dark");
      const name = squareName(f, r);
      if (highlight) {
        if (name === highlight.from) sq.classList.add("from");
        if (name === highlight.to) sq.classList.add("to");
      }
      // Coordenadas: números 1-8 en la columna izquierda, letras a-h en la
      // fila inferior. Se colorean con el tono contrario al de la casilla.
      const labelClass = isLight ? "coord-on-light" : "coord-on-dark";
      if (df === 0) {
        const rank = document.createElement("span");
        rank.className = "coord rank " + labelClass;
        rank.textContent = 8 - r;
        sq.appendChild(rank);
      }
      if (dr === 7) {
        const file = document.createElement("span");
        file.className = "coord file " + labelClass;
        file.textContent = "abcdefgh"[f];
        sq.appendChild(file);
      }

      const piece = board[r][f];
      if (piece) {
        const span = document.createElement("span");
        span.className = piece.color === "w" ? "piece-w" : "piece-b";
        span.textContent = GLYPH[piece.type];
        sq.appendChild(span);
      }
      el.appendChild(sq);
    }
  }
  drawArrows(highlight);
}

// Dibuja la flecha de la jugada real (azul) y la mejor del motor (verde).
function drawArrows(highlight) {
  const svgEl = document.getElementById("arrows");
  svgEl.innerHTML = "";
  if (!highlight) return;

  const defs = svg("defs", {});
  defs.appendChild(arrowMarker("head-blue", "rgba(74,144,217,.95)"));
  defs.appendChild(arrowMarker("head-green", "rgba(39,174,96,.9)"));
  svgEl.appendChild(defs);

  // Mejor jugada (solo si difiere de la jugada real).
  if (highlight.bestFrom && !highlight.played_is_best) {
    svgEl.appendChild(makeArrow(highlight.bestFrom, highlight.bestTo, "rgba(39,174,96,.9)", "head-green"));
  }
  // Jugada real.
  if (highlight.from) {
    svgEl.appendChild(makeArrow(highlight.from, highlight.to, "rgba(74,144,217,.95)", "head-blue"));
  }
}

function arrowMarker(id, color) {
  const m = svg("marker", {
    id, markerWidth: 4, markerHeight: 4, refX: 2.4, refY: 2,
    orient: "auto", markerUnits: "strokeWidth",
  });
  const p = svg("path", { d: "M0,0 L4,2 L0,4 z", fill: color });
  m.appendChild(p);
  return m;
}

function makeArrow(from, to, color, markerId) {
  const a = squareCenter(from), b = squareCenter(to);
  // Acortar un poco para que la punta no tape la pieza destino.
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const shrink = 0.32;
  const ex = b.x - (dx / len) * shrink;
  const ey = b.y - (dy / len) * shrink;
  return svg("line", {
    x1: a.x, y1: a.y, x2: ex, y2: ey,
    stroke: color, "stroke-width": 0.16, "stroke-linecap": "round",
    "marker-end": `url(#${markerId})`,
  });
}

// ---------- Navegación ----------

function showPosition(idx) {
  current = Math.max(0, Math.min(positions.length - 1, idx));
  let highlight = null;

  if (current === 0) {
    document.getElementById("move-info").innerHTML =
      '<em>Posición inicial. Avanza con ▶ o la flecha derecha.</em>';
  } else {
    const m = analysis.moves[current - 1];
    const played = uciSquares(m.uci);
    const best = uciSquares(m.best_uci);
    highlight = {
      from: played.from, to: played.to,
      bestFrom: best.from, bestTo: best.to,
      played_is_best: m.is_best,
    };
    let html =
      `<span class="badge" style="background:${m.color_hex}">${m.label} ${m.symbol}</span> ` +
      `<strong>${m.move_no}${m.color === "white" ? "." : "..."} ${m.san}</strong> ` +
      `&nbsp;·&nbsp; eval ${formatEval(m.eval_white)} &nbsp;·&nbsp; precisión ${m.accuracy}%` +
      `<div class="translate">${pieceInfo(m.san).glyph} ${moveDescription(m)}</div>`;
    if (m.is_best) {
      html += `<div class="best">¡Jugaste la mejor jugada! ✓</div>`;
    } else {
      html += `<div class="best">Mejor jugada del motor: <strong>${m.best_san}</strong></div>`;
    }
    if (m.explanation) html += `<div class="why">💡 ${m.explanation}</div>`;
    document.getElementById("move-info").innerHTML = html;
  }

  renderBoard(positions[current], highlight);
  updateGraphMarker();

  document.querySelectorAll(".mv").forEach((e) => e.classList.remove("active"));
  if (current > 0) {
    const active = document.querySelector(`.mv[data-ply="${current}"]`);
    if (active) { active.classList.add("active"); active.scrollIntoView({ block: "nearest" }); }
  }
}

function formatEval(whiteCp) {
  if (Math.abs(whiteCp) >= 9000) {
    const mate = Math.round((10000 - Math.abs(whiteCp)) / 10);
    return (whiteCp > 0 ? "+M" : "-M") + mate;
  }
  const v = (whiteCp / 100).toFixed(2);
  return (whiteCp > 0 ? "+" : "") + v;
}

// ---------- Gráfico de evaluación ----------

function buildEvalGraph() {
  const g = document.getElementById("eval-graph");
  g.innerHTML = "";
  const W = 400, H = 120, mid = H / 2, CAP = 800;
  const curve = analysis.eval_curve;
  const n = curve.length;
  if (n === 0) return;

  const xFor = (ply) => (ply / n) * W;           // ply 0..n
  const yFor = (cp) => mid - (Math.max(-CAP, Math.min(CAP, cp)) / CAP) * (mid - 6);

  // Zona blancas (arriba) y negras (abajo).
  g.appendChild(svg("rect", { x: 0, y: 0, width: W, height: mid, fill: "rgba(235,236,208,.06)" }));
  g.appendChild(svg("rect", { x: 0, y: mid, width: W, height: mid, fill: "rgba(0,0,0,.18)" }));

  // Área bajo la curva.
  let areaPts = `0,${mid} `;
  let linePts = "";
  for (let i = 0; i < n; i++) {
    const x = xFor(i + 1), y = yFor(curve[i]);
    areaPts += `${x.toFixed(1)},${y.toFixed(1)} `;
    linePts += `${x.toFixed(1)},${y.toFixed(1)} `;
  }
  areaPts += `${W},${mid}`;
  g.appendChild(svg("polygon", { points: areaPts, fill: "rgba(74,144,217,.18)" }));
  g.appendChild(svg("line", { x1: 0, y1: mid, x2: W, y2: mid, stroke: "#555", "stroke-width": 1, "stroke-dasharray": "4 4" }));
  g.appendChild(svg("polyline", { points: linePts, fill: "none", stroke: "#4a90d9", "stroke-width": 1.6 }));

  // Marcas de errores grandes (blunder/error).
  for (let i = 0; i < analysis.moves.length; i++) {
    const m = analysis.moves[i];
    if (m.label === "Blunder" || m.label === "Error") {
      g.appendChild(svg("circle", {
        cx: xFor(i + 1), cy: yFor(curve[i]), r: 2.6,
        fill: m.color_hex, stroke: "#fff", "stroke-width": 0.6,
      }));
    }
  }

  // Marcador de la posición actual (se actualiza aparte).
  const marker = svg("line", { id: "graph-cursor", x1: 0, y1: 0, x2: 0, y2: H, stroke: "#fff", "stroke-width": 1, opacity: 0.7 });
  g.appendChild(marker);

  g.onclick = (e) => {
    const rect = g.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const ply = Math.round((x / W) * n);
    showPosition(Math.max(0, Math.min(n, ply)));
  };
  updateGraphMarker();
}

function updateGraphMarker() {
  const marker = document.getElementById("graph-cursor");
  if (!marker || !analysis) return;
  const n = analysis.eval_curve.length;
  const x = n ? (current / n) * 400 : 0;
  marker.setAttribute("x1", x);
  marker.setAttribute("x2", x);
}

// ---------- Lista de jugadas y resumen ----------

function buildMoveList() {
  const ml = document.getElementById("movelist");
  ml.innerHTML = "";
  const moves = analysis.moves;
  for (let i = 0; i < moves.length; i += 2) {
    const white = moves[i], black = moves[i + 1];
    const row = document.createElement("div");
    row.className = "move-row";
    row.innerHTML = `<div class="no">${white.move_no}.</div>` +
      moveCell(white) + (black ? moveCell(black) : "<div></div>");
    ml.appendChild(row);
  }
  ml.querySelectorAll(".mv").forEach((el) => {
    el.addEventListener("click", () => showPosition(parseInt(el.dataset.ply, 10)));
  });
}

// Qué pieza/glifo corresponde a una jugada (a partir de su notación SAN).
const PIECE_NAMES = {
  N: ["Caballo", "♞"], B: ["Alfil", "♝"], R: ["Torre", "♜"],
  Q: ["Dama", "♛"], K: ["Rey", "♚"],
};
const PROMO_NAMES = { q: "dama", r: "torre", b: "alfil", n: "caballo" };

function pieceInfo(san) {
  if (san.startsWith("O-O-O")) return { name: "Enroque largo", glyph: "♚", castle: true };
  if (san.startsWith("O-O")) return { name: "Enroque corto", glyph: "♚", castle: true };
  const p = PIECE_NAMES[san[0]];
  if (p) return { name: p[0], glyph: p[1] };
  return { name: "Peón", glyph: "♟" };
}

// Forma corta para el historial: "♞ g5×e4" o "♟ d7–d5".
function moveShort(m) {
  const info = pieceInfo(m.san);
  if (info.castle) return `${info.glyph} ${m.san}`;
  const from = m.uci.slice(0, 2), to = m.uci.slice(2, 4);
  const sep = m.san.includes("x") ? "×" : "–";
  return `${info.glyph} ${from}${sep}${to}`;
}

// Frase completa en español: "Caballo g5 captura en e4 (jaque)".
function moveDescription(m) {
  const info = pieceInfo(m.san);
  if (info.castle) return info.name;
  const from = m.uci.slice(0, 2), to = m.uci.slice(2, 4);
  const capture = m.san.includes("x");
  let txt = `${info.name} ${from} ${capture ? "captura en" : "→"} ${to}`;
  if (m.uci.length > 4) txt += ` y corona a ${PROMO_NAMES[m.uci[4]] || "dama"}`;
  if (m.san.includes("#")) txt += " — ¡jaque mate!";
  else if (m.san.includes("+")) txt += " — jaque";
  return txt;
}

function moveCell(m) {
  const tip = `${moveDescription(m)} · ${m.label}` + (m.explanation ? ` · ${m.explanation}` : "");
  return `<div class="mv" data-ply="${m.ply}" title="${tip.replace(/"/g, "'")}">` +
    `<span class="mini-dot" style="background:${m.color_hex}"></span>` +
    `<span class="mv-co">${moveShort(m)}</span>` +
    `<span class="sym" style="color:${m.color_hex}">${m.symbol}</span></div>`;
}

const LABEL_ORDER = ["Mejor jugada", "Excelente", "Buena", "Imprecisión", "Inexacta", "Error", "Blunder", "Forzada"];
const LABEL_COLORS = {
  "Mejor jugada": "#27ae60", "Excelente": "#2ecc71", "Buena": "#7fb800",
  "Imprecisión": "#f1c40f", "Inexacta": "#e67e22", "Error": "#e74c3c",
  "Blunder": "#c0392b", "Forzada": "#3498db",
};

function buildSummary() {
  const s = analysis.summary, h = analysis.headers;
  const wName = h.White || "Blancas", bName = h.Black || "Negras";
  document.getElementById("summary").innerHTML =
    playerSummary(wName, s.white, "♔") + playerSummary(bName, s.black, "♚");
  renderOpening();
  renderTags();
}

function renderOpening() {
  const el = document.getElementById("opening-info");
  const o = analysis.opening;
  if (!o) { el.innerHTML = ""; return; }
  const moveNo = Math.ceil(o.theory_end_ply / 2);
  el.innerHTML = `<span class="opening-badge">♟ Apertura</span> ` +
    `<strong>${o.eco}</strong> · ${o.name} ` +
    `<span class="opening-theory">— seguiste teoría conocida hasta la jugada ${moveNo}</span>`;
}

// Coloca a cada jugador arriba/abajo según el giro del tablero. El de abajo es
// siempre quien "mira" el tablero (blancas normalmente, negras si está girado).
function renderTags() {
  if (!analysis) return;
  const h = analysis.headers;
  const white = `♔ ${h.White || "Blancas"} (${h.WhiteElo ? Math.round(h.WhiteElo) : "?"})`;
  const black = `♚ ${h.Black || "Negras"} (${h.BlackElo ? Math.round(h.BlackElo) : "?"})`;
  document.getElementById("tag-top").textContent = flipped ? white : black;
  document.getElementById("tag-bottom").textContent = flipped ? black : white;
}

const LABEL_HELP = {
  "Mejor jugada": "La mejor opción posible según el motor.",
  "Excelente": "Casi tan buena como la mejor jugada.",
  "Buena": "Una jugada sólida.",
  "Imprecisión": "Pierdes un poco de ventaja; había algo mejor.",
  "Inexacta": "Pierdes ventaja apreciable.",
  "Error": "Jugada mala: pierdes bastante ventaja.",
  "Blunder": "Error grave: sueles perder una pieza o la partida.",
  "Forzada": "Era la única jugada legal posible.",
};

function playerSummary(name, data, icon) {
  let counts = "";
  for (const label of LABEL_ORDER) {
    if (data.counts[label]) {
      counts += `<span title="${LABEL_HELP[label] || ""}"><span><span class="dot" style="background:${LABEL_COLORS[label]}"></span>${label}</span><strong>${data.counts[label]}</strong></span>`;
    }
  }
  return `<div class="player-summary">
    <h3>${icon} ${name}</h3>
    <div class="acc">${data.accuracy}%</div>
    <div class="rating">${data.rating_label} · ${data.moves} jugadas</div>
    <div class="counts">${counts}</div>
  </div>`;
}

// ---------- Selector de partidas y estadísticas globales ----------

function buildGamesList() {
  const card = document.getElementById("games-card");
  const list = document.getElementById("games-list");
  if (allGames.length <= 1) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  list.innerHTML = "";
  allGames.forEach((g, i) => {
    const item = document.createElement("div");
    item.className = "game-item" + (i === 0 ? " active" : "");
    item.dataset.idx = i;
    item.innerHTML = `<span>${i + 1}. ${g.label}</span>` +
      `<span class="g-acc">B ${g.summary.white.accuracy}% · N ${g.summary.black.accuracy}%</span>`;
    item.addEventListener("click", () => selectGame(i));
    list.appendChild(item);
  });
}

function buildGlobalStats() {
  const card = document.getElementById("global-card");
  const cont = document.getElementById("global-stats");
  const names = Object.keys(players);
  if (allGames.length <= 1) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  cont.innerHTML = "";
  // Ordenar por número de partidas (el jugador principal primero).
  names.sort((a, b) => players[b].games - players[a].games);
  for (const name of names) {
    const p = players[name];
    cont.innerHTML += `<div class="global-player">
      <h3>${name}</h3>
      <div class="big">${p.accuracy}% <span style="font-size:1rem;color:var(--muted)">${p.rating_label}</span></div>
      <div class="meta">${p.games} partidas · ${p.record} · ${p.moves} jugadas</div>
      <div class="badges">
        <span>💀 ${p.blunders} blunders</span>
        <span>❌ ${p.errors} errores</span>
      </div>
    </div>`;
  }
}

function selectGame(idx) {
  analysis = allGames[idx];
  positions = [analysis.start_fen, ...analysis.moves.map((m) => m.fen)];
  buildSummary();
  buildMoveList();
  buildEvalGraph();
  buildReportButtons();
  buildTrainer();
  document.querySelectorAll(".game-item").forEach((e, i) =>
    e.classList.toggle("active", i === idx));
  showPosition(positions.length - 1);
}

// ---------- Entrenador de errores (puzzles) ----------

const PZ = { list: [], idx: 0, selected: null, solved: false, attempts: 0 };

function buildTrainer() {
  // Un puzzle por cada error grave: la posición ANTES de la mala jugada.
  PZ.list = analysis.moves
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.label === "Error" || m.label === "Blunder")
    .map(({ m, i }) => ({
      fen: positions[i],            // posición antes de la jugada (índice i = ply i+1)
      side: m.color,                // quién debe mover
      solution: m.best_uci,
      best_san: m.best_san,
      played_san: m.san,
      move_no: m.move_no,
      explanation: m.explanation,
    }));

  const card = document.getElementById("trainer-card");
  const intro = document.getElementById("trainer-intro");
  card.classList.remove("hidden");
  document.getElementById("trainer-area").classList.add("hidden");

  if (PZ.list.length === 0) {
    intro.innerHTML = "<p>¡No hubo errores graves en esta partida para entrenar! 🎉</p>";
    return;
  }
  intro.innerHTML =
    `<p>Tuviste <strong>${PZ.list.length}</strong> error(es) grave(s). Vuelve a la posición donde fallaste e intenta encontrar la mejor jugada.</p>` +
    `<button id="pz-start">Empezar entrenamiento</button>`;
  document.getElementById("pz-start").addEventListener("click", startTrainer);
}

function startTrainer() {
  PZ.idx = 0;
  document.getElementById("trainer-area").classList.remove("hidden");
  loadPuzzle(0);
  document.getElementById("trainer-card").scrollIntoView({ behavior: "smooth" });
}

function loadPuzzle(i) {
  PZ.idx = i;
  PZ.selected = null;
  PZ.solved = false;
  PZ.attempts = 0;
  const p = PZ.list[i];
  document.getElementById("puzzle-progress").innerHTML =
    `Error <strong>${i + 1}</strong> de ${PZ.list.length}`;
  document.getElementById("puzzle-prompt").innerHTML =
    `Juegan <strong>${p.side === "white" ? "blancas ♔" : "negras ♚"}</strong> · ` +
    `encuentra la mejor jugada (jugada ${p.move_no})`;
  document.getElementById("puzzle-status").innerHTML =
    "<em>Haz clic en la pieza y luego en su destino.</em>";
  document.getElementById("pz-next").textContent =
    (i + 1 < PZ.list.length) ? "Saltar ▶" : "Terminar";
  renderPuzzleBoard();
}

function renderPuzzleBoard(highlight) {
  const p = PZ.list[PZ.idx];
  const flip = p.side === "black";        // verlo desde el lado que mueve
  const board = parseFen(p.fen);
  const el = document.getElementById("puzzle-board");
  el.innerHTML = "";
  for (let dr = 0; dr < 8; dr++) {
    for (let df = 0; df < 8; df++) {
      const r = flip ? 7 - dr : dr;
      const f = flip ? 7 - df : df;
      const isLight = (r + f) % 2 === 0;
      const name = "abcdefgh"[f] + (8 - r);
      const sq = document.createElement("div");
      sq.className = "sq " + (isLight ? "light" : "dark");
      if (name === PZ.selected) sq.classList.add("selected");
      if (highlight && (name === highlight.from || name === highlight.to)) sq.classList.add("to");
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
      sq.addEventListener("click", () => onPuzzleClick(name));
      el.appendChild(sq);
    }
  }
}

function puzzlePieceColorAt(name) {
  const p = PZ.list[PZ.idx];
  const board = parseFen(p.fen);
  const f = "abcdefgh".indexOf(name[0]);
  const r = 8 - parseInt(name[1], 10);
  const piece = board[r][f];
  return piece ? piece.color : null;
}

function onPuzzleClick(name) {
  if (PZ.solved) return;
  const p = PZ.list[PZ.idx];
  const myColor = p.side === "white" ? "w" : "b";
  if (PZ.selected) {
    if (name === PZ.selected) { PZ.selected = null; renderPuzzleBoard(); return; }
    // Intento de jugada.
    const attempt = PZ.selected + name;
    if (attempt === p.solution.slice(0, 4)) {
      PZ.solved = true;
      document.getElementById("puzzle-status").innerHTML =
        `<span class="pz-ok">✓ ¡Correcto! La mejor jugada era ${p.best_san}.</span>`;
      renderPuzzleBoard({ from: p.solution.slice(0, 2), to: p.solution.slice(2, 4) });
      document.getElementById("pz-next").textContent =
        (PZ.idx + 1 < PZ.list.length) ? "Siguiente ▶" : "Terminar";
      return;
    }
    // Si seleccionó otra pieza propia, cambiar selección.
    if (puzzlePieceColorAt(name) === myColor) { PZ.selected = name; renderPuzzleBoard(); return; }
    PZ.attempts++;
    const hint = PZ.attempts >= 2 ? ` Pista: mueve la pieza en ${p.solution.slice(0, 2)}.` : "";
    document.getElementById("puzzle-status").innerHTML =
      `<span class="pz-bad">✗ Esa no es la mejor.${hint}</span> Intenta de nuevo.`;
    PZ.selected = null;
    renderPuzzleBoard();
    return;
  }
  // Seleccionar pieza propia.
  if (puzzlePieceColorAt(name) === myColor) { PZ.selected = name; renderPuzzleBoard(); }
}

function puzzleHint() {
  const p = PZ.list[PZ.idx];
  document.getElementById("puzzle-status").innerHTML =
    `<span class="pz-bad">Pista: mueve la pieza que está en <strong>${p.solution.slice(0, 2)}</strong>.</span>`;
  PZ.selected = p.solution.slice(0, 2);
  renderPuzzleBoard();
}

function puzzleSolution() {
  const p = PZ.list[PZ.idx];
  PZ.solved = true;
  document.getElementById("puzzle-status").innerHTML =
    `Solución: <strong>${p.best_san}</strong>. ` +
    (p.explanation ? `(En la partida jugaste ${p.played_san}: ${p.explanation})` : `En la partida jugaste ${p.played_san}.`);
  renderPuzzleBoard({ from: p.solution.slice(0, 2), to: p.solution.slice(2, 4) });
}

function puzzleNext() {
  if (PZ.idx + 1 < PZ.list.length) loadPuzzle(PZ.idx + 1);
  else {
    document.getElementById("trainer-area").classList.add("hidden");
    document.getElementById("trainer-intro").innerHTML =
      "<p>¡Entrenamiento completado! 🎉 Repasa estos errores en tus próximas partidas.</p>" +
      '<button id="pz-start">Repetir entrenamiento</button>';
    document.getElementById("pz-start").addEventListener("click", startTrainer);
  }
}

// ---------- Reporte para aprender ----------

let lastReportText = "";

function buildReportButtons() {
  const cont = document.getElementById("report-buttons");
  const h = analysis.headers;
  cont.innerHTML = "";
  [["white", h.White || "Blancas", "♔"], ["black", h.Black || "Negras", "♚"]].forEach(([side, name, icon]) => {
    const b = document.createElement("button");
    b.textContent = `${icon} Reporte de ${name}`;
    b.addEventListener("click", () => showReport(side));
    cont.appendChild(b);
  });
  // Ocultar reporte anterior al cambiar de partida.
  document.getElementById("report-output").classList.add("hidden");
  document.getElementById("report-actions").classList.add("hidden");
}

function showReport(side) {
  lastReportText = buildReportText(side);
  const out = document.getElementById("report-output");
  out.textContent = lastReportText;
  out.classList.remove("hidden");
  document.getElementById("report-actions").classList.remove("hidden");
  document.getElementById("copy-msg").textContent = "";
  out.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function bestOf(m) {
  // Describe la mejor jugada del motor en coordenadas claras.
  return moveDescription({ san: m.best_san, uci: m.best_uci });
}

function buildReportText(side) {
  const h = analysis.headers;
  const name = side === "white" ? (h.White || "Blancas") : (h.Black || "Negras");
  const sum = analysis.summary[side];
  const myMoves = analysis.moves.filter((m) => m.color === side);
  const bad = myMoves.filter((m) => ["Inexacta", "Error", "Blunder"].includes(m.label));

  // Detección de patrones.
  let hung = 0, allowedMate = 0, missedMate = 0, missedMaterial = 0, openingBad = 0;
  for (const m of bad) {
    const e = m.explanation || "";
    if (e.includes("Cuelgas")) hung++;
    else if (e.includes("Permites un mate")) allowedMate++;
    else if (e.includes("Te pierdes un mate")) missedMate++;
    else if (m.best_san.includes("x")) missedMaterial++;
    if (m.move_no <= 10) openingBad++;
  }
  const blunders = myMoves.filter((m) => m.label === "Blunder").length;
  const errors = myMoves.filter((m) => m.label === "Error").length;

  const L = [];
  const line = (s = "") => L.push(s);
  const rule = () => line("------------------------------------------------------------");

  rule();
  line(`  REPORTE DE LA PARTIDA — ${name}`);
  line(`  ${analysis.label}`);
  rule();
  line();
  line(`Precisión: ${sum.accuracy}%  (${sum.rating_label})`);
  line(`Jugadas analizadas: ${sum.moves}`);
  line(`Errores graves: ${blunders} blunder(s), ${errors} error(es).`);
  line();

  // Momento clave (mayor pérdida de ventaja).
  if (myMoves.length) {
    const worst = myMoves.reduce((a, b) => (b.cp_loss > a.cp_loss ? b : a));
    if (worst.cp_loss > 50) {
      line("MOMENTO CLAVE DE LA PARTIDA");
      line(`  En la jugada ${worst.move_no}, ${moveDescription(worst)}.`);
      line(`  Clasificación: ${worst.label}.`);
      if (worst.explanation) line(`  ${worst.explanation}`);
      line(`  Lo mejor era: ${bestOf(worst)}.`);
      line();
    }
  }

  // Errores principales (hasta 6, de mayor a menor gravedad).
  const top = [...bad].filter((m) => m.label !== "Inexacta")
    .sort((a, b) => b.cp_loss - a.cp_loss).slice(0, 6);
  if (top.length) {
    line("TUS ERRORES PRINCIPALES");
    top.forEach((m, i) => {
      line(`  ${i + 1}. Jugada ${m.move_no} — ${moveShortText(m)}  [${m.label}]`);
      if (m.explanation) line(`     ${m.explanation}`);
      line(`     Mejor opción: ${bestOf(m)}.`);
    });
    line();
  } else {
    line("¡Bien! No tuviste errores graves en esta partida.");
    line();
  }

  // Consejos según patrones.
  line("QUÉ PUEDES MEJORAR");
  const tips = [];
  if (hung >= 1) {
    tips.push(`Colgaste piezas ${hung} vez/veces. Antes de CADA jugada hazte un ` +
      `"chequeo de seguridad": ¿la pieza que muevo o que dejo queda defendida? ` +
      `¿el rival puede capturarla gratis? Esto evita la mayoría de los blunders.`);
  }
  if (allowedMate >= 1) {
    tips.push(`Permitiste jaque mate ${allowedMate} vez/veces. Cuida a tu rey: ` +
      `enroca pronto, mantén peones que lo protejan y desconfía cuando el rival ` +
      `acerca la dama y otra pieza a tu rey.`);
  }
  if (missedMate >= 1) {
    tips.push(`Te perdiste un mate forzado ${missedMate} vez/veces. Cuando tengas ` +
      `iniciativa, busca siempre primero JAQUES y amenazas directas al rey rival.`);
  }
  if (missedMaterial >= 1) {
    tips.push(`Dejaste pasar ${missedMaterial} captura(s) ventajosa(s). En tu turno ` +
      `revisa el orden: 1) jaques, 2) capturas, 3) amenazas. A menudo hay material gratis.`);
  }
  if (openingBad >= 2) {
    tips.push(`Varios errores fueron en la apertura. Repasa los principios: domina el ` +
      `centro (e4/d4), desarrolla caballos y alfiles pronto, enroca, y no saques la ` +
      `dama ni muevas la misma pieza demasiadas veces al principio.`);
  }
  if (sum.accuracy < 70 && tips.length === 0) {
    tips.push(`Tu precisión fue ${sum.accuracy}%. Juega más despacio y revisa cada ` +
      `jugada del rival: pregúntate "¿qué amenaza con esto?" antes de responder.`);
  }
  if (tips.length === 0) {
    tips.push(`Partida muy sólida (${sum.accuracy}% de precisión). Sigue así: ` +
      `repasa las pocas imprecisiones para pulir detalles.`);
  }
  tips.forEach((t, i) => {
    line(`  ${i + 1}) ${t}`);
    line();
  });

  line("PLAN DE ENTRENAMIENTO SUGERIDO");
  line("  - Haz el 'chequeo de seguridad' (¿algo queda colgado?) antes de mover.");
  line("  - Practica ejercicios de táctica a diario (mate en 1-2, capturas).");
  line("  - Vuelve a jugar esta partida desde tus errores e intenta la jugada correcta.");
  line("  - Repasa una apertura sencilla y sus primeras 6-8 jugadas.");
  line();
  rule();
  line("  Generado por tu Analizador de Ajedrez");
  rule();

  return L.join("\n");
}

// Versión texto plano de la jugada (sin glifos), para el reporte.
function moveShortText(m) {
  const info = pieceInfo(m.san);
  if (info.castle) return `${info.name} (${m.san})`;
  const from = m.uci.slice(0, 2), to = m.uci.slice(2, 4);
  const verb = m.san.includes("x") ? "captura en" : "a";
  return `${info.name} ${from} ${verb} ${to} (${m.san})`;
}

// ---------- Auth / usuario ----------

async function initUser() {
  const resp = await fetch("/me");
  const data = await resp.json();
  if (!data.authenticated) { window.location.href = "/login"; return; }
  document.getElementById("user-greeting").innerHTML =
    `Hola, <strong>${data.username}</strong>`;
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  window.location.href = "/login";
});

initUser();

// ---------- Pestaña Mis partidas ----------

async function loadSavedList() {
  const resp = await fetch("/games");
  if (resp.status === 401) { window.location.href = "/login"; return; }
  const games = await resp.json();
  const el = document.getElementById("saved-list");
  if (!games.length) {
    el.innerHTML = '<em style="color:var(--muted)">Aún no tienes partidas guardadas. Analiza una y aparecerá aquí.</em>';
    return;
  }
  el.innerHTML = games.map(g => {
    const d = new Date(g.analyzed_at);
    const fecha = d.toLocaleDateString("es", { day:"2-digit", month:"short", year:"numeric" });
    return `<div class="saved-item" data-id="${g.id}">
      <div class="saved-label">${escHtml(g.label)}</div>
      <div class="saved-date">${fecha}</div>
      <button class="ghost" onclick="openSavedGame(${g.id})">Ver análisis</button>
      <button class="ghost" style="color:#e74c3c" onclick="deleteSavedGame(${g.id}, this)">✕</button>
    </div>`;
  }).join("");
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function openSavedGame(id) {
  const resp = await fetch(`/games/${id}`);
  if (!resp.ok) { alert("No se pudo cargar la partida."); return; }
  const data = await resp.json();
  // Cargar en el analizador y cambiar a esa pestaña
  document.querySelector('[data-tab="analyze"]').click();
  document.getElementById("pgn").value = data.pgn_text;
  onResult(data.analysis);
  document.getElementById("results").scrollIntoView({ behavior: "smooth" });
}

async function deleteSavedGame(id, btn) {
  if (!confirm("¿Eliminar esta partida guardada?")) return;
  const resp = await fetch(`/games/${id}`, { method: "DELETE" });
  if (resp.ok) { btn.closest(".saved-item").remove(); }
}

// ---------- Auto-guardar después del análisis ----------

async function saveAnalyzedGames(pgn, result) {
  for (const game of result.games) {
    try {
      await fetch("/games/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: game.label,
          pgn_text: pgn,
          analysis: result,
        }),
      });
    } catch { /* silencioso */ }
  }
  showToast();
}

function showToast() {
  const t = document.getElementById("save-toast");
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

// ---------- Análisis ----------

async function analyze() {
  const pgn = document.getElementById("pgn").value.trim();
  const depth = document.getElementById("depth").value;
  if (!pgn) { showError("Pega una partida primero."); return; }

  hideError();
  const btn = document.getElementById("analyze");
  btn.disabled = true;
  btn.textContent = "Analizando...";
  document.getElementById("progress-wrap").classList.remove("hidden");
  setProgress(0, 1, "Iniciando motor...");

  try {
    const resp = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pgn, depth }),
    });
    if (!resp.ok) throw new Error("Error del servidor (" + resp.status + ")");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === "progress") {
          setProgress(msg.done, msg.total, `Analizando jugada ${msg.done}/${msg.total}`);
        } else if (msg.type === "error") {
          throw new Error(msg.message);
        } else if (msg.type === "result") {
          onResult(msg);
          saveAnalyzedGames(pgn, msg);
        }
      }
    }
  } catch (err) {
    showError("No se pudo analizar: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Analizar partida(s)";
    document.getElementById("progress-wrap").classList.add("hidden");
  }
}

function onResult(result) {
  allGames = result.games;
  players = result.players || {};
  buildGlobalStats();
  buildGamesList();
  document.getElementById("results").classList.remove("hidden");
  selectGame(0);
  document.getElementById("results").scrollIntoView({ behavior: "smooth" });
}

function setProgress(done, total, text) {
  const pct = total ? (done / total) * 100 : 0;
  document.getElementById("progress-fill").style.width = pct + "%";
  document.getElementById("progress-text").textContent = text || "";
}

function showError(msg) {
  const box = document.getElementById("error-box");
  box.textContent = msg;
  box.classList.remove("hidden");
}
function hideError() { document.getElementById("error-box").classList.add("hidden"); }

// ---------- Eventos ----------

document.getElementById("analyze").addEventListener("click", analyze);
document.getElementById("nav-first").addEventListener("click", () => showPosition(0));
document.getElementById("nav-prev").addEventListener("click", () => showPosition(current - 1));
document.getElementById("nav-next").addEventListener("click", () => showPosition(current + 1));
document.getElementById("nav-last").addEventListener("click", () => showPosition(positions.length - 1));
document.getElementById("flip").addEventListener("click", flipBoard);

function flipBoard() {
  flipped = !flipped;
  renderTags();
  showPosition(current); // vuelve a dibujar tablero, flechas y coordenadas
}

document.addEventListener("keydown", (e) => {
  if (!analysis) return;
  const tag = document.activeElement.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  if (e.key === "ArrowLeft") { showPosition(current - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { showPosition(current + 1); e.preventDefault(); }
  if (e.key === "Home") { showPosition(0); }
  if (e.key === "End") { showPosition(positions.length - 1); }
  if (e.key === "f" || e.key === "F") { flipBoard(); }
});

// Carga de archivo .pgn
document.getElementById("load-file").addEventListener("click", () =>
  document.getElementById("file-input").click());
document.getElementById("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("pgn").value = reader.result; };
  reader.readAsText(file);
});

const EXAMPLE = `[White "boylemariotte"]
[Black "CR4CR3RX"]
[WhiteElo "1123"]
[BlackElo "1000"]
[Result "1-0"]
[Termination "checkmate"]
1. e4 d5 2. exd5 Qd8xd5 3. Nb1c3 Qd5d8 4. Ng1f3 e6 5. Bf1c4 g6 6. O-O Bf8g7 7. d4 Nb8c6 8. Bc1g5 f6 9. d5 exd5 10. Bc4xd5 fxg5 11. Bd5xc6 bxc6 12. Qd1xd8 Ke8xd8 13. Ra1d1 Bc8d7 14. Nf3xg5 Kd8e7 15. Rf1e1 Ke7f6 16. Ng5e4 Kf6f5 17. Ne4c5 Bd7c8 18. h3 Ng8h6 19. g4 Kf5g5 20. Re1e7 Bg7f6 21. Nc3e4 Kg5f4 22. Ne4xf6 Rh8f8 23. Rd1d4 Kf4f3 24. Nf6e4 Ra8b8 25. Ne4d2`;

document.getElementById("load-example").addEventListener("click", () => {
  document.getElementById("pgn").value = EXAMPLE;
});

// Entrenador de errores.
document.getElementById("pz-hint").addEventListener("click", puzzleHint);
document.getElementById("pz-solution").addEventListener("click", puzzleSolution);
document.getElementById("pz-next").addEventListener("click", puzzleNext);

// Copiar / descargar el reporte.
// Tabs (incluyendo la nueva pestaña "Mis partidas")
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById("tab-" + tab).classList.remove("hidden");
    if (tab === "saved") loadSavedList();
  });
});

document.getElementById("copy-report").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastReportText);
    document.getElementById("copy-msg").textContent = "¡Copiado!";
  } catch {
    document.getElementById("copy-msg").textContent = "No se pudo copiar (selecciona y copia manual).";
  }
});
document.getElementById("download-report").addEventListener("click", () => {
  const blob = new Blob([lastReportText], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "reporte_ajedrez.txt";
  a.click();
  URL.revokeObjectURL(a.href);
});
