"""
Servidor web para analizar partidas de ajedrez.

Levanta una pequeña app Flask: sirve la interfaz (static/index.html) y expone
un endpoint /analyze que recibe el PGN y devuelve el análisis en streaming
(una línea JSON por evento) para poder mostrar una barra de progreso.

Uso:
    py app.py
    -> abre http://127.0.0.1:5000 en el navegador
"""

import json
import queue
import time
import threading
import webbrowser

from flask import Flask, request, Response, send_from_directory, jsonify

import analyzer
import play

app = Flask(__name__, static_folder="static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json(force=True)
    pgn_text = data.get("pgn", "")
    depth = int(data.get("depth", 15))

    def generate():
        # Cola para comunicar el progreso desde el hilo de análisis.
        q = queue.Queue()

        def progress(i, total):
            q.put(("progress", {"done": i, "total": total}))

        def worker():
            try:
                result = analyzer.analyze_games(pgn_text, depth=depth, progress=progress)
                q.put(("result", result))
            except Exception as exc:  # noqa: BLE001
                q.put(("error", {"message": str(exc)}))
            finally:
                q.put(("__end__", None))

        t = threading.Thread(target=worker, daemon=True)
        t.start()

        while True:
            kind, payload = q.get()
            if kind == "__end__":
                break
            yield json.dumps({"type": kind, **(payload or {})}) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


# ---------- Modo de juego ----------

def _play_endpoint(fn):
    """Envuelve una función de play.py devolviendo JSON o un error 400."""
    try:
        return jsonify(fn())
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400


@app.route("/play/profile")
def play_profile():
    return _play_endpoint(play.get_profile)


@app.route("/play/new", methods=["POST"])
def play_new():
    d = request.get_json(force=True)
    return _play_endpoint(lambda: play.new_game(
        color=d.get("color", "white"),
        mode=d.get("mode", "adaptive"),
        elo=d.get("elo", 1000)))


@app.route("/play/move", methods=["POST"])
def play_move():
    d = request.get_json(force=True)
    return _play_endpoint(lambda: play.user_move(
        d.get("from"), d.get("to"), d.get("promotion")))


@app.route("/play/resign", methods=["POST"])
def play_resign():
    return _play_endpoint(play.resign)


@app.route("/play/hint", methods=["POST"])
def play_hint():
    return _play_endpoint(play.hint)


@app.route("/play/takeback", methods=["POST"])
def play_takeback():
    return _play_endpoint(play.takeback)


@app.route("/play/pgn", methods=["POST"])
def play_pgn():
    return _play_endpoint(play.export_pgn)


def _open_browser_when_ready():
    """Abre el navegador una vez el servidor está listo."""
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:5000")


if __name__ == "__main__":
    print("=" * 50)
    print("  Ajedrez - Analiza y Juega")
    print("  Abriendo http://127.0.0.1:5000 en tu navegador...")
    print("  (Cierra esta ventana para apagar el programa.)")
    print("=" * 50)
    threading.Thread(target=_open_browser_when_ready, daemon=True).start()
    app.run(host="127.0.0.1", port=5000, threaded=True, debug=False)
