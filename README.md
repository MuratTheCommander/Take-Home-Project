# Factory Work Orders Timeline

A full-stack project (Next.js frontend + FastAPI backend + Postgres DB) for visualizing **factory work orders** on a timeline.  

---

## Implements Core Requirements

- **Display Work Orders with Multiple Operations**  
  - Each Work Order has an ordered list of operations.  
  - Each operation is assigned to a lane identified by `machineId`.  
  - Timeline renders with one lane per unique `machineId`.  
  - All times shown in ISO-8601 UTC.  

- **Gantt-style Timeline**  
  - Operations are drawn as horizontal bars.  
  - A vertical “now” line indicates the current time.  

- **Click-to-Highlight**  
  - Clicking any operation highlights all operations belonging to the same `workOrderId`.  
  - Clicking blank space (or using the clear control) removes the highlight.  

- **Update Operations with Validation (R1–R3)**  
  - Backend enforces all scheduling rules (precedence, lane exclusivity, no past start times).  
  - Conflicts are rejected with clear error messages.  

---

## Setup

### Backend

Configure your database connection in `db/db_setup.py`:

```python
DB_NAME = "factorydb"
DB_USER = "your_user_name"
DB_PASS = "your_password"
DB_HOST = "localhost"
DB_PORT = "5432"
```

- Replace `your_user_name` and `your_password` with your local Postgres credentials.  
- The app will create the database and tables, then seed it with the sample data on startup.  

Create the venv:
```
python -m venv venv
```

Activate the venv:
```  
venv\Scripts\activate
```

Install dependencies:
```
pip install -r requirements.txt
```

Run the backend:

```bash
uvicorn main:app --reload --port 8000
```

### Frontend

Install dependencies and start the Next.js dev server:

```bash
cd frontend-next
npm install
npm run dev
```

By default, the frontend runs on [http://localhost:3001](http://localhost:3001) and connects to the FastAPI backend on port **8000**.  

---

## Seed Data

Database is seeded on startup with the following work orders:

```json
[
  {
    "id": "WO-1001",
    "product": "Widget A",
    "qty": 100,
    "operations": [
      { "id": "OP-1", "workOrderId": "WO-1001", "index": 1, "machineId": "M1", "name": "Cut",      "start": "2025-08-20T09:00:00Z", "end": "2025-08-20T10:00:00Z" },
      { "id": "OP-2", "workOrderId": "WO-1001", "index": 2, "machineId": "M2", "name": "Assemble", "start": "2025-08-20T10:10:00Z", "end": "2025-08-20T12:00:00Z" }
    ]
  },
  {
    "id": "WO-1002",
    "product": "Widget B",
    "qty": 50,
    "operations": [
      { "id": "OP-3", "workOrderId": "WO-1002", "index": 1, "machineId": "M1", "name": "Cut",      "start": "2025-08-20T09:30:00Z", "end": "2025-08-20T10:30:00Z" },
      { "id": "OP-4", "workOrderId": "WO-1002", "index": 2, "machineId": "M2", "name": "Assemble", "start": "2025-08-20T10:40:00Z", "end": "2025-08-20T12:15:00Z" }
    ]
  },
  {
    "id": "WO-1003",
    "product": "Widget C",
    "qty": 200,
    "operations": [
      { "id": "OP-5", "workOrderId": "WO-1003", "index": 1, "machineId": "M3", "name": "Paint",    "start": "2025-08-20T11:00:00Z", "end": "2025-08-20T12:30:00Z" },
      { "id": "OP-6", "workOrderId": "WO-1003", "index": 2, "machineId": "M2", "name": "Assemble", "start": "2025-08-20T12:40:00Z", "end": "2025-08-20T14:00:00Z" }
    ]
  },
  {
    "id": "WO-1004",
    "product": "Widget D",
    "qty": 75,
    "operations": [
      { "id": "OP-7", "workOrderId": "WO-1004", "index": 1, "machineId": "M1", "name": "Cut",    "start": "2025-08-20T13:00:00Z", "end": "2025-08-20T14:00:00Z" },
      { "id": "OP-8", "workOrderId": "WO-1004", "index": 2, "machineId": "M3", "name": "Polish", "start": "2025-08-20T14:10:00Z", "end": "2025-08-20T15:30:00Z" }
    ]
  }
]
```

---

## API Routes

### `GET /workorders`
Fetch all work orders with operations.

**Response Example**
```json
[
  {
    "id": "WO-1001",
    "product": "Widget A",
    "qty": 100,
    "operations": [
      {
        "id": "OP-1",
        "workOrderId": "WO-1001",
        "index": 1,
        "machineId": "M1",
        "name": "Cut",
        "start": "2025-08-20T09:00:00Z",
        "end":   "2025-08-20T10:00:00Z"
      }
    ]
  }
]
```

---

### `PUT /operations/{op_id}`
Update a single operation’s `start` and `end`.

**Request**
```json
{
  "start": "2025-08-20T10:10:00Z",
  "end":   "2025-08-20T12:00:00Z"
}
```

**Success Response**
```json
{
  "message": "Operation OP-2 updated successfully.",
  "data": {
    "id": "OP-2",
    "start": "2025-08-20T10:10:00Z",
    "end":   "2025-08-20T12:00:00Z"
  }
}
```

**Error Examples**
- **R1 (precedence)**  
```json
{ "detail": { "error": { "rule": "R1", "message": "must start after previous operation ends" } } }
```
- **R2 (lane overlap)**  
```json
{ "detail": { "error": { "rule": "R2", "message": "overlaps with another operation on same machine" } } }
```
- **R3 (no past)**  
```json
{ "detail": { "error": { "rule": "R3", "message": "start time cannot be in the past" } } }
```

---

## Scheduling Rules

- **R1 — Precedence:** operation k must start at or after operation k-1 ends.  
- **R2 — Lane exclusivity:** no overlaps with other operations on the same machine.  
- **R3 — No past:** start cannot be before “now”.  
