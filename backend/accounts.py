"""Account registration, graphical sign-in challenges and server-side sessions."""
import base64
import hashlib
import os
import re
import secrets
from io import BytesIO

from flask import Blueprint, jsonify, request
from PIL import Image, ImageDraw
from werkzeug.security import check_password_hash, generate_password_hash

from database import connect
from poster import font_for

auth = Blueprint("auth", __name__, url_prefix="/api/auth")
COOKIE = "swell_session"
PASSWORD_METHOD = "pbkdf2:sha256:600000"
DUMMY_HASH = generate_password_hash(secrets.token_hex(24), method=PASSWORD_METHOD)
ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def init_accounts(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS swell_users (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            email TEXT UNIQUE, password_hash TEXT, verified_at TIMESTAMPTZ,
            CHECK ((email IS NULL) = (password_hash IS NULL))
        );
        ALTER TABLE swell_users
            ALTER COLUMN email DROP NOT NULL,
            ALTER COLUMN password_hash DROP NOT NULL,
            ALTER COLUMN verified_at DROP NOT NULL,
            ALTER COLUMN verified_at DROP DEFAULT;
        CREATE TABLE IF NOT EXISTS swell_captchas (
            token TEXT PRIMARY KEY, answer_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS swell_sessions (
            token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES swell_users(id),
            expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS swell_rate_limits (
            bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
        );
    """)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def text_field(body, key, strip=True):
    value = body.get(key)
    if not isinstance(value, str) or "\x00" in value:
        return ""
    return value.strip() if strip else value


def form():
    body = request.get_json()
    return body if isinstance(body, dict) else {}


def email_field(body):
    email = text_field(body, "email").lower()
    if len(email) <= 254 and re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+", email):
        return email
    return ""


def allowed(bucket, limit, seconds):
    # Fixed windows and increments are shared transactionally by all workers.
    key = digest(bucket)
    with connect() as conn:
        conn.execute("DELETE FROM swell_rate_limits WHERE expires_at <= now()")
        row = conn.execute("""
            INSERT INTO swell_rate_limits(bucket,hits,expires_at)
            VALUES (%s,1,now()+%s * interval '1 second')
            ON CONFLICT(bucket) DO UPDATE SET hits=swell_rate_limits.hits+1
            RETURNING hits
        """, (key, seconds)).fetchone()
    return row["hits"] <= limit


def limited():
    return jsonify(error="Too many attempts. Please wait before trying again."), 429


@auth.post("/register")
def register():
    body = form()
    email = email_field(body)
    password = text_field(body, "password", False)
    if not email:
        return jsonify(error="Enter a valid email address."), 422
    if not 8 <= len(password) <= 128:
        return jsonify(error="Use a password with 8–128 characters."), 422
    if password != text_field(body, "confirm_password", False):
        return jsonify(error="Passwords do not match. Enter the same password twice."), 422
    if not allowed("register:"+str(request.remote_addr), 60, 600):
        return limited()
    with connect() as conn:
        created = conn.execute("""
            INSERT INTO swell_users(email,password_hash) VALUES (%s,%s)
            ON CONFLICT(email) DO NOTHING RETURNING id
        """, (email, generate_password_hash(password, method=PASSWORD_METHOD))).fetchone()
    if not created:
        return jsonify(error="This account already exists. Please sign in."), 409
    return jsonify(message="Account created. Sign in to open your studio."), 201


@auth.get("/captcha")
def captcha():
    if not allowed("captcha:"+str(request.remote_addr), 90, 600):
        return limited()
    token = secrets.token_urlsafe(24)
    answer = "".join(secrets.choice(ALPHABET) for _ in range(5))
    with connect() as conn:
        conn.execute("DELETE FROM swell_captchas WHERE expires_at<=now()")
        conn.execute("INSERT INTO swell_captchas VALUES (%s,%s,now()+interval '5 minutes')", (token, digest(token+answer)))
    canvas = Image.new("RGB",(178,52),"#e9edf9")
    draw = ImageDraw.Draw(canvas)
    for _ in range(10):
        draw.line([(secrets.randbelow(178),secrets.randbelow(52)) for _ in range(2)],fill="#b3bbda",width=1)
    font = font_for("bold", 29, False)
    for i, letter in enumerate(answer):
        draw.text((10+i*32+secrets.randbelow(4),2+secrets.randbelow(8)),letter,font=font,fill="#414a75")
    output = BytesIO()
    canvas.save(output,format="PNG")
    return jsonify(id=token, image="data:image/png;base64,"+base64.b64encode(output.getvalue()).decode())


def current_user():
    token = request.cookies.get(COOKIE, "")
    if not token or len(token) > 128:
        return None
    with connect() as conn:
        return conn.execute("""
            SELECT u.id,u.email FROM swell_sessions s JOIN swell_users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND s.expires_at>now()
        """, (digest(token),)).fetchone()


@auth.get("/me")
def me():
    return jsonify(user=current_user())


@auth.post("/login")
def login():
    body=form()
    email, password = email_field(body), text_field(body,"password",False)
    challenge, answer = text_field(body,"captcha_id"), text_field(body,"captcha").upper()
    if not email or not 1 <= len(password) <= 128 or len(challenge)>64 or not re.fullmatch(r"[A-Z0-9]{5}",answer):
        return jsonify(error="Enter your email, password and the five characters in the image."),422
    if not allowed("login:"+str(request.remote_addr), 60, 600):
        return limited()
    with connect() as conn:
        row=conn.execute("DELETE FROM swell_captchas WHERE token=%s AND expires_at>now() RETURNING answer_hash",(challenge,)).fetchone()
        if not row or not secrets.compare_digest(digest(challenge+answer),row["answer_hash"]):
            return jsonify(error="Incorrect or expired image code. Enter the new code shown."),422
        account=conn.execute("SELECT id,email,password_hash FROM swell_users WHERE email=%s",(email,)).fetchone()
        valid=check_password_hash(account["password_hash"] if account else DUMMY_HASH,password)
        if not account or not valid:
            return jsonify(error="The email or password is incorrect."),401
        return start_session(conn, account)


def start_session(conn, account):
    token = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM swell_sessions WHERE expires_at<=now() OR token_hash=%s",
                 (digest(request.cookies.get(COOKIE, "")),))
    conn.execute("INSERT INTO swell_sessions VALUES (%s,%s,now()+interval '7 days')",
                 (digest(token), account["id"]))
    response = jsonify(user={"id": account["id"], "email": account["email"]})
    cross_site=os.getenv("COOKIE_CROSS_SITE")=="1"
    response.set_cookie(COOKIE,token,max_age=604800,httponly=True,secure=cross_site or request.is_secure or os.getenv("COOKIE_SECURE")=="1",samesite="None" if cross_site else "Lax",path="/")
    return response


@auth.post("/guest")
def guest():
    existing = current_user()
    if existing:
        return jsonify(user=existing)
    if not allowed("guest:"+str(request.remote_addr), 60, 600):
        return limited()
    with connect() as conn:
        account = conn.execute("INSERT INTO swell_users DEFAULT VALUES RETURNING id,email").fetchone()
        return start_session(conn, account)


@auth.post("/logout")
def logout():
    with connect() as conn:
        conn.execute("DELETE FROM swell_sessions WHERE token_hash=%s",(digest(request.cookies.get(COOKIE,"")),))
    response=jsonify(ok=True)
    response.delete_cookie(COOKIE,path="/",secure=os.getenv("COOKIE_CROSS_SITE")=="1" or request.is_secure or os.getenv("COOKIE_SECURE")=="1",httponly=True,samesite="None" if os.getenv("COOKIE_CROSS_SITE")=="1" else "Lax")
    return response
