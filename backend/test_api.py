import json
from pathlib import Path

import httpx
import pytest

from backend import main


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "FAMILIES_FILE", tmp_path / "families.json")
    monkeypatch.setattr(main, "MARKET_CACHE_FILE", tmp_path / "market.json")
    main._sessions.clear()
    main._auth_attempts.clear()
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_register_login_and_password_hash(client):
    response = await client.post("/api/auth/register", json={"familyId": "family_abc", "password": "correct-horse-7", "plan": {"income": 90000, "essential": 20000, "discretionary": 10000, "savings": 100000, "emergency": 50000}})
    assert response.status_code == 201
    data = response.json()
    assert data["ok"] is True and data["token"]
    stored = main.storage.get_family(main.db_path(), "family_abc")
    assert stored["passwordScheme"] == "scrypt"
    assert "password" not in stored
    login = await client.post("/api/auth/login", json={"familyId": "family_abc", "password": "correct-horse-7"})
    assert login.status_code == 200
    assert login.json()["plan"]["income"] == 90000


@pytest.mark.anyio
async def test_save_requires_auth_and_family_match(client):
    registered = await client.post("/api/auth/register", json={"familyId": "family_abc", "password": "correct-horse-7"})
    token = registered.json()["token"]
    body = {"familyId": "family_abc", "plan": {"income": 90000, "essential": 20000, "discretionary": 10000, "savings": 100000, "emergency": 50000, "goals": [{"id": "edu", "name": "Education", "months": 120, "cost": 1000000, "earmarked": 0}]}}
    unauth = await client.post("/api/auth/save", json=body)
    assert unauth.status_code == 401
    cross_family = await client.post("/api/auth/save", json={**body, "familyId": "family_xyz"}, headers={"Authorization": f"Bearer {token}"})
    assert cross_family.status_code == 403
    saved = await client.post("/api/auth/save", json=body, headers={"Authorization": f"Bearer {token}"})
    assert saved.status_code == 200 and saved.json()["ok"]
    login = await client.post("/api/auth/login", json={"familyId": "family_abc", "password": "correct-horse-7"})
    assert login.json()["plan"]["goals"][0]["name"] == "Education"


@pytest.mark.anyio
async def test_invalid_registration_is_rejected(client):
    response = await client.post("/api/auth/register", json={"familyId": "bad", "password": "short"})
    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert "error" in response.json()


@pytest.mark.anyio
async def test_health_and_static_home(client):
    health = await client.get("/api/health")
    assert health.status_code == 200 and health.json()["service"] == "goalpulse-python"
    home = await client.get("/")
    assert home.status_code == 200 and "GoalPulse" in home.text


@pytest.mark.anyio
async def test_private_data_and_missing_assets_are_not_served(client):
    for path in ("/data/families.json", "/data/families.sqlite3", "/.env", "/missing.js", "/api/unknown"):
        response = await client.get(path)
        assert response.status_code == 404, path
        assert "passwordHash" not in response.text
    assert (await client.get("/goals")).status_code == 200


@pytest.mark.anyio
async def test_session_survives_memory_reset_and_logout_revokes_it(client):
    registered = (await client.post("/api/auth/register", json={"familyId": "durable_family", "password": "correct-horse-7"})).json()
    headers = {"Authorization": "Bearer " + registered["token"]}
    main._sessions.clear()
    assert (await client.post("/api/auth/save", headers=headers, json={"familyId": "durable_family", "plan": {}})).status_code == 200
    assert (await client.post("/api/auth/logout", headers=headers)).status_code == 200
    assert (await client.post("/api/auth/save", headers=headers, json={"familyId": "durable_family"})).status_code == 401


@pytest.mark.anyio
async def test_duplicate_registration_is_atomic(client):
    import asyncio
    body = {"familyId": "same_family", "password": "correct-horse-7"}
    responses = await asyncio.gather(*[client.post("/api/auth/register", json=body) for _ in range(3)])
    assert sorted(r.status_code for r in responses) == [201, 409, 409]


@pytest.mark.anyio
async def test_limits_origin_and_auth_throttling(client):
    response = await client.post("/api/auth/login", headers={"Origin": "https://unrelated.example"}, json={})
    assert response.status_code == 403
    assert (await client.post("/api/auth/login", content=b"x" * (main.MAX_BODY_BYTES + 1))).status_code == 413
    for _ in range(20):
        assert (await client.post("/api/auth/login", json={})).status_code == 401
    assert (await client.post("/api/auth/login", json={})).status_code == 429


