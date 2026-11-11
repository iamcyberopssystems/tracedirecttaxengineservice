# Trace.Direct tax engine service

A small private HTTP service that runs the open-source dTax tax engine, **unmodified**, for the Trace.Direct backend. The backend sends transactions and receives cost basis, gains and losses, and Form 8949 line data. Every customer-facing document is produced by the backend, not by this service.

This repository is public because the service is licensed under the AGPL-3.0 (see [NOTICE.md](NOTICE.md)).

## What it does and does not do
- Converts JSON to the engine's input types and the engine's results back to JSON. It uses only the engine's public exports.
- Adds **no tax logic**. Its tests call the engine directly with the same input and require identical results.
- Never changes, patches, forks or monkey-patches the engine. The engine source enters the build only through `engine/verify_engine.py fetch`, which checks every file against the pin.
- Never generates the engine's PDF reports.

## API
| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness and the pinned engine commit |
| `GET /source` | none | Source locations, licences, engine commit and build fingerprint (AGPL section 13) |
| `POST /v1/calculate` | `Authorization: Bearer <ENGINE_SERVICE_TOKEN>` | Cost basis and gains, with optional Form 8949 data |
| `POST /v1/parse` | `Authorization: Bearer <ENGINE_SERVICE_TOKEN>` | Detect and parse an exchange CSV with the engine's own parsers |
| `POST /v1/reconcile` | `Authorization: Bearer <ENGINE_SERVICE_TOKEN>` | Parse a Form 1099-DA CSV and reconcile it with our sales (engine's `parse1099DA` and `reconcile`) |

`POST /v1/calculate` body:

```json
{
  "method": "FIFO",
  "strictSilo": true,
  "lots":   [{"id": "L1", "asset": "BTC", "amount": 1, "costBasisUsd": 10000, "acquiredAt": "2023-01-01T00:00:00Z", "sourceId": "W1"}],
  "events": [{"id": "S1", "asset": "BTC", "amount": 1, "proceedsUsd": 25000, "date": "2024-03-01T00:00:00Z", "sourceId": "W1"}],
  "transfers": [],
  "consumptionEvents": [],
  "form8949": {"taxYear": 2024, "reportingBasis": "none"}
}
```

Request rules:
- **`method`** is one of `FIFO`, `LIFO`, `HIFO` or `IN_VDA`.
- **`strictSilo`** defaults to `true`, which is wallet-by-wallet basis, the US rule from 2025.
- **Disposals** are calculated in date order.
- **Unknown fields are refused.** The request carries opaque ids, asset symbols, amounts, USD values and UTC dates only, never names, tax ids or wallet addresses.

Each result is the engine's own `CalculationResult`, plus `baseLotId` for lots that were moved between wallets. A result with `unmatchedAmount` greater than 0 means some of the coins disposed of had no funded lot. The engine counted that part at zero basis, and the backend must flag it for review.

`POST /v1/parse` body: `{"csv": "<file text>", "format": "kraken"}` (`format` optional; without it the engine detects the format).
The answer has `detectedFormat`, `format`, `summary` (`totalRows`, `parsed`, `failed`), `transactions` (the engine's parsed rows
without the free-text `notes`) and `errors` (`row` and `message` only; the raw row is never returned, as it can hold
addresses or names). Verified for Trace.Direct: generic, Coinbase, Binance, Kraken and Gemini (`test/fixtures/csv`).

`POST /v1/reconcile` body: `{"csv": "<1099-DA file text>", "taxYear": 2025, "dispositions": [{"eventId", "asset",
"dateSold", "proceeds", "costBasis", "gainLoss"}]}`: one disposition per sale of the same broker account. The answer has
`parse` (`entries`, `errors`), `summary` (the engine's counts and net differences) and `items` (`status`, `riskLevel`,
`coverageStatus`, `broker` row, `eventId`, differences). Not passed back: broker transaction ids, the broker name, the
engine's suggestion texts and its `estimatedTaxOverpayment` guess. Layouts the engine reads: Coinbase and generic
(`test/fixtures/1099da`). The CSV is limited to 2 MB.

**UTC only.** The engine reads Binance, Kraken and Gemini times in the process's local time zone. The service refuses to
start unless its zone is UTC; the Docker image and `npm start` set `TZ=UTC`.

Error responses:
- **400:** invalid request.
- **401:** bad token.
- **413:** body over 10 MB.
- **415:** not JSON.
- **422:** the engine refused the input.

## Build and run
You need Node 24, Python 3, git and corepack.

```bash
bash scripts/build-engine.sh          # fetch the pinned commit, verify every file, build with the engine's own pnpm and lockfile
npm test                              # service tests (needs the built engine)
ENGINE_SERVICE_TOKEN=$(openssl rand -hex 32) npm start
```

The service has no npm dependencies of its own.

Docker: `docker build -t engine-service .` builds the same way. The image holds only the engine's production files, checks that its `dist/index.js` matches the verified build, and runs as a non-root user.

## Deployment
- Run it as a **private service**, reachable only by the backend. Do not give it a public URL.
- Set `ENGINE_SERVICE_TOKEN` to at least 32 random characters, and use the same value in the backend.
- `PORT` defaults to 8080.

## Logging
The service logs only the route, status and duration of each request. Request bodies, results and tokens are never logged.

The engine itself writes a console warning when a disposal has too few lots. The warning names the asset and amount but has no customer identity. It is left as is, because silencing it would mean changing the engine's behaviour.

## Security checks (CI)
- Engine integrity: fetch and verify the exact pinned commit.
- Service tests.
- Audit of the packages actually shipped, against OSV (`scripts/audit_runtime.py`).
- Semgrep.
- A Docker smoke test.
- Actions are pinned to commit SHAs.

## Changing the engine version
Change `engine/engine.lock.json` and `engine/verify_engine.py` only together with the Trace.Direct backend repository (`tools/dtax_engine/`). The two copies must stay identical. Re-pinning is described in the backend's `docs/DTAX_ENGINE.md`.
