"""
Modo de juego: jugar contra Stockfish con dificultad adaptativa y estimación
de Elo persistida en base de datos por usuario.
"""
import random
import threading
from datetime import date

import chess
import chess.engine
import chess.pgn

from analyzer import ENGINE_PATH, _score_to_cp, _classify, LABEL_COLOR
from db import get_session, PlayProfile, EloHistory

ANALYSIS_DEPTH = 12
ENGINE_TIME = 0.3

# Partidas activas en memoria: user_id → Game
_GAMES: dict = {}
_dict_lock = threading.Lock()   # protege el dict _GAMES
_user_locks: dict = {}          # lock por usuario para serializar sus propias jugadas


def _get_lock(user_id: int) -> threading.Lock:
    with _dict_lock:
        if user_id not in _user_locks:
            _user_locks[user_id] = threading.Lock()
        return _user_locks[user_id]


# ---------- Perfil / Elo (base de datos) ----------

def _load_profile(user_id: int) -> dict:
    db = get_session()
    try:
        p = db.query(PlayProfile).filter_by(user_id=user_id).first()
        if not p:
            return {"elo": 1000, "games": 0, "wins": 0, "draws": 0, "losses": 0,
                    "last_acpl": None, "last_result": None, "last_status": None,
                    "delta": 0, "elo_history": []}
        rows = (db.query(EloHistory)
                  .filter_by(user_id=user_id)
                  .order_by(EloHistory.recorded_at)
                  .all())
        history = [{"elo": r.elo, "result": r.result,
                    "date": r.date.isoformat()} for r in rows[-100:]]
        return {
            "elo": p.elo, "games": p.games,
            "wins": p.wins, "draws": p.draws, "losses": p.losses,
            "last_acpl": p.last_acpl, "last_result": p.last_result,
            "last_status": p.last_status, "delta": p.delta,
            "elo_history": history,
        }
    finally:
        db.close()


def _save_profile(user_id: int, data: dict):
    db = get_session()
    try:
        p = db.query(PlayProfile).filter_by(user_id=user_id).first()
        if not p:
            p = PlayProfile(user_id=user_id)
            db.add(p)
        p.elo = data["elo"]
        p.games = data["games"]
        p.wins = data["wins"]
        p.draws = data["draws"]
        p.losses = data["losses"]
        p.last_acpl = data.get("last_acpl")
        p.last_result = data.get("last_result")
        p.last_status = data.get("last_status")
        p.delta = data.get("delta", 0)
        db.commit()
    finally:
        db.close()


def _append_elo_history(user_id: int, elo: int, result: str):
    db = get_session()
    try:
        db.add(EloHistory(user_id=user_id, elo=elo,
                          result=result, date=date.today()))
        db.commit()
    finally:
        db.close()


def elo_rank(elo: int) -> str:
    if elo >= 2200: return "Maestro"
    if elo >= 2000: return "Experto"
    if elo >= 1800: return "Avanzado"
    if elo >= 1500: return "Intermedio alto"
    if elo >= 1200: return "Intermedio"
    if elo >= 900:  return "Principiante avanzado"
    return "Principiante"


def acpl_to_elo(acpl: float) -> int:
    return max(400, min(2600, 2600 - 14 * acpl))


# ---------- Motor ----------

def _open_engine(threads: int):
    e = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
    try:
        e.configure({"Threads": threads})
    except Exception:
        pass
    return e


def _configure_strength(engine, elo: int):
    try:
        if elo >= 1320:
            engine.configure({"UCI_LimitStrength": True,
                              "UCI_Elo": int(max(1320, min(2850, elo)))})
        else:
            engine.configure({"UCI_LimitStrength": False,
                              "Skill Level": max(0, min(20, round((elo - 700) / 90)))})
    except Exception:
        pass


class Game:
    def __init__(self, user_color, engine_elo, mode):
        self.board = chess.Board()
        self.user_color = user_color
        self.engine_elo = engine_elo
        self.mode = mode
        self.cp_losses: list[int] = []
        self.over = False
        self.ana = _open_engine(2)
        self.opp = _open_engine(1)
        _configure_strength(self.opp, engine_elo)

    def close(self):
        for e in (self.ana, self.opp):
            try:
                e.quit()
            except Exception:
                pass


# ---------- Utilidades ----------

