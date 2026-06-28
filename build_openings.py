"""
Construye openings.json a partir de la base de aperturas de Lichess (TSV).

Para cada apertura conocida reproduce sus jugadas y guarda la POSICIÓN (EPD)
resultante asociada a su código ECO y nombre. Así, al analizar una partida,
podemos identificar la apertura buscando la última posición conocida.

Ejecutar una sola vez:  py build_openings.py
"""

import io
import json
import os
import urllib.request

import chess
import chess.pgn

BASE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master/"
FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"]
OUT = os.path.join(os.path.dirname(__file__), "openings.json")


def main():
    table = {}
    for fname in FILES:
        print("Descargando", fname, "...")
        data = urllib.request.urlopen(BASE + fname, timeout=60).read().decode("utf-8")
        lines = data.splitlines()
        for line in lines[1:]:               # saltar cabecera
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            eco, name, pgn = parts[0], parts[1], parts[2]
            game = chess.pgn.read_game(io.StringIO(pgn))
            if game is None:
                continue
            board = game.board()
            for mv in game.mainline_moves():
                board.push(mv)
            # Clave = posición (sin contadores de jugadas), valor = apertura.
            table[board.epd()] = {"eco": eco, "name": name}
        print("  acumuladas:", len(table))

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(table, f, ensure_ascii=False)
    print("Guardado", OUT, "con", len(table), "posiciones.")


if __name__ == "__main__":
    main()