@pytest.mark.anyio
async def test_invalid_financial_input_and_excess_snapshots_are_rejected(client):
    body = {"familyId": "valid_family", "password": "correct-horse-7"}
    assert (await client.post("/api/auth/register", json={**body, "plan": {"income": -1}})).status_code == 422
    registered = (await client.post("/api/auth/register", json=body)).json()
    response = await client.post("/api/auth/save", headers={"Authorization": "Bearer " + registered["token"]}, json={"familyId": "valid_family", "snapshots": [{}] * 4})
    assert response.status_code == 422


@pytest.mark.anyio
async def test_wrong_market_instruments_are_never_labelled_live(client, monkeypatch):
    async def wrong_feed(_client, url):
        if "mfapi" in url:
            return {"meta": {"scheme_name": "Some Technology Fund"}, "data": [{"nav": "100", "date": "23-10-2026"}]}
        return None
    monkeypatch.setattr(main, "fetch_json", wrong_feed)
    monkeypatch.setattr(main, "_market_cache", None)
    result = (await client.get("/api/live-market")).json()
    assert result["live"] is False
    assert result["liveInstrumentCount"] == 0
    assert all(result["navs"][key]["status"] == "assumed" for key in ("nifty", "gilt", "gold", "arbitrage"))


@pytest.mark.anyio
async def test_server_ai_keys_require_a_session(client, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-used")
    response = await client.post("/api/explain", json={"provider": "openai", "prompt": "Hello"})
    assert response.status_code == 401


@pytest.mark.anyio
async def test_storage_failure_never_confirms_a_save(client, monkeypatch):
    registered = (await client.post("/api/auth/register", json={"familyId": "save_family", "password": "correct-horse-7"})).json()
    def fail(*args):
        raise OSError("simulated disk failure")
    monkeypatch.setattr(main.storage, "save_family", fail)
    response = await client.post("/api/auth/save", headers={"Authorization": "Bearer " + registered["token"]}, json={"familyId": "save_family", "plan": {}})
    assert response.status_code == 503
    assert response.json()["ok"] is False


@pytest.mark.anyio
async def test_session_restore_never_exposes_password_fields(client):
    registered = (await client.post("/api/auth/register", json={"familyId": "restore_family", "password": "correct-horse-7"})).json()
    response = await client.get("/api/auth/me", headers={"Authorization": "Bearer " + registered["token"]})
    assert response.status_code == 200
    assert response.json()["familyId"] == "restore_family"
    assert "password" not in response.text
    assert (await client.get("/api/auth/me")).status_code == 401


@pytest.mark.anyio
async def test_legacy_import_preserves_original_backup(client):
    original = {"legacy_family": {"familyId": "legacy_family", "password": "correct-horse-7", "plan": {}}}
    main.FAMILIES_FILE.write_text(json.dumps(original))
    response = await client.post("/api/auth/login", json={"familyId": "legacy_family", "password": "correct-horse-7"})
    assert response.status_code == 200
    assert json.loads(main.FAMILIES_FILE.read_text()) == original
    record = main.storage.get_family(main.db_path(), "legacy_family")
    assert record["passwordScheme"] == "scrypt"
    assert "password" not in record

@pytest.mark.anyio
@pytest.mark.parametrize('status,phrase', [(400, 'key'), (403, 'restrictions'), (404, 'model'), (429, 'Quota'), (503, 'busy')])
async def test_ai_provider_errors_are_actionable_and_redacted(client, monkeypatch, status, phrase):
    original_client = httpx.AsyncClient
    def handler(request):
        assert 'key=' not in str(request.url)
        assert request.headers['x-goog-api-key'] == 'test-secret'
        return httpx.Response(status, json={'error': {'message': 'Failed for test-secret'}})
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(handler)))
    response = await client.post('/api/ai-test', json={'provider': 'gemini', 'apiKey': 'test-secret'})
    assert response.status_code == 502
    assert phrase in response.json()['error']
    assert 'test-secret' not in response.text


