"""
Modo de juego: jugar contra Stockfish con dificultad adaptativa y estimación
de Elo que se guarda entre partidas.

- El motor juega a una fuerza objetivo (adaptativa = tu Elo actual, o fija).
- Cada jugada tuya se evalúa con el motor a plena fuerza para clasificarla
  (mejor, buena, imprecisión, error, blunder) y medir tu pérdida de centipeones.
- Al terminar la partida se actualiza tu Elo combinando el resultado (fórmula
  Elo) con tu rendimiento real (pérdida media de centipeones) y se guarda en
  profile.json.

El estado de la partida vive en memoria (un único juego local a la vez).
"""

import os
import json
import random
import threading
from datetime import date

import chess
import chess.engine
import chess.pgn

from analyzer import ENGINE_PATH, _score_to_cp, _classify, LABEL_COLOR

PROFILE_PATH = os.path.join(os.path.dirname(__file__), "profile.json")
ANALYSIS_DEPTH = 12          # fuerza con la que se juzgan TUS jugadas
ENGINE_TIME = 0.3            # tiempo de cálculo del rival por jugada (s)

_lock = threading.Lock()
GAME = None                  # partida activa (una sola, uso local)


# ---------- Perfil / Elo persistente ----------

def load_profile():
    if os.path.exists(PROFILE_PATH):
        try:
            with open(PROFILE_PATH, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"elo": 1000, "games": 0, "wins": 0, "draws": 0, "losses": 0,
            "last_acpl": None, "last_result": None, "delta": 0, "elo_history": []}


def save_profile(p):
    with open(PROFILE_PATH, "w", encoding="utf-8") as f:
        json.dump(p, f, ensure_ascii=False, indent=2)


def elo_rank(elo):
    if elo >= 2200:
        return "Maestro"
    if elo >= 2000:
        return "Experto"
    if elo >= 1800:
        return "Avanzado"
    if elo >= 1500:
        return "Intermedio alto"
    if elo >= 1200:
        return "Intermedio"
    if elo >= 900:
        return "Principiante avanzado"
    return "Principiante"


def acpl_to_elo(acpl):
    """Estimación cruda de fuerza a partir de la pérdida media de centipeones."""
    return max(400, min(2600, 2600 - 14 * acpl))


# ---------- Motor ----------

def _open_engine(threads):
    e = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
    try:
        e.configure({"Threads": threads})
    except Exception:
        pass
    return e


def _configure_strength(engine, elo):
    """Ajusta la fuerza del motor rival a un Elo objetivo."""
    try:
        if elo >= 1320:
            engine.configure({"UCI_LimitStrength": True,
                              "UCI_Elo": int(max(1320, min(2850, elo)))})
        else:
            engine.configure({"UCI_LimitStrength": False})
            skill = max(0, min(20, round((elo - 700) / 90)))
            engine.configure({"Skill Level": skill})
    except Exception:
        pass


class Game:
    def __init__(self, user_color, engine_elo, mode):
        self.board = chess.Board()
        self.user_color = user_color
        self.engine_elo = engine_elo
        self.mode = mode
        self.cp_losses = []
        self.over = False
        self.ana = _open_engine(2)             # analiza tus jugadas (plena fuerza)
        self.opp = _open_engine(1)             # juega contra ti (fuerza limitada)
        _configure_strength(self.opp, engine_elo)

    def close(self):
        for e in (self.ana, self.opp):
            try:
                e.quit()
            except Exception:
                pass


# ---------- Utilidades ----------

def _legal_map(board):
    """Diccionario {casilla_origen: [casillas_destino]} para la jugada del humano."""
    m = {}
    for mv in board.legal_moves:
        m.setdefault(chess.square_name(mv.from_square), []).append(
            chess.square_name(mv.to_square))
    return m


def _status(board):
    if board.is_checkmate():
        return "checkmate"
    if board.is_stalemate():
        return "stalemate"
    if (board.is_insufficient_material() or board.is_seventyfive_moves()
            or board.is_fivefold_repetition()):
        return "draw"
    return "playing"


