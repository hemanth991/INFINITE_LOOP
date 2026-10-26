import http from 'node:http';
import {readFile, writeFile, stat, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

const root = path.resolve('dist'),
  port = Number(process.env.PORT || 4173);

const familiesFile = path.resolve(process.env.GOALPULSE_DATA_DIR || 'var', 'legacy-families.json');
const marketCacheFile = path.join(root, 'data', 'live-market-cache.json');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

async function readJSON(filePath, defaultVal = {}) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return defaultVal;
  }
}

async function writeJSON(filePath, data) {
  try {
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    throw err;
  }
}

const authSessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function passwordRecord(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return {passwordHash: hash, passwordSalt: salt, passwordScheme: 'scrypt'};
}
function verifyPassword(family, password) {
  if (family.passwordScheme === 'scrypt' && family.passwordHash && family.passwordSalt) {
    const actual = scryptSync(String(password), family.passwordSalt, 64);
    const expected = Buffer.from(family.passwordHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  // Legacy accounts are migrated to scrypt after a successful sign-in.
  return typeof family.password === 'string' && family.password === password;
}
function issueSession(familyId) {
  const token = randomBytes(32).toString('hex');
  authSessions.set(token, {familyId, expiresAt: Date.now() + SESSION_TTL_MS});
  return token;
}
function sendJSON(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

async function handleAuth(pathname, req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 2e6) req.destroy();
  });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');
      const families = await readJSON(familiesFile, {});
      // Remove the old public demo account and migrate legacy plaintext records at rest.
      let migrated = false;
      if (families['FAM-2026']?.password === 'goalpulse2026') {
        delete families['FAM-2026'];
        migrated = true;
      }
      for (const [id, record] of Object.entries(families)) {
        if (record && typeof record.password === 'string' && record.passwordScheme !== 'scrypt') {
          Object.assign(record, passwordRecord(record.password));
          delete record.password;
          families[id] = record;
          migrated = true;
        }
      }
      if (migrated) await writeJSON(familiesFile, families);

      if (pathname === '/api/auth/register') {
        const familyId = String(data.familyId || '').trim();
        const password = String(data.password || '');
        if (!/^[A-Za-z0-9_-]{4,48}$/.test(familyId) || password.length < 8) {
          return sendJSON(res, 400, {ok: false, error: 'Use a Family ID of 4–48 letters/numbers and a password of at least 8 characters.'});
        }
        if (Object.hasOwn(families, familyId)) return sendJSON(res, 409, {ok: false, error: 'That Family ID already exists. Sign in or choose another ID.'});
        const family = {
          familyId,
          ...passwordRecord(password),
          familyName: String(data.familyName || familyId).slice(0, 100),
          plan: data.plan || {}, snapshots: [], updatedAt: new Date().toISOString()
        };
        families[familyId] = family;
        await writeJSON(familiesFile, families);
        const token = issueSession(familyId);
        return sendJSON(res, 201, {ok: true, token, familyId, familyName: family.familyName, plan: family.plan, snapshots: []});
      }

      if (pathname === '/api/auth/login') {
        const familyId = String(data.familyId || '').trim();
        const password = String(data.password || '');
        const family = Object.hasOwn(families, familyId) ? families[familyId] : null;
        if (!family || !verifyPassword(family, password)) return sendJSON(res, 401, {ok: false, error: 'Invalid Family ID or password.'});
        if (family.passwordScheme !== 'scrypt') {
          Object.assign(family, passwordRecord(password));
          delete family.password;
          families[familyId] = family;
          await writeJSON(familiesFile, families);
        }
        const token = issueSession(familyId);
        return sendJSON(res, 200, {ok: true, token, familyId, familyName: family.familyName, plan: family.plan || null, snapshots: family.snapshots || []});
      }

      if (pathname === '/api/auth/save') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const auth = authSessions.get(token);
        if (!auth || auth.expiresAt < Date.now()) {
          if (token) authSessions.delete(token);
          return sendJSON(res, 401, {ok: false, error: 'Your session expired. Sign in again to sync your plan.'});
        }
        const familyId = auth.familyId;
        const family = Object.hasOwn(families, familyId) ? families[familyId] : null;
        if (!family) return sendJSON(res, 404, {ok: false, error: 'Family vault not found.'});
        if (data.familyId !== familyId) return sendJSON(res, 403, {ok: false, error: 'You can only save to your own Family Vault.'});
        if (data.plan) family.plan = data.plan;
        if (data.snapshots) family.snapshots = data.snapshots;
        family.updatedAt = new Date().toISOString();
        families[familyId] = family;
        await writeJSON(familiesFile, families);
        return sendJSON(res, 200, {ok: true, updatedAt: family.updatedAt});
      }
      return sendJSON(res, 404, {ok: false, error: 'Not found'});
    } catch (err) {
      console.error('Auth endpoint error:', err.message);
      return sendJSON(res, 500, {ok: false, error: 'The request could not be completed.'});
    }
  });
}

