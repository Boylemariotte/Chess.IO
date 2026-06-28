"""
Modelos de base de datos con SQLAlchemy.
Usa SQLite en local y PostgreSQL en producción (Render).
La variable de entorno DATABASE_URL controla cuál se usa.
"""
import os
from sqlalchemy import (create_engine, Column, Integer, String, Float,
                        Text, DateTime, ForeignKey, Date)
from sqlalchemy.orm import DeclarativeBase, sessionmaker, relationship
from datetime import datetime

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///users.db")
# Render expone postgres://, SQLAlchemy necesita postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=_connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id            = Column(Integer, primary_key=True)
    username      = Column(String(50), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at    = Column(DateTime, default=datetime.utcnow)

    profile        = relationship("PlayProfile", back_populates="user",
                                  uselist=False, cascade="all, delete-orphan")
    elo_history    = relationship("EloHistory", back_populates="user",
                                  cascade="all, delete-orphan",
                                  order_by="EloHistory.recorded_at")
    analyzed_games = relationship("AnalyzedGame", back_populates="user",
                                  cascade="all, delete-orphan",
                                  order_by="AnalyzedGame.analyzed_at.desc()")


class PlayProfile(Base):
    __tablename__ = "play_profiles"
    id          = Column(Integer, primary_key=True)
    user_id     = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    elo         = Column(Integer, default=1000)
    games       = Column(Integer, default=0)
    wins        = Column(Integer, default=0)
    draws       = Column(Integer, default=0)
    losses      = Column(Integer, default=0)
    last_acpl   = Column(Float, nullable=True)
    last_result = Column(String(10), nullable=True)
    last_status = Column(String(20), nullable=True)
    delta       = Column(Integer, default=0)

    user = relationship("User", back_populates="profile")


class EloHistory(Base):
    __tablename__ = "elo_history"
    id          = Column(Integer, primary_key=True)
    user_id     = Column(Integer, ForeignKey("users.id"), nullable=False)
    elo         = Column(Integer)
    result      = Column(String(10))
    date        = Column(Date)
    recorded_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="elo_history")


class AnalyzedGame(Base):
    __tablename__ = "analyzed_games"
    id            = Column(Integer, primary_key=True)
    user_id       = Column(Integer, ForeignKey("users.id"), nullable=False)
    label         = Column(String(300))
    pgn_text      = Column(Text)
    analysis_json = Column(Text)
    analyzed_at   = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="analyzed_games")


def init_db():
    Base.metadata.create_all(engine)


def get_session():
    return SessionLocal()
