from fastapi import FastAPI
from contextlib import asynccontextmanager
from db import db_setup
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime,timezone
from fastapi import HTTPException
from pydantic import BaseModel
from datetime import datetime, timezone
from fastapi.middleware.cors import CORSMiddleware
from fastapi import HTTPException, status



# lifespan to bootstrap DB
@asynccontextmanager
async def lifespan(app: FastAPI):
    db_setup.ensure_database()
    db_setup.ensure_tables()
    db_setup.seed_data()
    print("✅ DB ready and seeded on startup")
    yield
    print("👋 App shutting down...")

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001"],  
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,  
)

def get_conn():
    return psycopg2.connect(
        dbname=db_setup.DB_NAME,
        user=db_setup.DB_USER,
        password=db_setup.DB_PASS,
        host=db_setup.DB_HOST,
        port=db_setup.DB_PORT,
        cursor_factory=RealDictCursor
    )

@app.get("/workorders")
def get_workorders():
    """Fetch all work orders with their operations."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Fetch all workorders
            cur.execute("SELECT * FROM workorder;")
            workorders = cur.fetchall()

            # Fetch all operations
            cur.execute("SELECT * FROM operation ORDER BY op_index;")
            operations = cur.fetchall()

    # Group operations by work_order_id
    ops_by_wo = {}
    for op in operations:
        wo_id = op["work_order_id"]
        ops_by_wo.setdefault(wo_id, []).append({
            "id": op["id"],
            "workOrderId": op["work_order_id"],
            "index": op["op_index"],
            "machineId": op["machine_id"],
            "name": op["name"],
            "start": op["start"].isoformat(),
            "end": op["end"].isoformat()
        })

    # Attach operations to workorders
    result = []
    for wo in workorders:
        result.append({
            "id": wo["id"],
            "product": wo["product"],
            "qty": wo["qty"],
            "operations": ops_by_wo.get(wo["id"], [])
        })

    return result



class OperationUpdate(BaseModel):
    start: datetime
    end: datetime

    def as_utc(self):
        """Normalize datetimes to UTC, add tzinfo if missing."""
        s = self.start if self.start.tzinfo else self.start.replace(tzinfo=timezone.utc)
        e = self.end if self.end.tzinfo else self.end.replace(tzinfo=timezone.utc)
        return (s.astimezone(timezone.utc), e.astimezone(timezone.utc))
    


@app.put("/operations/{op_id}")
def update_operation(op_id: str, body: OperationUpdate):
    new_start, new_end = body.as_utc()  # must return tz-aware datetimes

    # Basic interval and past checks
    if not (new_start < new_end):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"rule": "INVALID", "message": "start must be before end"}}
        )
    if new_start < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": {"rule": "R3", "message": "start time cannot be in the past"}}
        )

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Lock the target operation row
            cur.execute('SELECT * FROM "operation" WHERE id = %s FOR UPDATE;', (op_id,))
            op = cur.fetchone()
            if not op:
                raise HTTPException(status_code=404, detail={"error": {"rule": "NOT_FOUND", "message": "Operation not found"}})

            work_order_id = op["work_order_id"]
            op_index      = op["op_index"]
            machine_id    = op["machine_id"]

            # R1-backward: must start after previous operation ends
            if op_index > 1:
                cur.execute("""
                    SELECT "end" FROM "operation"
                    WHERE work_order_id = %s AND op_index = %s
                    FOR UPDATE;
                """, (work_order_id, op_index - 1))
                prev = cur.fetchone()
                if prev and new_start < prev["end"]:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail={"error": {"rule": "R1", "message": "must start after previous operation ends",
                                          "details": {"prev_end": prev["end"].isoformat()}}}
                    )

            # R1-forward: must end before next operation starts
            cur.execute("""
                SELECT start FROM "operation"
                WHERE work_order_id = %s AND op_index = %s
                FOR UPDATE;
            """, (work_order_id, op_index + 1))
            nxt = cur.fetchone()
            if nxt and new_end > nxt["start"]:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"error": {"rule": "R1", "message": "must end before next operation starts",
                                      "details": {"next_start": nxt["start"].isoformat()}}}
                )

            # R2: no overlap with other ops on same machine (half-open adjacency allowed)
            cur.execute("""
                SELECT id, start, "end" FROM "operation"
                WHERE machine_id = %s AND id != %s
                  AND NOT (%s >= "end" OR %s <= start)
                LIMIT 1
                FOR UPDATE;
            """, (machine_id, op_id, new_start, new_end))
            conflict = cur.fetchone()
            if conflict:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"error": {"rule": "R2",
                                      "message": "overlaps with another operation on same machine",
                                      "details": {"conflict_op": conflict["id"],
                                                  "conflict_start": conflict["start"].isoformat(),
                                                  "conflict_end": conflict["end"].isoformat()}}}
                )

            # Persist
            cur.execute("""
                UPDATE "operation"
                SET start = %s, "end" = %s
                WHERE id = %s;
            """, (new_start, new_end, op_id))
            conn.commit()

    return {"message": f"Operation {op_id} updated successfully.",
            "data": {"id": op_id, "start": new_start.isoformat(), "end": new_end.isoformat()}}

