# GoalPulse | Team INFINITE LOOP

**Srujana Tech Fest 2026 - Finance F-02: Multi-Goal Financial Planning Under Uncertainty**

[Detailed project report (PDF)](docs/GoalPulse_Detailed_Project_Report.pdf) | [Report source](docs/GoalPulse_Detailed_Project_Report.md) | [Team contributions](docs/CONTRIBUTIONS.md) | [Verification](docs/VERIFICATION.md)

A multi-goal planning simulator with a JavaScript calculation engine and a Python/FastAPI backend.

## Submission report

The final submission package includes a detailed PDF report and reproduction notes in `docs/`. It uses synthetic demo inputs and excludes private accounts, database files and API keys.

## Run locally

On Windows, double-click `Start GoalPulse.cmd`. The project virtual environment has been prepared on this machine. Alternatively, from this directory:

```powershell
.\.venv\Scripts\python.exe run_backend.py
```

Open http://127.0.0.1:4173. `npm start` starts the same Python backend. `server.mjs` is retained as a legacy reference and is not the recommended entry point.

For a fresh checkout, use Python 3.11 or later:

```sh
python -m venv .venv
# Activate the environment, then:
python -m pip install -r requirements.txt
python run_backend.py
```

## Reliability changes

- Profile and wizard edits survive background calculations. Goal drafts remain separate until Apply.
- Lifestyle/date locks affect recovery and scenario alternatives. Changing a lock does not open the assistant.
- The savings infographic separates the emergency reserve, goal earmarks and available savings. An explicit repair action fits excessive draft earmarks proportionally to the real budget.
- Removing goals, loans, shocks and snapshots has a concrete action. Snapshots remain household-specific and store compact comparison outputs.
- Recurring debt prepayments consume actual surplus, appear in the ledger/mandate and use the same amortization calculation as the preview. Refinancing compares the same payoff horizon.
- Unsupported strategy flags no longer create income, artificially lower inflation or assume refinancing. Supported cash-yield and fee toggles use consistent inputs.
- Goal uncertainty bands, funding progress, savings allocation, debt comparison and snapshot probability bars provide visual explanations.
- Market NAVs retain decimal precision, quote dates and source status. A feed whose scheme name does not match the intended asset is rejected in favor of an explicitly assumed value.
- AI explanations escape HTML and honor the selected provider/model. Without a working provider, the app explains the current model snapshot; it does not claim to have simulated a chat request.

## Private storage

The primary backend stores accounts and hashed, revocable session tokens in `var/families.sqlite3`, outside the public `dist/` folder. SQLite transactions prevent concurrent registrations or saves from corrupting a shared JSON file. Sessions expire after 12 hours and survive server restarts until expiry or logout.

The original account file was preserved as `var/legacy-families.json`. On the first normal auth request, records are imported into SQLite without overwriting that backup. Do not upload `var/`, `var-test/`, local environments, test output or account backups as public assets.

Browser storage is a device copy. The header distinguishes confirmed vault saves from device-only copies. Malformed saved plans have a recovery export/earmark repair path. JSON import keeps a restorable copy of the previous plan.

## Deploy the backend

A static-only upload of `dist/` cannot provide account login, saving or AI proxy endpoints. Deploy the Python service together with `dist/`.

Environment settings:

- `HOST`: default `127.0.0.1`; use `0.0.0.0` in a hosting container.
- `PORT`: default `4173`; use the port supplied by the host.
- `GOALPULSE_DATA_DIR`: private persistent directory for the SQLite database and market cache. The default is `var/` next to this README.
- `GEMINI_API_KEY` / `OPENAI_API_KEY`: optional server-side AI keys. Using server-funded AI requires an authenticated vault session.

Use HTTPS at the hosting proxy and preserve the original host and scheme headers. Keep the SQLite volume persistent, private and backed up. This setup is intended for one host with a persistent disk; horizontally distributed replicas need a shared database and distributed rate limiter.

A `Dockerfile` and `.dockerignore` are included as a packaging template; Docker deployment itself has not been exercised in this environment. Mount a writable persistent volume at `/data` for UID 10001. Never bake private account files into the image.

## Verification

```sh
npm test
npm run build
python -m pip install -r requirements-dev.txt
python -m pytest backend/test_api.py -q
```

The current pass includes 82 Node tests and 31 Python API tests. Browser verification covers the key workflows recorded in `RELIABILITY_V22.md`. Build checks module syntax and creates route entry points; it is not a browser test.

## Model limits

The bundled 240 monthly observations (2006â€“2025) are synthetic, not observed history. Return, volatility, correlation, statutory rates and taxes are modelling assumptions. Tax lots, product eligibility, actual prepayment fees and policy-specific insurance rules are not fully modelled. Recovery is a bounded search, not proof of a global optimum. The app never executes investments or transfers.

Live AI requests were exercised: Gemini returned HTTP 503 high demand and OpenAI reported unavailable API credits. A successful end-to-end cloud explanation is not claimed. Public hosting, HTTPS behavior, load testing, disaster recovery and independent financial review still need validation in the intended deployment environment. Earlier audit notes in this folder describe prior versions and may contain superseded behavior.


## AI setup and limits

The planner works without an API key. For optional explanations, open **Features > AI settings**, select the matching provider and model, enter your own key directly in the app, and use **Test connection** before saving. Gemini defaults to `gemini-3.8-flash`; OpenAI defaults to `gpt-4o-mini`. The old Gemini 2.5 Flash default migrates automatically. A Gemini model/key must not be mixed with an OpenAI provider/key.

For public hosting, prefer server environment variables instead of embedding a shared key in frontend code. Server-funded AI requires an authenticated session. User-entered keys are currently persisted in that browser's local storage; this is a prototype limitation, not a secure production secrets vault. No key is included in the repository.

The minimal connection probe sends no financial context. Normal AI explanations send a structured plan snapshot to the selected provider. Cloud provider availability, model access, billing and quotas are external dependencies. One HTTP 503 retry is bounded by a 60-second request deadline; billing/credit errors are not retried as rate limits.

## Demo data

Bundled profiles in `dist/data/personas.js` are synthetic examples. Create a new household through the registration flow; there are no shared production credentials. For a numerical example that requires no account or API key, run `node scripts/reproduce-demo.mjs`. That script reports a baseline and a six-month income-interruption case using the same engine.

## Attribution and development assistance

This is a vanilla JavaScript/HTML/CSS application with Python FastAPI, Uvicorn and HTTPX; tests use Node's test runner and pytest/AnyIO. SQLite is supplied by Python. Market integrations reference MFAPI and Yahoo Finance; optional explanations use Google Gemini or OpenAI. The bundled monthly return data are synthetic. AI-assisted tools supported coding, debugging, review and documentation; team ownership and individual contributions are documented in the report and must be confirmed by the team. This prototype does not execute investments or provide independently validated financial advice.