def _engine_reply(game):
    res = game.opp.play(game.board, chess.engine.Limit(time=ENGINE_TIME))
    mv = res.move
    san = game.board.san(mv)
    game.board.push(mv)
    return {"uci": mv.uci(), "san": san}


# ---------- API pública ----------

def new_game(color="white", mode="adaptive", elo=1000):
    global GAME
    with _lock:
        if GAME:
            GAME.close()
        profile = load_profile()
        if color == "random":
            color = random.choice(["white", "black"])
        user_color = chess.WHITE if color == "white" else chess.BLACK
        engine_elo = profile["elo"] if mode == "adaptive" else int(elo)
        engine_elo = max(500, min(2800, engine_elo))
        GAME = Game(user_color, engine_elo, mode)

        engine_move = None
        if user_color == chess.BLACK:
            engine_move = _engine_reply(GAME)

        return {
            "your_color": color,
            "engine_elo": engine_elo,
            "engine_rank": elo_rank(engine_elo),
            "mode": mode,
            "fen": GAME.board.fen(),
            "legal": _legal_map(GAME.board),
            "status": "playing",
            "engine_move": engine_move,
            "in_check": GAME.board.is_check(),
            "profile": _profile_view(profile),
        }


def user_move(frm, to, promo=None):
    global GAME
    with _lock:
        if not GAME or GAME.over:
            raise ValueError("No hay ninguna partida activa.")
        board = GAME.board
        if board.turn != GAME.user_color:
            raise ValueError("No es tu turno.")

        move = _build_move(board, frm, to, promo)
        mover = board.turn

        # Evaluar tu jugada a plena fuerza.
        info_best = GAME.ana.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
        best_move = info_best["pv"][0]
        cp_before = _score_to_cp(info_best["score"], mover)
        best_san = board.san(best_move)
        only_move = board.legal_moves.count() == 1
        played_san = board.san(move)

        board.push(move)
        info_after = GAME.ana.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
        cp_after = _score_to_cp(info_after["score"], mover)
        cp_loss = max(0, cp_before - cp_after)
        is_best = (move == best_move)
        if board.is_checkmate():           # dar mate nunca es error
            cp_loss, is_best = 0, True
        label, symbol = _classify(cp_loss, is_best, only_move)
        GAME.cp_losses.append(cp_loss)

        your_move = {
            "san": played_san, "uci": move.uci(),
            "label": label, "symbol": symbol, "cp_loss": cp_loss,
            "best_san": best_san, "best_uci": best_move.uci(),
            "is_best": is_best, "color_hex": LABEL_COLOR.get(label, "#888"),
        }
        eval_white = cp_after if mover == chess.WHITE else -cp_after

        status = _status(board)
        engine_move = None
        if status == "playing":
            engine_move = _engine_reply(GAME)
            status = _status(board)

        profile = None
        if status != "playing":
            profile = _finish(GAME, status)

        return {
            "fen": board.fen(),
            "your_move": your_move,
            "engine_move": engine_move,
            "legal": _legal_map(board),
            "status": status,
            "eval_white": eval_white,
            "in_check": board.is_check(),
            "profile": profile,
        }


def resign():
    global GAME
    with _lock:
        if not GAME or GAME.over:
            raise ValueError("No hay ninguna partida activa.")
        return _finish(GAME, "resign")


