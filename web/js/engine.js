"use strict";

// Wrapper del motor Stockfish (WASM) sobre un Web Worker, con API de promesas.
// El motor corre en el navegador del usuario: no hay servidor de por medio.

class Engine {
  constructor(path = "js/engine/stockfish.js") {
    this.worker = new Worker(path);
    this.listeners = [];
    this.uciReady = false;
    this.worker.onmessage = (e) => {
      const line = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
      for (const l of this.listeners.slice()) l(line);
    };
  }

  send(cmd) { this.worker.postMessage(cmd); }
  _on(cb) { this.listeners.push(cb); }
  _off(cb) { this.listeners = this.listeners.filter((x) => x !== cb); }

  _until(pred) {
    return new Promise((res) => {
      const cb = (l) => { if (pred(l)) { this._off(cb); res(l); } };
      this._on(cb);
    });
  }

  // Inicializa el protocolo UCI (una sola vez).
  async init() {
    if (this.uciReady) return;
    this.send("uci");
    await this._until((l) => l === "uciok" || l.startsWith("uciok"));
    this.uciReady = true;
    await this.ready();
  }

  async ready() {
    this.send("isready");
    await this._until((l) => l.trim() === "readyok");
  }

  setoption(name, value) {
    this.send(`setoption name ${name} value ${value}`);
  }

  newGame() { this.send("ucinewgame"); }

  // Analiza una posición (FEN) hasta cierta profundidad.
  // Devuelve {bestmove, scoreCp|null, mate|null, pv:[...]} desde el punto de
  // vista del lado que mueve (estándar UCI).
  analyse(fen, depth) {
    return this._search(fen, `go depth ${depth}`);
  }

  // Para jugar: busca por tiempo (ms) — útil para limitar la fuerza del rival.
  bestmove(fen, movetimeMs) {
    return this._search(fen, `go movetime ${movetimeMs}`);
  }

  _search(fen, goCmd) {
    this.send("position fen " + fen);
    let last = { scoreCp: null, mate: null, pv: [] };
    return new Promise((res) => {
      const cb = (line) => {
        if (line.startsWith("info") && line.includes(" pv ")) {
          const parsed = parseInfo(line);
          if (parsed) last = parsed;
        } else if (line.startsWith("bestmove")) {
          this._off(cb);
          const bm = line.split(/\s+/)[1];
          res({ bestmove: bm, scoreCp: last.scoreCp, mate: last.mate, pv: last.pv });
        }
      };
      this._on(cb);
      this.send(goCmd);
    });
  }

  quit() { try { this.worker.terminate(); } catch (e) { /* */ } }
}

// Extrae score y pv de una línea "info ... score cp N ... pv e2e4 ...".
function parseInfo(line) {
  const out = { scoreCp: null, mate: null, pv: [] };
  const parts = line.split(/\s+/);
  const si = parts.indexOf("score");
  if (si >= 0) {
    if (parts[si + 1] === "cp") out.scoreCp = parseInt(parts[si + 2], 10);
    else if (parts[si + 1] === "mate") out.mate = parseInt(parts[si + 2], 10);
  }
  const pi = parts.indexOf("pv");
  if (pi >= 0) out.pv = parts.slice(pi + 1);
  if (out.scoreCp === null && out.mate === null) return null;
  return out;
}
