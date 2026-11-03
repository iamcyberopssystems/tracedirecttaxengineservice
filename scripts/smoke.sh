#!/usr/bin/env bash
# Smoke-test a running service: scripts/smoke.sh BASE_URL TOKEN
set -euo pipefail
BASE="$1"; TOKEN="$2"; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for _ in $(seq 1 30); do curl -fsS -o /dev/null "$BASE/healthz" && break; sleep 1; done
curl -fsS -o "$TMP/source.json" "$BASE/source"
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/calculate")" = 401
curl -fsS -o "$TMP/calc.json" -X POST "$BASE/v1/calculate" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"method":"FIFO","lots":[{"id":"L1","asset":"BTC","amount":1,"costBasisUsd":10000,"acquiredAt":"2023-01-01T00:00:00Z","sourceId":"W1"}],"events":[{"id":"S1","asset":"BTC","amount":1,"proceedsUsd":25000,"date":"2024-03-01T00:00:00Z","sourceId":"W1"}]}'
node -e '
const f=require("fs"); const s=JSON.parse(f.readFileSync(process.argv[1])); const c=JSON.parse(f.readFileSync(process.argv[2]));
if (s.engine.build.commit !== s.engine.commit) throw new Error("build record does not match pin");
if (c.results[0].gainLoss !== 15000) throw new Error("unexpected gain " + c.results[0].gainLoss);
console.log("smoke OK: engine", s.engine.commit, "dist", s.engine.build.distIndexSha256, "gain", c.results[0].gainLoss);
' "$TMP/source.json" "$TMP/calc.json"