def hint():
    with _lock:
        if not GAME or GAME.over:
            raise ValueError("No hay ninguna partida activa.")
        info = GAME.ana.analyse(GAME.board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
        best = info["pv"][0]
        return {"best_uci": best.uci(), "best_san": GAME.board.san(best)}


# ---------- Internos ----------

def _build_move(board, frm, to, promo):
    """Construye una jugada legal; corona a dama por defecto si hace falta."""
    try:
        move = chess.Move.from_uci(frm + to + (promo or ""))
    except ValueError:
        raise ValueError("Jugada inválida.")
    if move in board.legal_moves:
        return move
    # Quizá falta la coronación: probar con dama.
    queen = chess.Move.from_uci(frm + to + "q")
    if queen in board.legal_moves:
        return queen
    raise ValueError("Esa jugada no es legal.")


def _finish(game, status):
    game.over = True
    board = game.board
    if status == "checkmate":
        winner = not board.turn          # quien dio mate (board.turn = bando ahogado)
        score = 1.0 if winner == game.user_color else 0.0
    elif status == "resign":
        score = 0.0
    else:
        score = 0.5                       # tablas
    profile = _update_profile(game, score, status)
    game.close()
    return profile


def _update_profile(game, score, status):
    p = load_profile()
    user_elo = p["elo"]
    expected = 1 / (1 + 10 ** ((game.engine_elo - user_elo) / 400))
    new = user_elo + 32 * (score - expected)

    # El rendimiento (pérdida media de centipeones) solo se mezcla con una
    # muestra suficiente de jugadas, y con poco peso, para que el Elo sea estable.
    acpl = None
    if len(game.cp_losses) >= 6:
        acpl = sum(game.cp_losses) / len(game.cp_losses)
        new = 0.85 * new + 0.15 * acpl_to_elo(acpl)
    elif game.cp_losses:
        acpl = sum(game.cp_losses) / len(game.cp_losses)

    # Limitar el cambio por partida para que progrese gradualmente.
    delta = max(-40, min(40, round(new) - user_elo))
    new = int(max(400, min(2800, user_elo + delta)))
    p["delta"] = new - user_elo
    p["elo"] = new
    p["games"] += 1
    if score == 1.0:
        p["wins"] += 1
    elif score == 0.0:
        p["losses"] += 1
    else:
        p["draws"] += 1
    p["last_acpl"] = round(acpl, 1) if acpl is not None else None
    p["last_result"] = ("win" if score == 1.0 else
                        "loss" if score == 0.0 else "draw")
    p["last_status"] = status
    p.setdefault("elo_history", []).append({
        "elo": new,
        "result": p["last_result"],
        "date": date.today().isoformat(),
    })
    p["elo_history"] = p["elo_history"][-100:]   # conservar las últimas 100
    save_profile(p)
    return _profile_view(p)


def _profile_view(p):
    v = dict(p)
    v["rank"] = elo_rank(p["elo"])
    return v


def get_profile():
    return _profile_view(load_profile())


def takeback():
    """Deshace tu última jugada (y la respuesta del rival)."""
    with _lock:
        if not GAME or GAME.over:
            raise ValueError("No hay ninguna partida activa.")
        if not GAME.cp_losses:
            raise ValueError("No hay jugadas tuyas para deshacer.")
        board = GAME.board
        # Quitar la respuesta del rival (si la hubo) y luego tu jugada.
        if board.move_stack and board.turn == GAME.user_color:
            board.pop()
        if board.move_stack:
            board.pop()
        GAME.cp_losses.pop()
        return {
            "fen": board.fen(),
            "legal": _legal_map(board),
            "status": "playing",
            "in_check": board.is_check(),
        }


def export_pgn():
    """Devuelve la partida actual/última en formato PGN."""
    with _lock:
        if not GAME:
            raise ValueError("No hay ninguna partida para exportar.")
        board = GAME.board
        game = chess.pgn.Game.from_board(board)
        you = "Tú"
        ai = f"IA (Elo {GAME.engine_elo})"
        if GAME.user_color == chess.WHITE:
            game.headers["White"], game.headers["Black"] = you, ai
        else:
            game.headers["White"], game.headers["Black"] = ai, you
        game.headers["Event"] = "Partida contra la IA"
        game.headers["Date"] = date.today().strftime("%Y.%m.%d")
        game.headers["Result"] = board.result(claim_draw=True) if GAME.over else "*"
        exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        return {"pgn": game.accept(exporter)}