def _legal_map(board: chess.Board) -> dict:
    m: dict = {}
    for mv in board.legal_moves:
        m.setdefault(chess.square_name(mv.from_square), []).append(
            chess.square_name(mv.to_square))
    return m


def _status(board: chess.Board) -> str:
    if board.is_checkmate(): return "checkmate"
    if board.is_stalemate(): return "stalemate"
    if (board.is_insufficient_material() or board.is_seventyfive_moves()
            or board.is_fivefold_repetition()):
        return "draw"
    return "playing"


def _engine_reply(game: Game) -> dict:
    res = game.opp.play(game.board, chess.engine.Limit(time=ENGINE_TIME))
    mv = res.move
    san = game.board.san(mv)
    game.board.push(mv)
    return {"uci": mv.uci(), "san": san}


def _build_move(board: chess.Board, frm: str, to: str, promo: str | None) -> chess.Move:
    try:
        move = chess.Move.from_uci(frm + to + (promo or ""))
    except ValueError:
        raise ValueError("Jugada inválida.")
    if move in board.legal_moves:
        return move
    queen = chess.Move.from_uci(frm + to + "q")
    if queen in board.legal_moves:
        return queen
    raise ValueError("Esa jugada no es legal.")


# ---------- API pública ----------

def new_game(user_id: int, color="white", mode="adaptive", elo=1000) -> dict:
    lock = _get_lock(user_id)
    with lock:
        with _dict_lock:
            if user_id in _GAMES:
                _GAMES[user_id].close()
        profile = _load_profile(user_id)
        if color == "random":
            color = random.choice(["white", "black"])
        user_color = chess.WHITE if color == "white" else chess.BLACK
        engine_elo = int(profile["elo"] if mode == "adaptive" else elo)
        engine_elo = max(500, min(2800, engine_elo))
        game = Game(user_color, engine_elo, mode)
        with _dict_lock:
            _GAMES[user_id] = game

        engine_move = None
        if user_color == chess.BLACK:
            engine_move = _engine_reply(game)

        return {
            "your_color": color, "engine_elo": engine_elo,
            "engine_rank": elo_rank(engine_elo), "mode": mode,
            "fen": game.board.fen(), "legal": _legal_map(game.board),
            "status": "playing", "engine_move": engine_move,
            "in_check": game.board.is_check(),
            "profile": _profile_view(profile),
        }


