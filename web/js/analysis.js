"use strict";

// Análisis de partidas en el navegador. Replica analyzer.py usando chess.js
// (reglas/SAN/PGN) y el motor Stockfish WASM (clase Engine).

// Compatibilidad con Node (para pruebas): obtener Chess vía require.
if (typeof Chess === "undefined" && typeof require !== "undefined") {
  var Chess = require("./chess.js").Chess;
}

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_ES = { p: "peón", n: "caballo", b: "alfil", r: "torre", q: "dama", k: "rey" };

const CLASSIFICATION = [
  [10, "Excelente", "!!"],
  [25, "Buena", "!"],
  [50, "Imprecisión", "?!"],
  [100, "Inexacta", "?!"],
  [200, "Error", "?"],
  [Infinity, "Blunder", "??"],
];

const LABEL_COLOR = {
  "Mejor jugada": "#27ae60", "Excelente": "#2ecc71", "Buena": "#7fb800",
  "Imprecisión": "#f1c40f", "Inexacta": "#e67e22", "Error": "#e74c3c",
  "Blunder": "#c0392b", "Forzada": "#3498db",
};

const BAD_LABELS = new Set(["Imprecisión", "Inexacta", "Error", "Blunder"]);

let _openings = null;
async function loadOpenings() {
  if (_openings === null) {
    if (typeof window === "undefined" && typeof require !== "undefined") {
      try { _openings = require("../data/openings.json"); } catch (e) { _openings = {}; }
    } else {
      try { _openings = await (await fetch("data/openings.json")).json(); } catch (e) { _openings = {}; }
    }
  }
  return _openings;
}

function classify(cpLoss, isBest, onlyMove) {
  if (onlyMove) return ["Forzada", ""];
  if (isBest) return ["Mejor jugada", "*"];
  for (const [maxLoss, label, symbol] of CLASSIFICATION) {
    if (cpLoss <= maxLoss) return [label, symbol];
  }
  return ["Blunder", "??"];
}

// Centipeones desde el punto de vista del lado que mueve en la posición analizada.
function sideToMoveCp(res) {
  if (res.mate !== null && res.mate !== undefined) {
    return res.mate > 0 ? 10000 - res.mate * 10 : -10000 - res.mate * 10;
  }
  return res.scoreCp;
}

