"""
Servidor web para analizar partidas de ajedrez con soporte multi-usuario.
"""
import json
import os
import queue
import threading
import time
import webbrowser

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, request, Response, send_from_directory, jsonify, session, redirect

import analyzer
import play as play_mod
from auth import register_user, login_user, current_user_id, login_required
from db import init_db, get_session, AnalyzedGame

app = Flask(__name__, static_folder="static")
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-in-production")

init_db()


# ---------- Autenticación ----------

@app.route("/login", methods=["GET"])
def login_page():
    if session.get("user_id"):
        return redirect("/")
    return send_from_directory("static", "login.html")


@app.route("/login", methods=["POST"])
def do_login():
    d = request.get_json(force=True)
    user, error = login_user(d.get("username", ""), d.get("password", ""))
    if error:
        return jsonify({"error": error}), 401
    session["user_id"] = user.id
    session["username"] = user.username
    return jsonify({"username": user.username})


@app.route("/register", methods=["POST"])
def do_register():
    d = request.get_json(force=True)
    user, error = register_user(d.get("username", ""), d.get("password", ""))
    if error:
        return jsonify({"error": error}), 400
    session["user_id"] = user.id
    session["username"] = user.username
    return jsonify({"username": user.username})


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/me")
def me():
    uid = session.get("user_id")
    if not uid:
        return jsonify({"authenticated": False})
    return jsonify({"authenticated": True, "username": session.get("username"), "user_id": uid})


# ---------- Principal ----------

@app.route("/")
@login_required
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


# ---------- Análisis ----------

@app.route("/analyze", methods=["POST"])
@login_required
def analyze():
    data = request.get_json(force=True)
    pgn_text = data.get("pgn", "")
    depth = int(data.get("depth", 15))

    def generate():
        q = queue.Queue()

        def progress(i, total):
            q.put(("progress", {"done": i, "total": total}))

        def worker():
            try:
                result = analyzer.analyze_games(pgn_text, depth=depth, progress=progress)
                q.put(("result", result))
            except Exception as exc:
                q.put(("error", {"message": str(exc)}))
            finally:
                q.put(("__end__", None))

        threading.Thread(target=worker, daemon=True).start()
        while True:
            kind, payload = q.get()
            if kind == "__end__":
                break
            yield json.dumps({"type": kind, **(payload or {})}) + "\n"

    return Response(generate(), mimetype="application/x-ndjson")


# ---------- Partidas guardadas ----------

@app.route("/games", methods=["GET"])
@login_required
def list_games():
    uid = current_user_id()
    db = get_session()
    try:
        games = (db.query(AnalyzedGame)
                   .filter_by(user_id=uid)
                   .order_by(AnalyzedGame.analyzed_at.desc())
                   .all())
        return jsonify([{
            "id": g.id,
            "label": g.label,
            "analyzed_at": g.analyzed_at.isoformat(),
        } for g in games])
    finally:
        db.close()


@app.route("/games/save", methods=["POST"])
@login_required
def save_game():
    uid = current_user_id()
    d = request.get_json(force=True)
    db = get_session()
    try:
        game = AnalyzedGame(
            user_id=uid,
            label=d.get("label", "Partida sin nombre"),
            pgn_text=d.get("pgn_text", ""),
            analysis_json=json.dumps(d.get("analysis")),
        )
        db.add(game)
        db.commit()
        return jsonify({"id": game.id})
    finally:
        db.close()


@app.route("/games/<int:game_id>", methods=["GET"])
@login_required
def get_game(game_id):
    uid = current_user_id()
    db = get_session()
    try:
        game = db.query(AnalyzedGame).filter_by(id=game_id, user_id=uid).first()
        if not game:
            return jsonify({"error": "Partida no encontrada"}), 404
        return jsonify({
            "id": game.id,
            "label": game.label,
            "pgn_text": game.pgn_text,
            "analysis": json.loads(game.analysis_json),
            "analyzed_at": game.analyzed_at.isoformat(),
        })
    finally:
        db.close()


@app.route("/games/<int:game_id>", methods=["DELETE"])
@login_required
def delete_game(game_id):
    uid = current_user_id()
    db = get_session()
    try:
        game = db.query(AnalyzedGame).filter_by(id=game_id, user_id=uid).first()
        if not game:
            return jsonify({"error": "Partida no encontrada"}), 404
        db.delete(game)
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


# ---------- Modo de juego ----------

def _play_endpoint(fn):
    try:
        return jsonify(fn())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/play/profile")
@login_required
def play_profile():
    return _play_endpoint(lambda: play_mod.get_profile(current_user_id()))


@app.route("/play/new", methods=["POST"])
@login_required
def play_new():
    d = request.get_json(force=True)
    uid = current_user_id()
    return _play_endpoint(lambda: play_mod.new_game(
        uid, color=d.get("color", "white"),
        mode=d.get("mode", "adaptive"), elo=d.get("elo", 1000)))


@app.route("/play/move", methods=["POST"])
@login_required
def play_move():
    d = request.get_json(force=True)
    uid = current_user_id()
    return _play_endpoint(lambda: play_mod.user_move(
        uid, d.get("from"), d.get("to"), d.get("promotion")))


@app.route("/play/resign", methods=["POST"])
@login_required
def play_resign():
    return _play_endpoint(lambda: play_mod.resign(current_user_id()))


@app.route("/play/hint", methods=["POST"])
@login_required
def play_hint():
    return _play_endpoint(lambda: play_mod.hint(current_user_id()))


@app.route("/play/takeback", methods=["POST"])
@login_required
def play_takeback():
    return _play_endpoint(lambda: play_mod.takeback(current_user_id()))


@app.route("/play/pgn", methods=["POST"])
@login_required
def play_pgn():
    return _play_endpoint(lambda: play_mod.export_pgn(current_user_id()))


# ---------- Arranque local ----------

def _open_browser():
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:5000")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    is_local = port == 5000
    print("=" * 50)
    print("  Ajedrez - Analiza y Juega")
    if is_local:
        print("  Abriendo http://127.0.0.1:5000 en tu navegador...")
        threading.Thread(target=_open_browser, daemon=True).start()
    print("  (Cierra esta ventana para apagar el programa.)")
    print("=" * 50)
    host = "127.0.0.1" if is_local else "0.0.0.0"
    app.run(host=host, port=port, threaded=True, debug=False)
