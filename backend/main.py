"""GoalPulse Python/FastAPI backend.

This replaces the Node server while keeping the existing frontend's /api contracts.
For a hackathon/local prototype only; see BACKEND_MIGRATION_V15.md for limits.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
import sqlite3
import threading
import math
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from backend import storage

BASE_DIR = Path(__file__).resolve().parents[1]
DIST_DIR = BASE_DIR / "dist"
DATA_DIR = Path(os.getenv("GOALPULSE_DATA_DIR", str(BASE_DIR / "var"))).resolve()
FAMILIES_FILE = DATA_DIR / "families.json"
MARKET_CACHE_FILE = DATA_DIR / "live-market-cache.json"
SESSION_TTL_SECONDS = 12 * 60 * 60
MAX_BODY_BYTES = 2_000_000

app = FastAPI(title="GoalPulse API", version="22.0.0")
_auth_attempts = defaultdict(deque)
_auth_lock = threading.Lock()
_migration_lock = threading.Lock()


@app.middleware("http")
async def request_limits(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
            return JSONResponse(status_code=403, content={"ok": False, "error": "Cross-origin requests are not allowed."})
        size = 0
        chunks = []
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY_BYTES:
                return JSONResponse(status_code=413, content={"ok": False, "error": "Request is too large. Export a smaller plan."})
            chunks.append(chunk)
        request._body = b"".join(chunks)
    if request.url.path in ("/api/auth/login", "/api/auth/register"):
        key = request.client.host if request.client else "unknown"
        with _auth_lock:
            attempts = _auth_attempts[key]
            now = time.monotonic()
            while attempts and attempts[0] < now - 60:
                attempts.popleft()
            if len(attempts) >= 20:
                return JSONResponse(status_code=429, content={"ok": False, "error": "Too many attempts. Try again in one minute."}, headers={"Retry-After": "60"})
            attempts.append(now)
    try:
        response = await call_next(request)
    except (OSError, sqlite3.Error):
        return JSONResponse(status_code=503, content={"ok": False, "error": "Storage is unavailable. Your save was not confirmed. Export a local backup and retry."})
    except (httpx.HTTPError, ValueError):
        return JSONResponse(status_code=502, content={"ok": False, "error": "External provider unavailable. Use the local plan summary or retry later."})
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
    return response


def db_path():
    return FAMILIES_FILE.with_suffix(".sqlite3")


def migrate_legacy():
    # Non-destructive, idempotent import. The old file is never served or overwritten.
    with _migration_lock:
        source = FAMILIES_FILE
        if not source.exists() and DATA_DIR == (BASE_DIR / "var").resolve() and FAMILIES_FILE.parent == DATA_DIR:
            source = DATA_DIR / "legacy-families.json"
            if not source.exists():
                source = DIST_DIR / "data" / "families.json"
        if not source.exists():
            return
        families = read_json(source, None)
        if not isinstance(families, dict):
            raise HTTPException(503, "Stored vault data could not be read. Restore a backup before continuing.")
        for family_id, family in families.items():
            if not isinstance(family, dict) or family_id == "FAM-2026":
                continue
            if isinstance(family.get("password"), str):
                family.update(password_record(family.pop("password")))
            try:
                storage.insert_family(db_path(), family_id, family)
            except sqlite3.IntegrityError:
                pass

@app.exception_handler(HTTPException)
async def api_http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": str(exc.detail)})

@app.exception_handler(RequestValidationError)
async def api_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"ok": False, "error": "Invalid request data.", "issues": exc.errors()})
_sessions: dict[str, dict[str, Any]] = {}
_market_cache: dict[str, Any] | None = None
_market_cache_at = 0.0


class AuthPayload(BaseModel):
    familyId: str = Field(default="", max_length=100)
    password: str = Field(default="", max_length=1024)
    familyName: str | None = Field(default=None, max_length=100)
    plan: dict[str, Any] | None = None


class SavePayload(BaseModel):
    familyId: str = Field(default="", max_length=100)
    plan: dict[str, Any] | None = None
    snapshots: list[Any] | None = None


def validate_plan(plan):
    if plan is None or plan == {}:
        return
    for key in ("income", "essential", "discretionary", "savings", "emergency"):
        value = plan.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise HTTPException(422, f"{key} must be a finite non-negative amount.")
    goals = plan.get("goals", [])
    loans = plan.get("loans", [])
    shocks = plan.get("shocks", [])
    if not all(isinstance(items, list) for items in (goals, loans, shocks)) or len(goals) > 30 or len(loans) > 20 or len(shocks) > 10:
        raise HTTPException(422, "Plan lists exceed their allowed size or have an invalid shape.")
    earmarks = 0
    ids = set()
    for g in goals:
        if not isinstance(g, dict) or not isinstance(g.get("id"), str) or not isinstance(g.get("name"), str) or not g["name"].strip():
            raise HTTPException(422, "Every goal needs an ID and name.")
        if g["id"] in ids:
            raise HTTPException(422, "Goal IDs must be unique.")
        ids.add(g["id"])
        for key in ("cost", "earmarked"):
            value = g.get(key, 0)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise HTTPException(422, "Goal amounts must be finite and non-negative.")
        if type(g.get("months")) is not int or not 1 <= g["months"] <= 600:
            raise HTTPException(422, "Goal deadlines must be 1–600 months.")
        earmarks += g.get("earmarked", 0)
    if plan["emergency"] > plan["savings"] or earmarks > plan["savings"] - plan["emergency"] + .01:
        raise HTTPException(422, "Emergency reserve and goal earmarks exceed total savings.")


class ExplainPayload(BaseModel):
    provider: str = "gemini"
    apiKey: str | None = Field(default=None, max_length=512)
    model: str | None = Field(default=None, max_length=100)
    endpoint: str | None = None
    systemInstruction: str | None = None
    prompt: str | None = Field(default=None, max_length=8000)
    context: Any = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def password_record(password: str) -> dict[str, str]:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=64)
    return {"passwordHash": digest.hex(), "passwordSalt": salt.hex(), "passwordScheme": "scrypt"}


def verify_password(record: dict[str, Any], password: str) -> bool:
    if record.get("passwordScheme") == "scrypt" and record.get("passwordHash") and record.get("passwordSalt"):
        try:
            actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(record["passwordSalt"]), n=2**14, r=8, p=1, dklen=64)
            return hmac.compare_digest(actual, bytes.fromhex(record["passwordHash"]))
        except (ValueError, TypeError):
            return False
    # Legacy plaintext record migration is supported for local prototype data only.
    return isinstance(record.get("password"), str) and hmac.compare_digest(record["password"], password)


def load_families_and_migrate() -> dict[str, Any]:
    families = read_json(FAMILIES_FILE, {})
    changed = False
    # Remove known public demo account if it is present.
    if isinstance(families, dict) and families.get("FAM-2026", {}).get("password") == "goalpulse2026":
        del families["FAM-2026"]
        changed = True
    if not isinstance(families, dict):
        return {}
    for family_id, record in list(families.items()):
        if isinstance(record, dict) and isinstance(record.get("password"), str) and record.get("passwordScheme") != "scrypt":
            record.update(password_record(record["password"]))
            record.pop("password", None)
            changed = True
    if changed:
        write_json(FAMILIES_FILE, families)
    return families


def issue_session(family_id: str) -> str:
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    with storage.database(db_path()) as db:
        db.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
        db.execute("INSERT INTO sessions VALUES (?,?,?)", (digest, family_id, time.time() + SESSION_TTL_SECONDS))
    return token


def current_family(authorization: str | None) -> str:
    token = (authorization or "").removeprefix("Bearer ").strip()
    digest = hashlib.sha256(token.encode()).hexdigest()
    with storage.database(db_path()) as db:
        row = db.execute("SELECT family FROM sessions WHERE token=? AND expires>?", (digest, time.time())).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Your session expired. Sign in again to sync your plan.")
    return row[0]


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)):
    token = (authorization or "").removeprefix("Bearer ").strip()
    with storage.database(db_path()) as db:
        db.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(token.encode()).hexdigest(),))
    return {"ok": True}


@app.get("/api/auth/me")
def restore_session(authorization: str | None = Header(default=None)):
    family_id = current_family(authorization)
    family = storage.get_family(db_path(), family_id)
    if not family:
        raise HTTPException(404, "Family vault not found.")
    return {"ok": True, "familyId": family_id, "familyName": family.get("familyName", family_id),
            "plan": family.get("plan"), "snapshots": family.get("snapshots", [])}


def auth_response(family_id: str, family: dict[str, Any], token: str, status: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status, content={
        "ok": True, "token": token, "familyId": family_id,
        "familyName": family.get("familyName", family_id),
        "plan": family.get("plan") or None, "snapshots": family.get("snapshots") or [],
    })


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "goalpulse-python", "version": app.version}


@app.post("/api/auth/register")
def register(payload: AuthPayload, request: Request) -> JSONResponse:
    family_id, password = payload.familyId.strip(), payload.password
    if not __import__("re").fullmatch(r"[A-Za-z0-9_-]{4,48}", family_id) or len(password) < 8:
        raise HTTPException(status_code=400, detail="Use a Family ID of 4–48 letters/numbers and a password of at least 8 characters.")
    validate_plan(payload.plan)
    migrate_legacy()
    if storage.get_family(db_path(), family_id):
        raise HTTPException(status_code=409, detail="That Family ID already exists. Sign in or choose another ID.")
    family = {"familyId": family_id, **password_record(password), "familyName": (payload.familyName or family_id)[:100],
              "plan": payload.plan or {}, "snapshots": [], "updatedAt": utc_now()}
    try:
        storage.insert_family(db_path(), family_id, family)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="That Family ID already exists.")
    return auth_response(family_id, family, issue_session(family_id), 201)


@app.post("/api/auth/login")
def login(payload: AuthPayload) -> JSONResponse:
    family_id, password = payload.familyId.strip(), payload.password
    migrate_legacy()
    family = storage.get_family(db_path(), family_id)
    if not isinstance(family, dict) or not verify_password(family, password):
        raise HTTPException(status_code=401, detail="Invalid Family ID or password.")
    return auth_response(family_id, family, issue_session(family_id))


@app.post("/api/auth/save")
def save(payload: SavePayload, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authenticated_family = current_family(authorization)
    if payload.familyId != authenticated_family:
        raise HTTPException(status_code=403, detail="You can only save to your own Family Vault.")
    validate_plan(payload.plan)
    if payload.snapshots is not None:
        if len(payload.snapshots) > 3:
            raise HTTPException(422, "Keep at most three snapshots.")
        for snapshot in payload.snapshots:
            if not isinstance(snapshot, dict) or not isinstance(snapshot.get("plan"), dict) or not isinstance(snapshot.get("result"), dict):
                raise HTTPException(422, "Snapshot structure is invalid.")
            validate_plan(snapshot["plan"])
    family = storage.save_family(db_path(), authenticated_family, payload.plan, payload.snapshots)
    if not family:
        raise HTTPException(status_code=404, detail="Family vault not found.")
    return {"ok": True, "updatedAt": family["updatedAt"]}



async def fetch_json(client: httpx.AsyncClient, url: str) -> dict[str, Any] | None:
    try:
        response = await client.get(url)
        response.raise_for_status()
        value = response.json()
        return value if isinstance(value, dict) else None
    except (httpx.HTTPError, ValueError):
        return None


@app.get("/api/live-market")
async def live_market() -> dict[str, Any]:
    global _market_cache, _market_cache_at
    now = time.time()
    if _market_cache and now - _market_cache_at < 900:
        return _market_cache
    disk_cache = read_json(MARKET_CACHE_FILE, None)
    if isinstance(disk_cache, dict) and disk_cache.get("schemaVersion") == 2:
        try:
            if now - datetime.fromisoformat(disk_cache.get("timestamp", "")).timestamp() < 900:
                _market_cache, _market_cache_at = disk_cache, now
                return disk_cache
        except (ValueError, TypeError, OverflowError):
            pass
    schemes = {"nifty": "120716", "gilt": "120594", "arbitrage": "119775", "gold": "119132"}
    async with httpx.AsyncClient(timeout=3.5, follow_redirects=True) as client:
        results = await __import__("asyncio").gather(*[
            fetch_json(client, f"https://api.mfapi.in/mf/{code}") for code in schemes.values()
        ])
        fx_json = await fetch_json(client, "https://query1.finance.yahoo.com/v8/finance/chart/INR=X?interval=1d&range=5d")
    navs: dict[str, Any] = {}
    live_count = 0
    fallbacks = {
        "nifty": ("UTI Nifty 50 Index Fund Direct (illustrative)", 184.25, .012),
        "gilt": ("ICICI Pru 10Y Constant Maturity Gilt Direct (illustrative)", 42.18, .006),
        "arbitrage": ("Kotak Equity Arbitrage Fund Direct (illustrative)", 36.94, .0055),
        "gold": ("HDFC Gold ETF FoF Direct (illustrative)", 28.65, .018),
    }
    for key, result in zip(schemes, results):
        latest = (result or {}).get("data", [{}])[0] if (result or {}).get("data") else {}
        older_data = (result or {}).get("data", [])
        older = older_data[21] if len(older_data) > 21 else (older_data[-1] if older_data else {})
        try:
            nav, previous = float(latest.get("nav", 0)), float(older.get("nav", 0))
        except (TypeError, ValueError):
            nav, previous = 0, 0
        expected = {"nifty": ("nifty", "index"), "gilt": ("gilt",), "arbitrage": ("arbitrage",), "gold": ("gold",)}
        scheme_name = str(((result or {}).get("meta") or {}).get("scheme_name", "")).lower()
        if result and nav > 0 and all(term in scheme_name for term in expected[key]):
            meta = result.get("meta") or {}
            navs[key] = {"name": meta.get("scheme_name", key), "nav": nav, "date": latest.get("date"),
                         "monthlyRet": (nav - previous) / previous if previous > 0 else 0,
                         "status": "live", "source": "AMFI/MFAPI"}
            live_count += 1
        else:
            name, value, ret = fallbacks[key]
            navs[key] = {"name": name, "nav": value, "monthlyRet": ret, "status": "assumed", "source": "illustrative fallback"}
    fx = (((fx_json or {}).get("chart") or {}).get("result") or [{}])[0]
    fx_rate = ((fx.get("meta") or {}).get("regularMarketPrice")) or 86.85
    navs["usdinr"] = {"rate": float(fx_rate), "date": datetime.now(timezone.utc).date().isoformat(),
                       "status": "live" if (fx_json and (fx.get("meta") or {}).get("regularMarketPrice")) else "assumed",
                       "source": "Yahoo Finance" if fx_json else "fallback estimate"}
    payload = {"ok": True, "schemaVersion": 2, "timestamp": utc_now(), "live": live_count == 4,
               "sourceStatus": "live" if live_count == 4 else ("assumed" if live_count == 0 else "partial"),
               "liveInstrumentCount": live_count, "instrumentCount": 4,
               "warning": None if live_count == 4 else "Some or all values are illustrative fallbacks. Do not treat them as live market observations.",
               "navs": navs}
    _market_cache, _market_cache_at = payload, now
    try:
        write_json(MARKET_CACHE_FILE, payload)
    except OSError:
        pass  # A quote remains usable when only the optional disk cache fails.
    return payload


@app.get("/api/ai-status")
def ai_status() -> dict[str, bool]:
    return {"serverHasGeminiKey": bool(os.getenv("GEMINI_API_KEY")), "serverHasOpenAIKey": bool(os.getenv("OPENAI_API_KEY"))}


async def ai_provider_post(client: httpx.AsyncClient, provider: str, url: str, **kwargs) -> tuple[httpx.Response, dict]:
    try:
        async with asyncio.timeout(60):
            response = await client.post(url, **kwargs)
            if response.status_code == 503:
                await asyncio.sleep(1)
                response = await client.post(url, **kwargs)
    except TimeoutError:
        raise HTTPException(504, f"{provider} did not respond within 60 seconds. Retry the connection test or use a shorter question.") from None
    except httpx.ConnectTimeout:
        raise HTTPException(504, f"{provider} connection timed out. Check the server's internet connection, firewall or proxy.") from None
    except httpx.TimeoutException:
        raise HTTPException(504, f"{provider} did not respond within 60 seconds. Retry the connection test or use a shorter question.") from None
    except httpx.ConnectError:
        raise HTTPException(502, f"{provider} could not establish a secure connection. Check internet access, DNS, VPN/proxy and certificate trust on the server.") from None
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"{provider} connection interrupted ({type(exc).__name__}). Retry the connection test.") from None
    try:
        result = response.json()
    except ValueError:
        raise HTTPException(502, f"{provider} returned HTTP {response.status_code} without a JSON response. A network gateway or upstream service may have rejected the request. Retry the connection test.") from None
    if not isinstance(result, dict):
        raise HTTPException(502, f"{provider} returned an unexpected response format. Retry later.")
    return response, result


def provider_error(provider: str, status: int, result: dict, key: str) -> str:
    hints = {400: "Check your API key and model settings.", 401: "The API key was rejected.",
             403: "Check API key restrictions and provider API access.",
             404: "This model is unavailable. Choose a model enabled for your API project.",
             429: "Quota or rate limit reached. Check your API project's billing and limits before retrying.",
             503: "The provider is busy. Retry shortly."}
    error = result.get("error") or {}
    message = str(error.get("message") or "Request failed.").replace(key, "[redacted]")[:1200]
    hint = hints.get(status, 'Retry later or check provider status.')
    if provider == "OpenAI" and status == 429:
        code = str(error.get("code") or error.get("type") or "")
        if code == "insufficient_quota" or any(term in message.lower() for term in ("no credits remaining", "insufficient_quota", "exceeded your current quota")):
            hint = "API credits or billing quota unavailable. This is not a temporary request-rate limit. Check the API billing balance and organization/project associated with this key; waiting or retrying will not restore credits."
        elif code == "rate_limit_exceeded" or "rate limit" in message.lower():
            hint = "Temporary API request/token rate limit. Wait for the provider's stated reset time before retrying."
    code = str(error.get("code") or error.get("type") or "")
    return f"{provider} HTTP {status}{' [' + code + ']' if code else ''}: {hint} {message}"


@app.post("/api/ai-test")
async def test_ai_connection(payload: ExplainPayload, authorization: str | None = Header(default=None)) -> dict[str, str]:
    # A connectivity probe never transmits household or financial data.
    probe = payload.model_copy(update={"prompt": "Reply with OK.", "context": None, "systemInstruction": "This is an API connection test. Reply briefly."})
    await explain(probe, authorization)
    return {"text": "Connection successful. The selected model responded."}


@app.post("/api/explain")
@app.post("/api/ai-explain")
async def explain(payload: ExplainPayload, authorization: str | None = Header(default=None)) -> dict[str, str]:
    provider = payload.provider or "gemini"
    if provider not in ("gemini", "openai"):
        raise HTTPException(status_code=400, detail="Unsupported AI provider.")
    key = (payload.apiKey or (os.getenv("GEMINI_API_KEY") if provider == "gemini" else os.getenv("OPENAI_API_KEY")) or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="No API key provided. Enter a key in AI Settings or set GEMINI_API_KEY / OPENAI_API_KEY.")
    if not payload.apiKey:
        current_family(authorization)
    system = payload.systemInstruction or "You are GoalPulse AI. Ground all answers strictly in verified math and explain assumptions clearly."
    prompt = payload.prompt or "Explain my financial plan."
    context = json.dumps(payload.context, ensure_ascii=False, indent=2) if isinstance(payload.context, (dict, list)) else str(payload.context or "")
    user_text = f"{prompt}\n\n=== VERIFIED QUANTITATIVE ENGINE CONTEXT ===\n{context}\n\nStrict Rules: Never invent, alter, or hallucinate numbers. Clearly label assumptions and uncertainty."
    async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
        if provider == "gemini":
            model = (payload.model or "gemini-3.8-flash").strip().removeprefix("models/")
            if model == "gemini-2.5-flash":
                model = "gemini-3.8-flash"
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{quote(model, safe='')}:generateContent"
            response, result = await ai_provider_post(client, "Gemini", url, headers={"x-goog-api-key": key}, json={"contents": [{"role": "user", "parts": [{"text": user_text}]}],
                "systemInstruction": {"parts": [{"text": system}]}, "generationConfig": {"maxOutputTokens": 8192, **({"thinkingConfig": {"thinkingLevel": "LOW"}} if model == "gemini-3.8-flash" else {})}})
            if response.is_error:
                raise HTTPException(status_code=502, detail=provider_error("Gemini", response.status_code, result, key))
            text = "".join(part.get("text", "") for part in (((result.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []) if not part.get("thought"))
            if not text.strip():
                reason = (result.get("promptFeedback") or {}).get("blockReason") or (result.get("candidates") or [{}])[0].get("finishReason", "empty response")
                raise HTTPException(502, f"Gemini returned no answer ({reason}). Try a shorter question or another supported model.")
            return {"text": text}
        endpoint = payload.endpoint or "https://api.openai.com/v1/chat/completions"
        # Avoid turning this endpoint into an arbitrary-URL proxy.
        if not endpoint.startswith("https://api.openai.com/"):
            raise HTTPException(status_code=400, detail="Only the official OpenAI API endpoint is allowed.")
        response, result = await ai_provider_post(client, "OpenAI", endpoint, headers={"Authorization": f"Bearer {key}"}, json={"model": payload.model or "gpt-4o-mini",
            "temperature": .2, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_text}]})
        if response.is_error:
            raise HTTPException(status_code=502, detail=provider_error("OpenAI", response.status_code, result, key))
        return {"text": ((result.get("choices") or [{}])[0].get("message") or {}).get("content") or "No response generated."}


# Static hosting keeps the existing frontend same-origin, so its /api URLs still work.
# Unknown non-API paths fall back to index.html to preserve the original server's SPA behavior.
@app.get("/{requested_path:path}")
def static_files(requested_path: str) -> FileResponse:
    if requested_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Unknown API endpoint.")
    parts = Path(requested_path).parts
    if any(part.startswith(".") for part in parts) or requested_path.lower().startswith("data/families") or Path(requested_path).suffix.lower() in (".sqlite3", ".db", ".py", ".pyc"):
        raise HTTPException(status_code=404, detail="Not found.")
    candidate = (DIST_DIR / requested_path).resolve()
    if candidate != DIST_DIR.resolve() and DIST_DIR.resolve() not in candidate.parents:
        raise HTTPException(status_code=403, detail="Forbidden")
    if candidate.is_dir():
        candidate = candidate / "index.html"
    if not candidate.is_file():
        if candidate.suffix:
            raise HTTPException(status_code=404, detail="File not found.")
        candidate = DIST_DIR / "index.html"
    return FileResponse(candidate)
