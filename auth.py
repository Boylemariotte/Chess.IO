"""Registro, autenticación y decorador login_required."""
import functools
from flask import session, redirect, request, jsonify
from werkzeug.security import generate_password_hash, check_password_hash
from db import get_session, User, PlayProfile


def register_user(username: str, password: str):
    """Registra un usuario. Devuelve (User, None) o (None, mensaje_error)."""
    username = username.strip()
    if len(username) < 3:
        return None, "El usuario debe tener al menos 3 caracteres."
    if len(password) < 6:
        return None, "La contraseña debe tener al menos 6 caracteres."
    db = get_session()
    try:
        if db.query(User).filter_by(username=username).first():
            return None, "Ese nombre de usuario ya existe."
        user = User(username=username,
                    password_hash=generate_password_hash(password))
        db.add(user)
        db.flush()
        db.add(PlayProfile(user_id=user.id))
        db.commit()
        db.refresh(user)
        return user, None
    except Exception as exc:
        db.rollback()
        return None, str(exc)
    finally:
        db.close()


def login_user(username: str, password: str):
    """Verifica credenciales. Devuelve (User, None) o (None, mensaje_error)."""
    db = get_session()
    try:
        user = db.query(User).filter_by(username=username.strip()).first()
        if not user or not check_password_hash(user.password_hash, password):
            return None, "Usuario o contraseña incorrectos."
        return user, None
    finally:
        db.close()


def current_user_id() -> int | None:
    return session.get("user_id")


def login_required(f):
    """Redirige a /login si el usuario no está autenticado."""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            if request.is_json or request.path.startswith(("/play", "/analyze", "/games")):
                return jsonify({"error": "No autenticado"}), 401
            return redirect("/login")
        return f(*args, **kwargs)
    return wrapper
