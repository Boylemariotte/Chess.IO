"""
Análisis de partidas de ajedrez con Stockfish.

Lee un PGN (texto, una o varias partidas), reproduce las jugadas y, para cada
una, compara la jugada real contra la mejor jugada del motor. Clasifica cada
movimiento (mejor, buena, imprecisión, error, blunder...), explica POR QUÉ una
jugada fue mala (qué pieza colgaste, mate permitido/perdido) y calcula una
precisión promedio por jugador. Si hay varias partidas, agrega estadísticas
globales por jugador.
"""

import io
import os
import json
import math
import shutil
import chess
import chess.pgn
import chess.engine

# Base de aperturas (posición EPD -> {eco, name}). Se carga una sola vez.
_OPENINGS = None


def _load_openings():
    global _OPENINGS
    if _OPENINGS is None:
        path = os.path.join(os.path.dirname(__file__), "openings.json")
        try:
            with open(path, encoding="utf-8") as f:
                _OPENINGS = json.load(f)
        except Exception:
            _OPENINGS = {}
    return _OPENINGS


def _detect_opening(game):
    """Identifica la apertura recorriendo las jugadas y buscando la última
    posición conocida. Devuelve {eco, name, theory_end_ply} o None."""
    openings = _load_openings()
    if not openings:
        return None
    board = game.board()
    found = None
    end_ply = 0
    for i, mv in enumerate(game.mainline_moves()):
        board.push(mv)
        key = board.epd()
        if key in openings:
            found = openings[key]
            end_ply = i + 1
        if i >= 30:                # las aperturas no pasan de ~15 jugadas
            break
    if found:
        return {"eco": found["eco"], "name": found["name"], "theory_end_ply": end_ply}
    return None

# Ruta al ejecutable de Stockfish: busca en engine/stockfish/ primero,
# luego en el sistema (Linux/Mac via PATH).
def _find_engine() -> str:
    local_dir = os.path.join(os.path.dirname(__file__), "engine", "stockfish")
    if os.path.isdir(local_dir):
        for name in sorted(os.listdir(local_dir)):
            if name.startswith("stockfish"):
                return os.path.join(local_dir, name)
    system = shutil.which("stockfish")
    if system:
        return system
    raise FileNotFoundError(
        "Stockfish no encontrado. Colócalo en engine/stockfish/ "
        "o instálalo en el sistema (apt install stockfish)."
    )

ENGINE_PATH = _find_engine()

# Valor en peones de cada pieza (para explicar material colgado).
PIECE_VALUE = {
    chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
    chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0,
}
PIECE_ES = {
    chess.PAWN: "peón", chess.KNIGHT: "caballo", chess.BISHOP: "alfil",
    chess.ROOK: "torre", chess.QUEEN: "dama", chess.KING: "rey",
}

# Clasificación de jugadas según cuántos centipeones se pierden respecto a
# la mejor jugada disponible (centipawn loss).
#   (pérdida_máxima_en_centipeones, etiqueta, símbolo)
CLASSIFICATION = [
    (10,   "Excelente",   "!!"),
    (25,   "Buena",       "!"),
    (50,   "Imprecisión", "?!"),
    (100,  "Inexacta",    "?!"),
    (200,  "Error",       "?"),
    (math.inf, "Blunder", "??"),
]

LABEL_COLOR = {
    "Mejor jugada": "#27ae60",
    "Excelente":    "#2ecc71",
    "Buena":        "#7fb800",
    "Imprecisión":  "#f1c40f",
    "Inexacta":     "#e67e22",
    "Error":        "#e74c3c",
    "Blunder":      "#c0392b",
    "Forzada":      "#3498db",
}

# Etiquetas que consideramos "malas" y merecen una explicación.
BAD_LABELS = {"Imprecisión", "Inexacta", "Error", "Blunder"}


def _find_hanging(board, color):
    """Piezas de `color` que están atacadas y completamente sin defensa."""
    opp = not color
    result = []
    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        if p and p.color == color and p.piece_type != chess.KING:
            if board.is_attacked_by(opp, sq) and not board.is_attacked_by(color, sq):
                result.append((sq, p))
    return result