let cachedMarketData = null;
let lastMarketFetch = 0;

async function handleLiveMarket(res) {
  const now = Date.now();
  // 15-minute cache
  if (cachedMarketData && (now - lastMarketFetch < 15 * 60 * 1000)) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(cachedMarketData));
    return;
  }

  // Check disk cache
  const diskCache = await readJSON(marketCacheFile, null);
  if (diskCache && (now - Date.parse(diskCache.timestamp || 0) < 15 * 60 * 1000)) {
    cachedMarketData = diskCache;
    lastMarketFetch = now;
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(diskCache));
    return;
  }

  try {
    // Scheme Codes:
    // 120716: UTI Nifty 50 Index Fund Direct Growth
    // 120594: ICICI Prudential Constant Maturity 10Y Gilt Direct Growth
    // 119775: Kotak Equity Arbitrage Fund Direct Growth
    // 119132: HDFC Gold ETF FoF Direct Growth
    const schemes = {
      nifty: '120716',
      gilt: '120594',
      arbitrage: '119775',
      gold: '119132'
    };

    const fetchMF = async code => {
      try {
        const r = await fetch(`https://api.mfapi.in/mf/${code}`, {signal: AbortSignal.timeout(3500)});
        if (!r.ok) return null;
        const j = await r.json();
        const latest = j.data?.[0];
        const monthAgo = j.data?.[21] || j.data?.[j.data?.length - 1];
        const nav = Number(latest?.nav || 0);
        const prevNav = Number(monthAgo?.nav || nav);
        const monthlyRet = prevNav > 0 ? (nav - prevNav) / prevNav : 0;
        return {name: j.meta?.scheme_name, nav, date: latest?.date, monthlyRet, status: 'live', source: 'AMFI/MFAPI'};
      } catch {
        return null;
      }
    };

    const [niftyData, giltData, arbData, goldData] = await Promise.all([
      fetchMF(schemes.nifty),
      fetchMF(schemes.gilt),
      fetchMF(schemes.arbitrage),
      fetchMF(schemes.gold)
    ]);

    // Live USD/INR from Yahoo Finance
    let usdinr = 86.85;
    try {
      const yRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/INR=X?interval=1d&range=5d', {signal: AbortSignal.timeout(3500)});
      if (yRes.ok) {
        const yJson = await yRes.json();
        const price = yJson.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price) usdinr = Number(price);
      }
    } catch {}

    const assumed = (name, nav, monthlyRet) => ({name, nav, monthlyRet, status: 'assumed', source: 'illustrative fallback'});
    const navs = {
      nifty: niftyData || assumed('UTI Nifty 50 Index Fund Direct (illustrative)', 184.25, 0.012),
      gilt: giltData || assumed('ICICI Pru 10Y Constant Maturity Gilt Direct (illustrative)', 42.18, 0.006),
      arbitrage: arbData || assumed('Kotak Equity Arbitrage Fund Direct (illustrative)', 36.94, 0.0055),
      gold: goldData || assumed('HDFC Gold ETF FoF Direct (illustrative)', 28.65, 0.018),
      usdinr: {rate: usdinr, date: new Date().toISOString().slice(0, 10), status: 'assumed', source: 'fallback estimate'}
    };
    const liveCount = [niftyData, giltData, arbData, goldData].filter(Boolean).length;
    const payload = {
      ok: true, timestamp: new Date().toISOString(),
      live: liveCount === 4, sourceStatus: liveCount === 4 ? 'live' : (liveCount === 0 ? 'assumed' : 'partial'),
      liveInstrumentCount: liveCount, instrumentCount: 4,
      warning: liveCount === 4 ? null : 'Some or all values are illustrative fallbacks. Do not treat them as live market observations.',
      navs
    };

    cachedMarketData = payload;
    lastMarketFetch = now;
    await writeJSON(marketCacheFile, payload);

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(payload));
  } catch (err) {
    // Return fallback with disk cache or default values
    const fallback = diskCache ? {...diskCache, live: false, sourceStatus: 'cached', warning: 'Showing cached market data; it may be stale.'} : {
      ok: true,
      timestamp: new Date().toISOString(),
      live: false, sourceStatus: 'assumed', warning: 'Market feed unavailable; illustrative values only.',
      navs: {
        nifty: {name: 'UTI Nifty 50 Index Fund Direct', nav: 184.25, monthlyRet: 0.012},
        gilt: {name: 'ICICI Pru 10Y Constant Maturity Gilt Direct', nav: 42.18, monthlyRet: 0.006},
        arbitrage: {name: 'Kotak Equity Arbitrage Fund Direct', nav: 36.94, monthlyRet: 0.0055},
        gold: {name: 'HDFC Gold ETF FoF Direct', nav: 28.65, monthlyRet: 0.018},
        usdinr: {rate: 86.85, date: new Date().toISOString().slice(0, 10)}
      }
    };
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(fallback));
  }
}

