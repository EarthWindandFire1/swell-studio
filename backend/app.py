"""HTTP API and static entry point for the local poster workshop."""
import json
import os
import re
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from uuid import UUID

import psycopg
from accounts import auth, current_user, init_accounts
from database import connect
from flask import Flask, Response, g, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException
from waitress import serve

from poster import TEMPLATES, render_poster

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "frontend" / "dist"
COLUMNS = "id, brand, product, description, price, created_at, template_id"
LIMITS = {"brand": 40, "product": 60, "description": 200}
app = Flask(__name__, static_folder=None)
app.register_blueprint(auth)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024


def init_database():
    with connect() as conn:
        init_accounts(conn)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS swell_posters (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                request_id UUID NOT NULL UNIQUE,
                brand VARCHAR(40) NOT NULL,
                product VARCHAR(60) NOT NULL,
                description VARCHAR(200) NOT NULL,
                price NUMERIC(8,2) NOT NULL CHECK (price >= 0),
                png BYTEA NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.execute("""
            ALTER TABLE swell_posters ADD COLUMN IF NOT EXISTS template_id TEXT NOT NULL DEFAULT 'ocean-breeze'
        """)
        conn.execute("ALTER TABLE swell_posters ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES swell_users(id)")
        conn.execute("CREATE INDEX IF NOT EXISTS swell_history_by_user ON swell_posters(user_id,id DESC)")


def record(row):
    return {**row, "price": str(row["price"]), "created_at": row["created_at"].isoformat()}


def validate(body):
    fields, errors = {}, {}
    for key, maximum in LIMITS.items():
        raw = body.get(key)
        value = raw.strip() if isinstance(raw, str) else ""
        if not value:
            errors[key] = "This field is required."
        elif len(value) > maximum:
            errors[key] = f"Use {maximum} characters or fewer."
        elif not all(c.isprintable() or c in "\n\r\t" for c in value):
            errors[key] = "Remove unsupported control characters."
        fields[key] = value
    price = str(body.get("price", "")).strip()
    if not re.fullmatch(r"[0-9]{1,6}(?:\.[0-9]{1,2})?", price):
        errors["price"] = "Enter a USD amount from 0 to 999999.99, with up to two decimals."
    else:
        fields["price"] = Decimal(price).quantize(Decimal("0.01"))
    template = body.get("template_id", "ocean-breeze")
    if not isinstance(template, str) or template not in TEMPLATES:
        errors["template_id"] = "Choose an available template."
    else:
        fields["template_id"] = template
    return fields, errors


@app.before_request
def protect_api():
    if not request.path.startswith("/api/") or request.method == "OPTIONS":
        return
    if request.method in ("POST", "DELETE"):
        origin = request.headers.get("Origin")
        allowed_origins = (
            request.host_url.rstrip("/"),
            os.getenv("FRONTEND_ORIGIN"),
            os.getenv("RENDER_EXTERNAL_URL", "").rstrip("/"),
        )
        if origin and origin not in allowed_origins:
            return jsonify(error="Unrecognized studio origin."), 403
        if request.method == "POST" and not request.is_json:
            return jsonify(error="Send a JSON request."), 415
    if request.path.startswith("/api/posters"):
        g.user = current_user()
        if not g.user:
            return jsonify(error="Please sign in to use your poster library."), 401


@app.after_request
def cors(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "private, no-store"
    origin = request.headers.get("Origin")
    allowed = os.getenv("FRONTEND_ORIGIN")
    if allowed and origin == allowed and request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = allowed
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.vary.add("Origin")
    return response


@app.errorhandler(psycopg.Error)
def database_error(exc):
    app.logger.exception("PostgreSQL request failed")
    return jsonify(error="The poster library is unavailable. Check PostgreSQL and try again."), 503


@app.errorhandler(HTTPException)
def http_error(exc):
    return jsonify(error=exc.description), exc.code


@app.errorhandler(Exception)
def unexpected(exc):
    app.logger.exception("Poster request failed")
    return jsonify(error="We could not finish this poster. Your form is still here. Please try again."), 500


@app.post("/api/posters/ai")
def create_ai_poster():
    return jsonify(error="AI generation is not connected yet. Choose a template to generate a poster.",
                   code="ai_not_configured"), 501


@app.post("/api/posters/template")
@app.post("/api/posters")
def create_poster():
    body = request.get_json()
    if not isinstance(body, dict):
        return jsonify(error="Send a product form."), 400
    data, errors = validate(body)
    if errors:
        return jsonify(error="Check the highlighted fields.", fields=errors), 422
    try:
        token = UUID(str(body.get("request_id", "")))
    except ValueError:
        return jsonify(error="A valid request ID is required."), 400

    events = generate_events(data, token, g.user["id"])
    if request.accept_mimetypes.best_match(["application/json", "application/x-ndjson"]) == "application/x-ndjson":
        lines = (json.dumps(event, ensure_ascii=False) + "\n" for event in events)
        return Response(lines, mimetype="application/x-ndjson",
                        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    for event in events:
        if event["stage"] == "saved":
            return jsonify(event["poster"]), event["status"]
        if event["stage"] == "failed":
            return jsonify(error=event["error"]), event["status"]


def replay_event(row, data):
    if row is None or any(row[key] != value for key, value in data.items()):
        return {"stage": "failed", "status": 409, "error": "This request ID already belongs to another poster."}
    return {"stage": "saved", "poster": record(row), "status": 200}


def generate_events(data, token, user_id):
    # Both response formats use the same render and transaction.
    try:
        with connect() as conn:
            prior = conn.execute(f"SELECT {COLUMNS} FROM swell_posters WHERE request_id=%s AND user_id=%s", (token, user_id)).fetchone()
        if prior:
            yield replay_event(prior, data)
            return

        yield {"stage": "rendering"}
        png = render_poster(data)
        yield {"stage": "saving"}
        with connect() as conn:
            row = conn.execute(f"""
                INSERT INTO swell_posters (request_id, brand, product, description, price, template_id, png, user_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (request_id) DO NOTHING RETURNING {COLUMNS}
            """, (token, data["brand"], data["product"], data["description"], data["price"], data["template_id"], png, user_id)).fetchone()
            if row is None:
                prior = conn.execute(f"SELECT {COLUMNS} FROM swell_posters WHERE request_id=%s AND user_id=%s", (token, user_id)).fetchone()
        # Exiting the connection context commits before clients receive "saved".
        yield replay_event(prior, data) if row is None else {"stage": "saved", "poster": record(row), "status": 201}
    except psycopg.Error:
        app.logger.exception("Poster database operation failed")
        yield {"stage": "failed", "status": 503, "error": "The poster library is unavailable. Check PostgreSQL and try again."}
    except Exception:
        app.logger.exception("Poster generation failed")
        yield {"stage": "failed", "status": 500, "error": "The studio could not generate this poster. Please try again."}


@app.get("/api/posters")
def list_posters():
    before = request.args.get("before")
    if before is not None and (not re.fullmatch(r"[0-9]{1,19}", before) or int(before) > 2**63-1):
        return jsonify(error="Invalid page cursor."), 400
    with connect() as conn:
        query = f"SELECT {COLUMNS} FROM swell_posters WHERE user_id=%s"
        params = (g.user["id"],)
        if before:
            query += " AND id < %s"
            params += (int(before),)
        rows = conn.execute(query + " ORDER BY id DESC LIMIT 13", params).fetchall()
    return jsonify(items=[record(row) for row in rows[:12]], next=rows[11]["id"] if len(rows) > 12 else None)


@app.delete("/api/posters/<int:poster_id>")
def delete_poster(poster_id):
    with connect() as conn:
        conn.execute("DELETE FROM swell_posters WHERE id=%s AND user_id=%s",
                     (poster_id, g.user["id"]))
    return jsonify(ok=True)


@app.get("/api/posters/<int:poster_id>/image")
def image(poster_id):
    with connect() as conn:
        row = conn.execute("SELECT png FROM swell_posters WHERE id=%s AND user_id=%s", (poster_id, g.user["id"])).fetchone()
    if not row:
        return jsonify(error="Poster not found."), 404
    return send_file(BytesIO(row["png"]), mimetype="image/png", download_name=f"swell-poster-{poster_id}.png",
                     as_attachment=request.args.get("download") == "1", max_age=86400)


@app.get("/")
def index():
    return send_from_directory(DIST, "index.html")


@app.get("/<path:filename>")
def asset(filename):
    return send_from_directory(DIST, filename)


if __name__ == "__main__":
    init_database()
    port = int(os.getenv("PORT", "5086"))
    host = os.getenv("HOST", "127.0.0.1")
    print(f"Swell Studio is ready at http://{host}:{port}", flush=True)
    serve(app, host=host, port=port)