def _fork_targets_after(board, move, victim_color):
    """Piezas de `victim_color` que la pieza movida ataca tras `move` y que
    están en riesgo (sin defensa, valen más que el atacante, o es el rey)."""
    b = board.copy()
    b.push(move)
    mp = b.piece_at(move.to_square)
    if not mp:
        return []
    mv = PIECE_VALUE.get(mp.piece_type, 0)
    mover_color = not victim_color

    at_risk = []
    for sq in b.attacks(move.to_square):
        p = b.piece_at(sq)
        if p and p.color == victim_color:
            if p.piece_type == chess.KING:
                at_risk.append((sq, p))
            else:
                pv = PIECE_VALUE.get(p.piece_type, 0)
                defenders = b.attackers(victim_color, sq)
                if not defenders or pv > mv:
                    at_risk.append((sq, p))
    return at_risk


def _classify(cp_loss, is_best, only_move):
    if only_move:
        return "Forzada", ""
    if is_best:
        return "Mejor jugada", "*"
    for max_loss, label, symbol in CLASSIFICATION:
        if cp_loss <= max_loss:
            return label, symbol
    return "Blunder", "??"


def _score_to_cp(score, color):
    """Convierte un PovScore a centipeones desde el punto de vista de `color`."""
    pov = score.pov(color)
    if pov.is_mate():
        mate_in = pov.mate()
        if mate_in > 0:
            return 10000 - mate_in * 10
        else:
            return -10000 - mate_in * 10
    return pov.score()


def _win_percent(cp):
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def _accuracy_from_winpct(before, after):
    drop = max(0.0, before - after)
    acc = 103.1668 * math.exp(-0.04354 * drop) - 3.1669
    return max(0.0, min(100.0, acc))


def _explain(board_before, board_after, move, best_move, best_info, after_info,
             best_san, is_best, cp_loss, mover, label):
    """Genera una explicación táctica en español de por qué la jugada fue mala.

    `board_before` es el tablero ANTES de la jugada.
    `board_after`  es el tablero TRAS la jugada real (le toca al rival).
    """
    if label not in BAD_LABELS:
        return ""

    best_pov = best_info["score"].pov(mover)
    after_pov = after_info["score"].pov(mover)
    reply = after_info["pv"][0] if after_info.get("pv") else None

    # 1) Te perdiste un mate forzado.
    if best_pov.is_mate() and best_pov.mate() > 0 and not is_best:
        return f"Te pierdes un mate en {best_pov.mate()}: lo ganador era {best_san}."

    # 2) Permitiste que te den mate.
    if after_pov.is_mate() and after_pov.mate() < 0:
        return f"Permites un mate en {abs(after_pov.mate())} para el rival."

    # 3) Horquilla: la mejor respuesta del rival ataca dos o más piezas tuyas.
    if reply is not None:
        fork = _fork_targets_after(board_after, reply, mover)
        if len(fork) >= 2:
            reply_san = board_after.san(reply)
            kings = [(sq, p) for sq, p in fork if p.piece_type == chess.KING]
            others = [(sq, p) for sq, p in fork if p.piece_type != chess.KING]
            if kings and others:
                sq, p = max(others, key=lambda x: PIECE_VALUE.get(x[1].piece_type, 0))
                pname = PIECE_ES.get(p.piece_type, "pieza")
                return (f"Permites una horquilla: el rival juega {reply_san} "
                        f"dando jaque y atacando tu {pname} en {chess.square_name(sq)}. "
                        f"Mejor era {best_san}.")
            if len(others) >= 2:
                names = " y ".join(
                    f"{PIECE_ES.get(p.piece_type, 'pieza')} ({chess.square_name(sq)})"
                    for sq, p in others[:2]
                )
                return (f"El rival juega {reply_san} atacando tu {names} a la vez "
                        f"(horquilla). Mejor era {best_san}.")

    # 4) Dejaste una pieza sin protección (expuesta por tu movimiento).
    hanging_before = {sq for sq, _ in _find_hanging(board_before, mover)}
    newly_hanging = [
        (sq, p) for sq, p in _find_hanging(board_after, mover)
        if sq not in hanging_before
    ]
    if newly_hanging:
        sq, piece = max(newly_hanging, key=lambda x: PIECE_VALUE.get(x[1].piece_type, 0))
        pname = PIECE_ES.get(piece.piece_type, "pieza")
        sqname = chess.square_name(sq)
        return (f"Dejas tu {pname} en {sqname} completamente sin defensa. "
                f"Mejor era {best_san}.")

    # 5) El rival captura directamente una pieza tuya en su respuesta.
    if reply is not None and board_after.is_capture(reply):
        captured = board_after.piece_at(reply.to_square)
        if captured is None and board_after.is_en_passant(reply):
            cap_name, cap_val = "peón", 1
        elif captured is not None:
            cap_name = PIECE_ES.get(captured.piece_type, "pieza")
            cap_val = PIECE_VALUE.get(captured.piece_type, 0)
        else:
            cap_name, cap_val = None, 0
        if cap_name and cap_val >= 1:
            reply_san = board_after.san(reply)
            sq = chess.square_name(reply.to_square)
            return (f"Tu {cap_name} en {sq} queda colgado: el rival juega "
                    f"{reply_san} y gana material. Mejor era {best_san}.")

    # 6) Tenías material rival colgado y no lo tomaste.
    if not board_before.is_capture(move):
        opp_hanging = _find_hanging(board_before, not mover)
        if opp_hanging:
            sq, piece = max(opp_hanging, key=lambda x: PIECE_VALUE.get(x[1].piece_type, 0))
            pv = PIECE_VALUE.get(piece.piece_type, 0)
            if pv >= 1:
                pname = PIECE_ES.get(piece.piece_type, "pieza")
                sqname = chess.square_name(sq)
                return (f"La {pname} rival en {sqname} estaba colgada y no la tomaste. "
                        f"Lo correcto era {best_san}.")

    # 7) Genérico: perdiste ventaja significativa.
    perdido = cp_loss / 100
    return f"Pierdes {perdido:.2f} peones de ventaja. La jugada precisa era {best_san}."


