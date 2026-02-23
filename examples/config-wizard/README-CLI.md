# Config Wizard – View CLI metadata and use CLRUN

## 1. Start the server

From this directory (with a venv that has `scp-sdk` installed):

```bash
python app.py
# Or: uvicorn app:app --host 0.0.0.0 --port 8010
```

Server runs at **http://127.0.0.1:8010**.

---

## 2. View CLI metadata in your browser

The CLI for a run is at **`GET /runs/{run_id}/cli`**. You need a `run_id` first.

### Option A: Create a run via API, then open the CLI URL

1. Create a run (in terminal or browser devtools):

   ```bash
   curl -X POST http://127.0.0.1:8010/runs -H "Content-Type: application/json" -d '{}'
   ```

   Response includes `"run_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`.

2. Open in your browser:

   ```
   http://127.0.0.1:8010/runs/<run_id>/cli
   ```

   Example:  
   `http://127.0.0.1:8010/runs/294d7025-f2c2-41e3-aa82-c43f6e0b393d/cli`

   You’ll see JSON like:

   ```json
   {
     "prompt": "Config wizard",
     "hint": "Press 1 to start, or 2 to exit.",
     "options": [
       { "action": "start", "label": "Start wizard", "keys": "1" }
     ]
   }
   ```

### Option B: Use the OpenAPI docs

1. Open **http://127.0.0.1:8010/docs**
2. Execute **POST /runs** (body `{}`) and copy `run_id` from the response.
3. Execute **GET /runs/{run_id}/cli** with that `run_id` to see the CLI metadata (or build the URL and open it in a new tab).

---

## 3. Use CLRUN to connect

From the **CLRUN** project root (where the `clrun` CLI is installed):

```bash
clrun scp http://127.0.0.1:8010
```

CLRUN will:

1. Create a new run on the SCP server.
2. Fetch the CLI (prompt, hint, options) and show them in the terminal.
3. Print a `terminal_id` for this SCP session.

Then send options by index or action name:

```bash
# Send option "1" (Start wizard)
clrun <terminal_id> "1"

# Or by action name
clrun <terminal_id> "start"
```

View output and continue stepping until the workflow is done:

```bash
clrun tail <terminal_id> --lines 50
clrun status
```

Example flow:

```bash
$ clrun scp http://127.0.0.1:8010
# ... terminal_id: abc123 ...
# Config wizard
# Press 1 to start, or 2 to exit.
#   1. Start wizard (start)

$ clrun abc123 "1"
# ... next state: Set value, enter value then Save ...

$ clrun abc123 "my-value"
$ clrun abc123 "enter"   # or the key for Save
# ... Confirm? y/n ...

$ clrun abc123 "y"
# ... DONE
```
