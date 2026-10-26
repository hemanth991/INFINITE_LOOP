# Final verification - 26 October 2026

- JavaScript: 82 tests passed, 0 failed.
- Python/API: 31 tests passed, 0 failed.
- Build/syntax check passed.
- Added a schema-initialization lock after an observed SQLite first-request race. The new eight-thread fresh-database test produced one insertion and seven unique-key rejections. This is not a load certification.
- Engine reproduction: first-month surplus INR 39,792.33; baseline unfunded INR 0; six-month full income interruption from month 3 produced cumulative unfunded INR 124,428.41. Long-horizon goals remained modelled as funded in that particular configuration.
- Some Node checks inspect source patterns. They are not proof of browser interactions. Prior browser verification and the QA screenshots are separate evidence.
- Gemini live probes returned HTTP 503. OpenAI reported missing API credits. A successful live cloud explanation is not claimed.
- No public hosting, container build, broad accessibility audit, independent finance validation or production load test is claimed.

## Reproduce

```sh
node check.mjs
node --test tests/*.test.mjs
python -m pip install -r requirements-dev.txt
python -m pytest backend/test_api.py -q
node scripts/reproduce-demo.mjs
```

Screenshots contain a disposable QA household, not a real customer's records. The numerical example uses a separate synthetic fixture.