def _rating_label(accuracy):
    if accuracy >= 95:
        return "Maestría"
    if accuracy >= 90:
        return "Excelente"
    if accuracy >= 80:
        return "Muy buena"
    if accuracy >= 70:
        return "Buena"
    if accuracy >= 60:
        return "Regular"
    if accuracy >= 50:
        return "Floja"
    return "A mejorar"


def _analyze_game(game, engine, depth, progress=None, offset=0, grand_total=0):
    """Analiza un objeto game ya parseado, usando un motor ya abierto.

    `offset` y `grand_total` permiten reportar progreso global cuando se
    analizan varias partidas seguidas.
    """
    headers = dict(game.headers)
    moves = list(game.mainline_moves())

    board = game.board()
    results = []
    acc_sum = {chess.WHITE: 0.0, chess.BLACK: 0.0}
    acc_n = {chess.WHITE: 0, chess.BLACK: 0}
    counts = {chess.WHITE: {}, chess.BLACK: {}}
    eval_curve = []  # evaluación en centipeones (lado blanco) tras cada jugada

    for i, move in enumerate(moves):
        mover = board.turn

        best_info = engine.analyse(board, chess.engine.Limit(depth=depth))
        best_info = best_info[0] if isinstance(best_info, list) else best_info
        best_move = best_info["pv"][0]
        cp_before = _score_to_cp(best_info["score"], mover)
        best_san = board.san(best_move)
        only_move = board.legal_moves.count() == 1
        played_san = board.san(move)

        board_before = board.copy()
        board.push(move)
        after_info = engine.analyse(board, chess.engine.Limit(depth=depth))
        after_info = after_info[0] if isinstance(after_info, list) else after_info
        cp_after = _score_to_cp(after_info["score"], mover)

        cp_loss = max(0, cp_before - cp_after)
        is_best = (move == best_move)
        label, symbol = _classify(cp_loss, is_best, only_move)

        # Dar jaque mate gana la partida: nunca es un error, aunque existiera
        # un mate más rápido. Lo tratamos como jugada perfecta.
        if board.is_checkmate():
            cp_after = 10000
            cp_loss = 0
            is_best = True
            label, symbol = "Mejor jugada", "*"

        wp_before = _win_percent(cp_before)
        wp_after = _win_percent(cp_after)
        move_acc = _accuracy_from_winpct(wp_before, wp_after)
        acc_sum[mover] += move_acc
        acc_n[mover] += 1
        counts[mover][label] = counts[mover].get(label, 0) + 1

        explanation = _explain(board_before, board, move, best_move,
                               best_info, after_info, best_san,
                               is_best, cp_loss, mover, label)

        eval_white = cp_after if mover == chess.WHITE else -cp_after
        eval_curve.append(eval_white)

        results.append({
            "ply": i + 1,
            "move_no": i // 2 + 1,
            "color": "white" if mover == chess.WHITE else "black",
            "san": played_san,
            "uci": move.uci(),
            "best_san": best_san,
            "best_uci": best_move.uci(),
            "fen": board.fen(),
            "eval_cp": cp_after,
            "eval_white": eval_white,
            "cp_loss": cp_loss,
            "label": label,
            "symbol": symbol,
            "color_hex": LABEL_COLOR.get(label, "#888"),
            "accuracy": round(move_acc, 1),
            "is_best": is_best,
            "explanation": explanation,
        })

        if progress:
            progress(offset + i + 1, grand_total)

    def summarize(color):
        n = acc_n[color]
        avg = (acc_sum[color] / n) if n else 0.0
        return {
            "accuracy": round(avg, 1),
            "rating_label": _rating_label(avg),
            "counts": counts[color],
            "moves": n,
        }

    white = headers.get("White", "Blancas")
    black = headers.get("Black", "Negras")
    result_str = headers.get("Result", "*")
    return {
        "headers": headers,
        "label": f"{white} vs {black}  ({result_str})",
        "start_fen": game.board().fen(),
        "opening": _detect_opening(game),
        "moves": results,
        "eval_curve": eval_curve,
        "summary": {
            "white": summarize(chess.WHITE),
            "black": summarize(chess.BLACK),
        },
    }


