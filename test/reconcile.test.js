"use strict";
/**
 * POST /v1/reconcile: a Form 1099-DA CSV against our own sales, with the
 * engine's parse1099DA and reconcile (unmodified). Fixtures in
 * test/fixtures/1099da are fictional files in the Coinbase and generic layouts.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createServer } = require("../src/server");
const engine = require("../src/engine");

const TOKEN = "r".repeat(40);
const read = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "1099da", `${name}.csv`), "utf8");
let server;
let base;

test.before(async () => {
  server = createServer({ token: TOKEN, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function post(body, { token = TOKEN } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/v1/reconcile`, { method: "POST", headers, body: JSON.stringify(body) });
}

// Our sales (as the backend sends them): one per sale, not per lot.
const SALES = [
  { eventId: "E1", asset: "ETH", dateSold: "2025-04-01T00:00:00Z", proceeds: 3500, costBasis: 3000, gainLoss: 500 },
  { eventId: "E2", asset: "BTC", dateSold: "2025-06-01T00:00:00Z", proceeds: 49975, costBasis: 12525, gainLoss: 37450 },
  { eventId: "E3", asset: "BTC", dateSold: "2025-07-01T00:00:00Z", proceeds: 80000, costBasis: 46020, gainLoss: 33980 },
  { eventId: "E4", asset: "SOL", dateSold: "2025-09-01T00:00:00Z", proceeds: 400, costBasis: 0, gainLoss: 400 },
];
const byStatus = (out) => Object.fromEntries(out.items.map((i) => [i.broker ? `row${i.broker.row}` : i.eventId, i.status]));

test("reconcile needs the bearer token", async () => {
  assert.equal((await post({ csv: read("coinbase"), taxYear: 2025, dispositions: [] }, { token: null })).status, 401);
});

test("coinbase layout: matched, and a broker sale we do not have", async () => {
  const res = await post({ csv: read("coinbase"), taxYear: 2025, dispositions: SALES.slice(2, 3) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.parse, { entries: 2, errors: [] });
  assert.deepEqual(byStatus(out), { row2: "matched", row3: "missing_in_dtax" });
  const row2 = out.items.find((i) => i.broker && i.broker.row === 2);
  assert.equal(row2.eventId, "E3");
  assert.equal(row2.broker.asset, "BTC"); // "Bitcoin" -> BTC
  assert.equal(row2.broker.dateSold, "2025-07-01T00:00:00.000Z");
  assert.equal(row2.coverageStatus, "noncovered"); // no basis reported
  assert.equal(out.summary.basisMissingCount, 2);
});

test("generic layout: basis and proceeds differences, missing on both sides, row errors", async () => {
  const out = await (await post({ csv: read("generic"), taxYear: 2025, dispositions: SALES })).json();
  assert.deepEqual(out.parse.errors, [{ row: 5, message: "Invalid date: not-a-date" }]);
  assert.deepEqual(byStatus(out), {
    row2: "basis_mismatch", row3: "proceeds_mismatch", row4: "missing_in_dtax", E3: "missing_in_1099da",
    E4: "missing_in_1099da",
  });
  const eth = out.items.find((i) => i.status === "basis_mismatch");
  assert.equal(eth.costBasisDiff, -100);
  const btc = out.items.find((i) => i.status === "proceeds_mismatch");
  assert.equal(btc.eventId, "E2"); // a day apart, within 5%: the engine's fuzzy match
  assert.equal(btc.proceedsDiff, -975);
});

test("same answer as the engine called directly", async () => {
  const out = await (await post({ csv: read("generic"), taxYear: 2025, dispositions: SALES })).json();
  const e = engine.load();
  const direct = e.reconcile(e.parse1099DA(read("generic"), "broker", 2025).entries,
    SALES.map((s) => ({ ...s, dateSold: new Date(s.dateSold) })), { taxYear: 2025, brokerName: "broker" });
  assert.equal(out.items.length, direct.items.length);
  out.items.forEach((it, i) => {
    assert.equal(it.status, direct.items[i].status);
    assert.ok(it.proceedsDiff === direct.items[i].proceedsDiff); // === : JSON has no -0
    assert.ok(it.costBasisDiff === direct.items[i].costBasisDiff);
  });
  assert.equal(out.summary.netProceedsDiff, direct.summary.netProceedsDiff);
});

test("broker transaction ids, suggestions and the tax guess are not passed back", async () => {
  const out = await (await post({ csv: read("coinbase"), taxYear: 2025, dispositions: SALES })).json();
  const text = JSON.stringify(out);
  for (const s of ["cb-tx-0001", "transactionId", "rebuttal", "estimatedTaxOverpayment", "brokerName", "DTax"]) {
    assert.ok(!text.includes(s), s);
  }
});

test("bad requests are refused", async () => {
  const ok = { csv: read("coinbase"), taxYear: 2025, dispositions: [] };
  assert.equal((await post({ ...ok, extra: 1 })).status, 400);
  assert.equal((await post({ ...ok, csv: " " })).status, 400);
  assert.equal((await post({ ...ok, taxYear: "2025" })).status, 400);
  assert.equal((await post({ ...ok, dispositions: [{ ...SALES[0], name: "x" }] })).status, 400);
  assert.equal((await post({ ...ok, dispositions: [SALES[0], SALES[0]] })).status, 400);
  assert.equal((await post({ ...ok, dispositions: [{ ...SALES[0], dateSold: "2025-04-01" }] })).status, 400);
  assert.equal((await post({ ...ok, csv: "x".repeat(2 * 1024 * 1024 + 1) })).status, 400);
});

test("an empty file gives a row error, not a crash", async () => {
  const out = await (await post({ csv: "asset,date_sold,gross_proceeds\n", taxYear: 2025, dispositions: [] })).json();
  assert.equal(out.parse.entries, 0);
  assert.equal(out.parse.errors.length, 1);
});