def user_move(user_id: int, frm: str, to: str, promo: str | None = None) -> dict:
    lock = _get_lock(user_id)
    with lock:
        game = _GAMES.get(user_id)
        if not game or game.over:
            raise ValueError("No hay ninguna partida activa.")
        board = game.board
        if board.turn != game.user_color:
            raise ValueError("No es tu turno.")

        move = _build_move(board, frm, to, promo)
        mover = board.turn

        info_best = game.ana.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
        best_move = info_best["pv"][0]
        cp_before = _score_to_cp(info_best["score"], mover)
        best_san = board.san(best_move)
        only_move = board.legal_moves.count() == 1
        played_san = board.san(move)

        board.push(move)
        info_after = game.ana.analyse(board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
        cp_after = _score_to_cp(info_after["score"], mover)
        cp_loss = max(0, cp_before - cp_after)
        is_best = (move == best_move)
        if board.is_checkmate():
            cp_loss, is_best = 0, True
        label, symbol = _classify(cp_loss, is_best, only_move)
        game.cp_losses.append(cp_loss)

        your_move = {
            "san": played_san, "uci": move.uci(),
            "label": label, "symbol": symbol, "cp_loss": cp_loss,
            "best_san": best_san, "best_uci": best_move.uci(),
            "is_best": is_best, "color_hex": LABEL_COLOR.get(label, "#888"),
        }
        eval_white = cp_after if mover == chess.WHITE else -cp_after

        status = _status(board)
        intermediate_fen = board.fen()
        engine_move = None
        if status == "playing":
            engine_move = _engine_reply(game)
            status = _status(board)

        profile = None
        if status != "playing":
            profile = _finish(user_id, game, status)

        return {
            "fen": board.fen(), "your_move": your_move,
            "engine_move": engine_move, "legal": _legal_map(board),
            "status": status, "eval_white": eval_white,
            "in_check": board.is_check(), "profile": profile,
            "intermediate_fen": intermediate_fen,
        }


def resign(user_id: int) -> dict:
    lock = _get_lock(user_id)
    with lock:
        game = _GAMES.get(user_id)
        if not game or game.over:
            raise ValueError("No hay ninguna partida activa.")
        return _finish(user_id, game, "resign")


def hint(user_id: int) -> dict:
    lock = _get_lock(user_id)
    with lock:
        game = _GAMES.get(user_id)
        if not game or game.over:
            raise ValueError("No hay ninguna partida activa.")
        info = game.ana.analyse(game.board, chess.engine.Limit(depth=ANALYSIS_DEPTH))
        best = info["pv"][0]
        return {"best_uci": best.uci(), "best_san": game.board.san(best)}


def takeback(user_id: int) -> dict:
    lock = _get_lock(user_id)
    with lock:
        game = _GAMES.get(user_id)
        if not game or game.over:
            raise ValueError("No hay ninguna partida activa.")
        if not game.cp_losses:
            raise ValueError("No hay jugadas tuyas para deshacer.")
        board = game.board
        if board.move_stack and board.turn == game.user_color:
            board.pop()
        if board.move_stack:
            board.pop()
        game.cp_losses.pop()
        return {
            "fen": board.fen(), "legal": _legal_map(board),
            "status": "playing", "in_check": board.is_check(),
        }


def export_pgn(user_id: int) -> dict:
    lock = _get_lock(user_id)
    with lock:
        game = _GAMES.get(user_id)
        if not game:
            raise ValueError("No hay ninguna partida para exportar.")
        board = game.board
        g = chess.pgn.Game.from_board(board)
        you = "Tú"
        ai = f"IA (Elo {game.engine_elo})"
        if game.user_color == chess.WHITE:
            g.headers["White"], g.headers["Black"] = you, ai
        else:
            g.headers["White"], g.headers["Black"] = ai, you
        g.headers["Event"] = "Partida contra la IA"
        g.headers["Date"] = date.today().strftime("%Y.%m.%d")
        g.headers["Result"] = board.result(claim_draw=True) if game.over else "*"
        exp = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        return {"pgn": g.accept(exp)}


def get_profile(user_id: int) -> dict:
    return _profile_view(_load_profile(user_id))


# ---------- Internos ----------

def _finish(user_id: int, game: Game, status: str) -> dict:
    game.over = True
    board = game.board
    if status == "checkmate":
        winner = not board.turn
        score = 1.0 if winner == game.user_color else 0.0
    elif status == "resign":
        score = 0.0
    else:
        score = 0.5
    profile = _update_profile(user_id, game, score, status)
    game.close()
    with _dict_lock:
        _GAMES.pop(user_id, None)
    return profile


def _update_profile(user_id: int, game: Game, score: float, status: str) -> dict:
    p = _load_profile(user_id)
    user_elo = p["elo"]
    expected = 1 / (1 + 10 ** ((game.engine_elo - user_elo) / 400))
    new = user_elo + 32 * (score - expected)

    acpl = None
    if len(game.cp_losses) >= 6:
        acpl = sum(game.cp_losses) / len(game.cp_losses)
        new = 0.85 * new + 0.15 * acpl_to_elo(acpl)
    elif game.cp_losses:
        acpl = sum(game.cp_losses) / len(game.cp_losses)

    delta = max(-40, min(40, round(new) - user_elo))
    new_elo = int(max(400, min(2800, user_elo + delta)))
    result_str = "win" if score == 1.0 else "loss" if score == 0.0 else "draw"

    p.update({
        "delta": new_elo - user_elo, "elo": new_elo,
        "games": p["games"] + 1,
        "wins":   p["wins"]   + (1 if score == 1.0 else 0),
        "losses": p["losses"] + (1 if score == 0.0 else 0),
        "draws":  p["draws"]  + (1 if score == 0.5 else 0),
        "last_acpl":   round(acpl, 1) if acpl is not None else None,
        "last_result": result_str,
        "last_status": status,
    })
    _save_profile(user_id, p)
    _append_elo_history(user_id, new_elo, result_str)
    p["elo_history"] = p.get("elo_history", []) + [
        {"elo": new_elo, "result": result_str, "date": date.today().isoformat()}
    ]
    return _profile_view(p)


def _profile_view(p: dict) -> dict:
    v = dict(p)
    v["rank"] = elo_rank(p["elo"])
    return v
