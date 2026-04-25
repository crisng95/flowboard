from contextlib import contextmanager

from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

from flowboard.config import DB_PATH

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    echo=False,
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _enable_sqlite_fk(dbapi_conn, _connection_record) -> None:
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


def init_db() -> None:
    from sqlalchemy import inspect

    from flowboard.db import models

    # Targeted migration: if an older `asset` table exists without `url`,
    # drop it. Acceptable because the app has not stored real asset rows
    # prior to Run 6; other tables (board, node, edge, chatmessage, request)
    # are left alone.
    with engine.connect() as conn:
        insp = inspect(conn)
        if insp.has_table("asset"):
            cols = {c["name"] for c in insp.get_columns("asset")}
            if "url" not in cols:
                models.Asset.__table__.drop(conn, checkfirst=True)
                conn.commit()

    SQLModel.metadata.create_all(engine)


@contextmanager
def get_session():
    with Session(engine) as session:
        yield session