async function handleAIProxy(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');
      const provider = data.provider || 'gemini';
      const key = data.apiKey || (provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY);

      if (!key) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'No API key provided. Enter a key in AI Settings or set GEMINI_API_KEY / OPENAI_API_KEY.'}));
        return;
      }

      const systemInstruction =
        data.systemInstruction ||
        'You are GoalPulse AI, an institutional Certified Financial Planner (CFP) and quantitative wealth advisor. Ground all answers strictly in verified math.';
      const prompt = data.prompt || 'Explain my financial plan.';
      const contextStr = typeof data.context === 'object' ? JSON.stringify(data.context, null, 2) : String(data.context || '');
      const userText = `${prompt}\n\n=== VERIFIED QUANTITATIVE ENGINE CONTEXT ===\n${contextStr}\n\nStrict Rules: Never invent, alter, or hallucinate numbers. Answer in clear, engaging, structured English with rupee figures, and actionable advice.`;

      if (provider === 'gemini') {
        const requestedModel = (data.model || '').replace(/^models\//, '');
        const model = !requestedModel || requestedModel === 'gemini-2.5-flash' ? 'gemini-3.8-flash' : requestedModel;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        const geminiRes = await fetch(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            contents: [{role: 'user', parts: [{text: userText}]}],
            systemInstruction: {parts: [{text: systemInstruction}]},
            generationConfig: {maxOutputTokens: 8192, ...(model === 'gemini-3.8-flash' ? {thinkingConfig: {thinkingLevel: 'LOW'}} : {})}
          })
        });
        const resJson = await geminiRes.json();
        if (!geminiRes.ok) {
          throw new Error(resJson.error?.message || `Gemini API error: ${geminiRes.statusText}`);
        }
        const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({text}));
      } else {
        const model = data.model || 'gpt-4o-mini';
        const endpoint = data.endpoint || 'https://api.openai.com/v1/chat/completions';
        if (!endpoint.startsWith('https://api.openai.com/')) throw Error('Only the official OpenAI API endpoint is allowed.');
        const oaiRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              {role: 'system', content: systemInstruction},
              {role: 'user', content: userText}
            ]
          })
        });
        const resJson = await oaiRes.json();
        if (!oaiRes.ok) {
          throw new Error(resJson.error?.message || `OpenAI API error: ${oaiRes.statusText}`);
        }
        const text = resJson.choices?.[0]?.message?.content || 'No response generated.';
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({text}));
      }
    } catch (err) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: err.message}));
    }
  });
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);

      // Auth Endpoints
      if (pathname.startsWith('/api/auth/')) {
        if (req.method !== 'POST') return sendJSON(res, 405, {ok: false, error: 'POST required.'});
        await handleAuth(pathname, req, res);
        return;
      }

      // Live Market Feed Endpoint
      if (pathname === '/api/live-market' && req.method === 'GET') {
        await handleLiveMarket(res);
        return;
      }

      // AI status endpoint
      if (pathname === '/api/ai-status' && req.method === 'GET') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(
          JSON.stringify({
            serverHasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
            serverHasOpenAIKey: Boolean(process.env.OPENAI_API_KEY)
          })
        );
        return;
      }

      // AI explanation proxy endpoint
      if ((pathname === '/api/explain' || pathname === '/api/ai-explain') && req.method === 'POST') {
        await handleAIProxy(req, res);
        return;
      }

      if (pathname.startsWith('/api/')) return sendJSON(res, 404, {ok:false,error:'Unknown API endpoint'});
      if (pathname.toLowerCase().startsWith('/data/families') || pathname.split('/').some(part=>part.startsWith('.'))) return sendJSON(res, 404, {ok:false,error:'Not found'});
      // Static file serving
      let file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep) && file !== root) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      } catch {
        file = path.join(root, 'index.html');
      }
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(await readFile(file));
    } catch {
      res.writeHead(500);
      res.end('Unable to load the application.');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`GoalPulse Local: http://127.0.0.1:${port}`));