def _open_engine():
    engine = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)
    try:
        engine.configure({"Threads": max(1, (os.cpu_count() or 2) - 1)})
    except Exception:
        pass
    return engine


def analyze_pgn(pgn_text, depth=15, progress=None):
    """Analiza la PRIMERA partida del texto (compatibilidad)."""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise ValueError("No se pudo leer ninguna partida del texto PGN.")
    total = len(list(game.mainline_moves()))
    engine = _open_engine()
    try:
        return _analyze_game(game, engine, depth, progress, 0, total)
    finally:
        engine.quit()


def analyze_games(pgn_text, depth=15, progress=None):
    """Analiza TODAS las partidas del texto y agrega estadísticas globales."""
    stream = io.StringIO(pgn_text)
    parsed = []
    while True:
        g = chess.pgn.read_game(stream)
        if g is None:
            break
        if list(g.mainline_moves()):  # ignorar partidas vacías
            parsed.append(g)
    if not parsed:
        raise ValueError("No se pudo leer ninguna partida del texto PGN.")

    grand_total = sum(len(list(g.mainline_moves())) for g in parsed)

    engine = _open_engine()
    games = []
    offset = 0
    try:
        for g in parsed:
            n = len(list(g.mainline_moves()))
            game_result = _analyze_game(g, engine, depth, progress,
                                        offset, grand_total)
            games.append(game_result)
            offset += n
    finally:
        engine.quit()

    return {
        "games": games,
        "players": _aggregate_players(games),
    }


def _aggregate_players(games):
    """Agrega estadísticas por nombre de jugador a través de todas las partidas."""
    players = {}

    def acc_for(name, side_summary, result_str, is_white):
        p = players.setdefault(name, {
            "games": 0, "acc_list": [], "counts": {},
            "wins": 0, "draws": 0, "losses": 0, "moves": 0,
        })
        p["games"] += 1
        p["acc_list"].append(side_summary["accuracy"])
        p["moves"] += side_summary["moves"]
        for label, c in side_summary["counts"].items():
            p["counts"][label] = p["counts"].get(label, 0) + c
        if result_str == "1-0":
            p["wins" if is_white else "losses"] += 1
        elif result_str == "0-1":
            p["losses" if is_white else "wins"] += 1
        elif result_str == "1/2-1/2":
            p["draws"] += 1

    for g in games:
        h = g["headers"]
        res = h.get("Result", "*")
        acc_for(h.get("White", "Blancas"), g["summary"]["white"], res, True)
        acc_for(h.get("Black", "Negras"), g["summary"]["black"], res, False)

    out = {}
    for name, p in players.items():
        avg = sum(p["acc_list"]) / len(p["acc_list"]) if p["acc_list"] else 0
        out[name] = {
            "games": p["games"],
            "accuracy": round(avg, 1),
            "rating_label": _rating_label(avg),
            "counts": p["counts"],
            "moves": p["moves"],
            "blunders": p["counts"].get("Blunder", 0),
            "errors": p["counts"].get("Error", 0),
            "record": f"{p['wins']}V / {p['draws']}E / {p['losses']}D",
        }
    return out


if __name__ == "__main__":
    import sys
    import json
    text = sys.stdin.read()
    out = analyze_games(text, depth=12,
                        progress=lambda i, t: print(f"  {i}/{t}", file=sys.stderr))
    print(json.dumps(out, indent=2, ensure_ascii=False))
