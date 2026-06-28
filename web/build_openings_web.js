// Construye web/data/openings.json para la versión web, usando chess.js
// (mismas posiciones que calculará el navegador). Ejecutar: node build_openings_web.js
const fs = require("fs");
const path = require("path");
const { Chess } = require("./js/chess.js");

const BASE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master/";
const FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"];

function epdKey(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

(async () => {
  const table = {};
  for (const f of FILES) {
    process.stdout.write("Descargando " + f + " ... ");
    const txt = await (await fetch(BASE + f)).text();
    const lines = txt.split("\n").slice(1);
    let n = 0;
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [eco, name, pgn] = parts;
      const c = new Chess();
      if (!c.load_pgn(pgn)) continue;
      table[epdKey(c.fen())] = { eco, name };
      n++;
    }
    console.log(n, "aperturas");
  }
  const outDir = path.join(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "openings.json"), JSON.stringify(table));
  console.log("Guardado web/data/openings.json con", Object.keys(table).length, "posiciones.");
})();
