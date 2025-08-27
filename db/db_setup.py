# db_setup.py
import psycopg2
from psycopg2 import sql, errors, OperationalError
import json
from pathlib import Path

DB_NAME = "factorydb"
DB_USER = "your_user_name"
DB_PASS = "your_password"  
DB_HOST = "localhost"
DB_PORT = "5432"
SEED_FILE = Path(__file__).parent / "seed_data.json"

def ensure_database():
    """Connect to target DB; if missing, create it."""
    try:
        conn = psycopg2.connect(
            dbname=DB_NAME, user=DB_USER, password=DB_PASS,
            host=DB_HOST, port=DB_PORT
        )
        conn.close()
        print(f"Database '{DB_NAME}' already exists.")
    except (errors.InvalidCatalogName, OperationalError):
        print(f"Database '{DB_NAME}' not found, creating it...")
        admin_conn = psycopg2.connect(
            dbname="postgres", user=DB_USER, password=DB_PASS,
            host=DB_HOST, port=DB_PORT
        )
        admin_conn.autocommit = True
        with admin_conn.cursor() as cur:
            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(DB_NAME)))
        admin_conn.close()
        print(f"Database '{DB_NAME}' created successfully.")

def get_conn():
    return psycopg2.connect(
        dbname=DB_NAME, user=DB_USER, password=DB_PASS,
        host=DB_HOST, port=DB_PORT
    )

def ensure_tables():
    ddl_workorder = """
    CREATE TABLE IF NOT EXISTS workorder (
        id TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        qty INTEGER NOT NULL
    );
    """

    ddl_operation = """
    CREATE TABLE IF NOT EXISTS operation (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL REFERENCES workorder(id) ON DELETE CASCADE,
        op_index INTEGER NOT NULL,
        machine_id TEXT NOT NULL,
        name TEXT NOT NULL,
        start TIMESTAMPTZ NOT NULL,
        "end" TIMESTAMPTZ NOT NULL,
        CONSTRAINT op_intra_order_unique UNIQUE (work_order_id, op_index),
        CONSTRAINT op_time_sanity CHECK (start < "end")
    );
    """

    ddl_indexes = [
        'CREATE INDEX IF NOT EXISTS idx_operation_wo_idx ON operation (work_order_id, op_index);',
        'CREATE INDEX IF NOT EXISTS idx_operation_machine_time ON operation (machine_id, start, "end");',
        'CREATE INDEX IF NOT EXISTS idx_operation_start ON operation (start);'
    ]

    with get_conn() as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(ddl_workorder)
            cur.execute(ddl_operation)
            for stmt in ddl_indexes:
                cur.execute(stmt)

    print("Tables ensured: workorder + operation.")

def seed_data():
    """Load seed_data.json into tables (idempotent)."""
    if not SEED_FILE.exists():
        print(f"Seed file not found: {SEED_FILE}")
        return

    with open(SEED_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    with get_conn() as conn:
        with conn.cursor() as cur:
            for wo in data:
                cur.execute("""
                    INSERT INTO workorder (id, product, qty)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (id) DO NOTHING;
                """, (wo["id"], wo["product"], wo["qty"]))

                for op in wo["operations"]:
                    cur.execute("""
                        INSERT INTO operation (id, work_order_id, op_index, machine_id, name, start, "end")
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO NOTHING;
                    """, (
                        op["id"],
                        op["workOrderId"],
                        op["index"],
                        op["machineId"],
                        op["name"],
                        op["start"],
                        op["end"]
                    ))

        conn.commit()
    print("Seed data inserted.")

def db_script():
    ensure_database()
    ensure_tables()
    seed_data()

if __name__ == "__main__":
    ensure_database()
    ensure_tables()
    seed_data()
    print("🏁 DB bootstrap complete.")