@pytest.mark.anyio
async def test_ai_probe_excludes_plan_and_normalizes_model(client, monkeypatch):
    original_client = httpx.AsyncClient
    def handler(request):
        assert str(request.url).endswith('/models/gemini-3.8-flash:generateContent')
        data = json.loads(request.content)
        assert 'private-household' not in str(data)
        assert data['generationConfig']['thinkingConfig']['thinkingLevel'] == 'LOW'
        assert 'temperature' not in data['generationConfig']
        assert 'thinkingBudget' not in data['generationConfig']['thinkingConfig']
        return httpx.Response(200, json={'candidates': [{'content': {'parts': [{'thought': True, 'text': 'hidden'}, {'text': 'OK'}]}}]})
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(handler)))
    response = await client.post('/api/ai-test', json={'apiKey': 'test-secret', 'model': 'models/gemini-2.5-flash', 'context': {'family': 'private-household'}})
    assert response.status_code == 200
    assert 'successful' in response.json()['text']


@pytest.mark.anyio
async def test_ai_empty_response_is_an_error(client, monkeypatch):
    original_client = httpx.AsyncClient
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'candidates': [{'finishReason': 'MAX_TOKENS', 'content': {'parts': []}}]}))))
    response = await client.post('/api/explain', json={'apiKey': 'test-secret'})
    assert response.status_code == 502
    assert 'MAX_TOKENS' in response.json()['error']


@pytest.mark.anyio
async def test_gemini_default_is_current(client, monkeypatch):
    original_client = httpx.AsyncClient
    def handler(request):
        assert '/models/gemini-3.8-flash:generateContent' in str(request.url)
        return httpx.Response(200, json={'candidates': [{'content': {'parts': [{'text': 'OK'}]}}]})
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(handler)))
    response = await client.post('/api/ai-test', json={'apiKey': 'test-secret'})
    assert response.status_code == 200


@pytest.mark.anyio
@pytest.mark.parametrize('failure,phrase,status', [
    (httpx.ReadTimeout('secret-url'), '60 seconds', 504),
    (httpx.ConnectError('secret-url'), 'secure connection', 502),
    (httpx.RemoteProtocolError('secret-url'), 'interrupted', 502),
])
async def test_ai_network_diagnostics(client, monkeypatch, failure, phrase, status):
    original_client = httpx.AsyncClient
    def handler(request):
        raise failure
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(handler)))
    response = await client.post('/api/ai-test', json={'apiKey': 'test-secret'})
    assert response.status_code == status
    assert phrase in response.json()['error']
    assert 'secret-url' not in response.text


@pytest.mark.anyio
async def test_ai_non_json_gateway_response(client, monkeypatch):
    original_client = httpx.AsyncClient
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(lambda request: httpx.Response(503, text='<html>private gateway text</html>'))))
    response = await client.post('/api/ai-test', json={'apiKey': 'test-secret'})
    assert response.status_code == 502
    assert 'HTTP 503 without a JSON response' in response.json()['error']
    assert 'private gateway text' not in response.text


@pytest.mark.anyio
async def test_ai_retries_temporary_overload_once(client, monkeypatch):
    original_client = httpx.AsyncClient
    calls = []
    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503, json={'error': {'message': 'High demand'}})
        return httpx.Response(200, json={'candidates': [{'content': {'parts': [{'text': 'OK'}]}}]})
    monkeypatch.setattr(main.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(handler)))
    response = await client.post('/api/ai-test', json={'apiKey': 'test-secret'})
    assert response.status_code == 200
    assert len(calls) == 2


@pytest.mark.parametrize('error,expected', [
    ({'code': 'insufficient_quota', 'message': 'You exceeded your current quota.'}, 'API credits or billing quota unavailable'),
    ({'message': 'You have no credits remaining.'}, 'API credits or billing quota unavailable'),
    ({'code': 'rate_limit_exceeded', 'message': 'Rate limit reached.'}, 'Temporary API request/token rate limit'),
])
def test_openai_distinguishes_credit_and_rate_limits(error, expected):
    message = main.provider_error('OpenAI', 429, {'error': error}, 'test-secret')
    assert expected in message


def test_concurrent_fresh_database_initialization(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    import sqlite3
    from backend import storage
    db_path = tmp_path / 'fresh-concurrent.sqlite3'
    def insert(_):
        try:
            storage.insert_family(db_path, 'one-family', {'name': 'Disposable concurrency test'})
            return 'created'
        except sqlite3.IntegrityError:
            return 'duplicate'
    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(insert, range(8)))
    assert outcomes.count('created') == 1
    assert outcomes.count('duplicate') == 7
    assert storage.get_family(db_path, 'one-family')['name'] == 'Disposable concurrency test'