function winPercent(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
function accuracyFromWin(before, after) {
  const drop = Math.max(0, before - after);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

function ratingLabel(acc) {
  if (acc >= 95) return "Maestría";
  if (acc >= 90) return "Excelente";
  if (acc >= 80) return "Muy buena";
  if (acc >= 70) return "Buena";
  if (acc >= 60) return "Regular";
  if (acc >= 50) return "Floja";
  return "A mejorar";
}

function epdKey(fen) { return fen.split(" ").slice(0, 4).join(" "); }

function detectOpening(openings, sanMoves) {
  if (!openings) return null;
  const c = new Chess();
  let found = null, endPly = 0;
  for (let i = 0; i < sanMoves.length && i < 30; i++) {
    if (!c.move(sanMoves[i])) break;
    const key = epdKey(c.fen());
    if (openings[key]) { found = openings[key]; endPly = i + 1; }
  }
  return found ? { eco: found.eco, name: found.name, theory_end_ply: endPly } : null;
}

// Explica por qué una jugada fue mala. boardAfter = chess.js tras la jugada.
function explain(boardAfter, best, after, bestSan, isBest, cpLoss, label) {
  if (!BAD_LABELS.has(label)) return "";

  // ¿Te perdiste un mate? (best desde el lado que movía)
  if (best.mate !== null && best.mate !== undefined && best.mate > 0 && !isBest) {
    return `Te pierdes un mate en ${best.mate}: lo ganador era ${bestSan}.`;
  }
  // ¿Permitiste mate? (after desde el rival, que ahora mueve)
  if (after.mate !== null && after.mate !== undefined && after.mate > 0) {
    return `Permites un mate en ${after.mate} para el rival.`;
  }
  // ¿Cuelgas material? La mejor respuesta del rival captura.
  const reply = after.pv && after.pv[0];
  if (reply && reply.length >= 4) {
    const to = reply.slice(2, 4);
    const captured = boardAfter.get(to);
    if (captured && PIECE_VALUE[captured.type] >= 1) {
      const capName = PIECE_ES[captured.type];
      // SAN de la respuesta para mostrarla.
      let replySan = reply;
      const tmp = new Chess(boardAfter.fen());
      const mv = tmp.move({ from: reply.slice(0, 2), to, promotion: reply[4] || "q" });
      if (mv) replySan = mv.san;
      return `Cuelgas tu ${capName} en ${to}: el rival juega ${replySan} y gana material. Mejor era ${bestSan}.`;
    }
  }
  return `Pierdes ${(cpLoss / 100).toFixed(2)} de ventaja. La jugada precisa era ${bestSan}.`;
}

// Analiza un PGN (uno o varios juegos). progress(done, total).
async function analyzeGames(pgnText, depth, engine, progress) {
  const openings = await loadOpenings();
  const games = parsePgnGames(pgnText);
  if (games.length === 0) throw new Error("No se pudo leer ninguna partida del texto PGN.");

  const grandTotal = games.reduce((s, g) => s + g.sanMoves.length, 0);
  let done = 0;
  const results = [];

  await engine.init();
  for (const g of games) {
    results.push(await analyzeOneGame(g, openings, depth, engine,
      () => { done++; if (progress) progress(done, grandTotal); }));
  }
  return { games: results, players: aggregatePlayers(results) };
}

async function analyzeOneGame(g, openings, depth, engine, tick) {
  engine.newGame();
  const board = new Chess();
  const moves = [];
  const evalCurve = [];
  const accSum = { w: 0, b: 0 }, accN = { w: 0, b: 0 };
  const counts = { w: {}, b: {} };

  for (let i = 0; i < g.sanMoves.length; i++) {
    const san = g.sanMoves[i];
    const moverIsWhite = board.turn() === "w";
    const fenBefore = board.fen();

    const best = await engine.analyse(fenBefore, depth);
    const cpBefore = sideToMoveCp(best);
    // SAN de la mejor jugada del motor.
    const bestUci = best.bestmove;
    let bestSan = bestUci;
    {
      const tmp = new Chess(fenBefore);
      const bm = tmp.move({ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), promotion: bestUci[4] || "q" });
      if (bm) bestSan = bm.san;
    }
    const legalCount = board.moves().length;
    const onlyMove = legalCount === 1;

    // Aplicar la jugada real.
    const moveObj = board.move(san);
    if (!moveObj) throw new Error("Jugada ilegal en el PGN: " + san);
    const playedUci = moveObj.from + moveObj.to + (moveObj.promotion || "");

    // Evaluar la posición resultante (salvo que la partida ya haya terminado).
    let after = { scoreCp: null, mate: null, pv: [] };
    let cpAfter;
    if (board.game_over()) {
      cpAfter = board.in_checkmate() ? 10000 : 0;   // mate a favor / tablas
    } else {
      after = await engine.analyse(board.fen(), depth);
      cpAfter = -sideToMoveCp(after);               // negar: ahora mueve el rival
    }

    let cpLoss = Math.max(0, cpBefore - cpAfter);
    let isBest = (playedUci === bestUci) || (playedUci.slice(0, 4) === bestUci.slice(0, 4));
    if (board.in_checkmate()) { cpLoss = 0; isBest = true; cpAfter = 10000; }
    let [label, symbol] = classify(cpLoss, isBest, onlyMove);

    const wpBefore = winPercent(cpBefore);
    const wpAfter = winPercent(cpAfter);
    const moveAcc = accuracyFromWin(wpBefore, wpAfter);
    const ck = moverIsWhite ? "w" : "b";
    accSum[ck] += moveAcc; accN[ck]++;
    counts[ck][label] = (counts[ck][label] || 0) + 1;

    const expl = explain(board, best, after, bestSan, isBest, cpLoss, label);
    const evalWhite = moverIsWhite ? cpAfter : -cpAfter;
    evalCurve.push(evalWhite);

    moves.push({
      ply: i + 1, move_no: Math.floor(i / 2) + 1,
      color: moverIsWhite ? "white" : "black",
      san: moveObj.san, uci: playedUci,
      best_san: bestSan, best_uci: bestUci,
      fen: board.fen(), eval_cp: cpAfter, eval_white: evalWhite,
      cp_loss: cpLoss, label, symbol, color_hex: LABEL_COLOR[label] || "#888",
      accuracy: Math.round(moveAcc * 10) / 10, is_best: isBest, explanation: expl,
    });
    tick();
  }

  const summarize = (ck) => {
    const n = accN[ck];
    const avg = n ? accSum[ck] / n : 0;
    return { accuracy: Math.round(avg * 10) / 10, rating_label: ratingLabel(avg), counts: counts[ck], moves: n };
  };
  const white = g.headers.White || "Blancas";
  const black = g.headers.Black || "Negras";
  return {
    headers: g.headers,
    label: `${white} vs ${black}  (${g.headers.Result || "*"})`,
    start_fen: new Chess().fen(),
    opening: detectOpening(openings, g.sanMoves),
    moves, eval_curve: evalCurve,
    summary: { white: summarize("w"), black: summarize("b") },
  };
}

function aggregatePlayers(games) {
  const players = {};
  const add = (name, side, result, isWhite) => {
    const p = players[name] || (players[name] = { games: 0, acc: [], counts: {}, wins: 0, draws: 0, losses: 0, moves: 0 });
    p.games++; p.acc.push(side.accuracy); p.moves += side.moves;
    for (const k in side.counts) p.counts[k] = (p.counts[k] || 0) + side.counts[k];
    if (result === "1-0") p[isWhite ? "wins" : "losses"]++;
    else if (result === "0-1") p[isWhite ? "losses" : "wins"]++;
    else if (result === "1/2-1/2") p.draws++;
  };
  for (const g of games) {
    const res = g.headers.Result || "*";
    add(g.headers.White || "Blancas", g.summary.white, res, true);
    add(g.headers.Black || "Negras", g.summary.black, res, false);
  }
  const out = {};
  for (const name in players) {
    const p = players[name];
    const avg = p.acc.length ? p.acc.reduce((a, b) => a + b, 0) / p.acc.length : 0;
    out[name] = {
      games: p.games, accuracy: Math.round(avg * 10) / 10, rating_label: ratingLabel(avg),
      counts: p.counts, moves: p.moves,
      blunders: p.counts["Blunder"] || 0, errors: p.counts["Error"] || 0,
      record: `${p.wins}V / ${p.draws}E / ${p.losses}D`,
    };
  }
  return out;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Separa un texto PGN en partidas. Extrae las cabeceras a mano (chess.js es
// quisquilloso con ciertas cabeceras) y deja que chess.js parsee solo las
// jugadas en modo "sloppy" (acepta notación larga como Qd8xd5, Nb1c3).
function parsePgnGames(text) {
  const chunks = splitPgn(text);
  const games = [];
  for (const chunk of chunks) {
    const headers = {};
    const re = /\[(\w+)\s+"([^"]*)"\]/g;
    let m;
    while ((m = re.exec(chunk)) !== null) headers[m[1]] = m[2];

    const movetext = chunk.split("\n").filter((l) => !l.trim().startsWith("[")).join(" ").trim();
    if (!movetext) continue;

    const c = new Chess();
    let pgnClean = movetext;
    if (headers.FEN && headers.FEN !== START_FEN) {
      pgnClean = `[SetUp "1"]\n[FEN "${headers.FEN}"]\n\n${movetext}`;
    }
    if (!c.load_pgn(pgnClean, { sloppy: true })) continue;
    const history = c.history();
    if (history.length === 0) continue;
    games.push({ headers, sanMoves: history });
  }
  return games;
}

function splitPgn(text) {
  // Inserta separadores antes de cada bloque de cabeceras tras un resultado.
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Si hay varias partidas, normalmente se separan por una línea en blanco
  // entre el resultado de una y las cabeceras de la siguiente.
  const parts = trimmed.split(/\n\s*\n(?=\[)/);
  if (parts.length > 1) return parts;
  return [trimmed];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { analyzeGames, parsePgnGames, detectOpening, loadOpenings, classify, sideToMoveCp };
}
