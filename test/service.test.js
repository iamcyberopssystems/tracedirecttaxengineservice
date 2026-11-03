"use strict";
/**
 * Service tests. They need the engine built first (scripts/build-engine.sh).
 *
 * The transparency tests call the engine directly with the same input and
 * require the service to return exactly the engine's numbers: the wrapper
 * converts formats and adds no tax logic.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("../src/server");
const engine = require("../src/engine");

const TOKEN = "t".repeat(40);
let server;
let base;
const logs = [];

test.before(async () => {
  server = createServer({ token: TOKEN, log: (l) => logs.push(l) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function post(body, { token = TOKEN, type = "application/json", raw } = {}) {
  const headers = { "content-type": type };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/v1/calculate`, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
}

const lot = (id, amount, cost, at, src = "W1", assetSym = "BTC") =>
  ({ id, asset: assetSym, amount, costBasisUsd: cost, acquiredAt: at, sourceId: src });
const sale = (id, amount, proceeds, at, src = "W1") =>
  ({ id, asset: "BTC", amount, proceedsUsd: proceeds, date: at, sourceId: src });

const BASIC = {
  method: "FIFO",
  lots: [lot("L1", 1, 10000, "2023-01-01T00:00:00Z"), lot("L2", 1, 30000, "2024-03-01T00:00:00Z")],
  events: [sale("S1", 1.5, 45000, "2024-06-01T00:00:00Z")],
};

// --- auth and transport ----------------------------------------------------

test("refuses to start without a strong token", () => {
  assert.throws(() => createServer({ token: undefined }), /ENGINE_SERVICE_TOKEN/);
  assert.throws(() => createServer({ token: "short" }), /ENGINE_SERVICE_TOKEN/);
});

test("calculate needs the bearer token", async () => {
  assert.equal((await post(BASIC, { token: null })).status, 401);
  assert.equal((await post(BASIC, { token: "x".repeat(40) })).status, 401);
  assert.equal((await post(BASIC, { token: `${TOKEN}x` })).status, 401);
  assert.equal((await post(BASIC)).status, 200);
});

test("healthz and source need no token and name the pinned engine", async () => {
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.status, "ok");
  assert.match(h.engineCommit, /^[0-9a-f]{40}$/);
  const s = await (await fetch(`${base}/source`)).json();
  assert.equal(s.service.license, "AGPL-3.0-only");
  assert.equal(s.engine.commit, h.engineCommit);
  assert.equal(s.engine.modified, false);
  // build record written by scripts/build-engine.sh
  assert.equal(s.engine.build.commit, h.engineCommit);
  assert.match(s.engine.build.distIndexSha256, /^[0-9a-f]{64}$/);
});

test("unknown routes are 404, wrong content type 415, bad JSON 400, huge body 413", async () => {
  assert.equal((await fetch(`${base}/v1/other`, { method: "POST" })).status, 404);
  assert.equal((await post(BASIC, { type: "text/plain" })).status, 415);
  assert.equal((await post(null, { raw: "{not json" })).status, 400);
  assert.equal((await post(null, { raw: `{"pad":"${"a".repeat(11 * 1024 * 1024)}"}` })).status, 413);
});

test("request bodies and results are never logged", async () => {
  logs.length = 0;
  await post(BASIC);
  const all = logs.join("\n");
  assert.ok(logs.length > 0);
  for (const secret of ["45000", "L1", "W1", "BTC", TOKEN]) assert.ok(!all.includes(secret), secret);
});

// --- validation --------------------------------------------------------------

test("strict validation refuses unknown fields, bad values and duplicate ids", async () => {
  const bad = [
    { ...BASIC, method: "SPECIFIC_ID" },
    { ...BASIC, customerName: "Jane Example" },
    { ...BASIC, lots: [{ ...BASIC.lots[0], ssn: "123" }] },
    { ...BASIC, lots: [{ ...BASIC.lots[0], amount: -1 }] },
    { ...BASIC, lots: [{ ...BASIC.lots[0], amount: "1" }] },
    { ...BASIC, lots: [{ ...BASIC.lots[0], acquiredAt: "2024-02-30T00:00:00Z" }] },
    { ...BASIC, lots: [{ ...BASIC.lots[0], acquiredAt: "2024-01-01" }] },
    { ...BASIC, lots: [{ ...BASIC.lots[0], id: "L1~tX" }] },
    { ...BASIC, lots: [BASIC.lots[0], BASIC.lots[0]] },
    { ...BASIC, strictSilo: "yes" },
    { ...BASIC, form8949: { taxYear: "2024" } },
    { ...BASIC, consumptionEvents: [BASIC.events[0]] },
  ];
  for (const body of bad) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120));
    assert.equal((await r.json()).error, "invalid request");
  }
});

// --- transparency: service output equals the engine's own output -------------

function direct(method, strictSilo, lots, events, transfers = []) {
  const e = engine.load();
  const c = new e.CostBasisCalculator(method);
  c.addLots(lots.map((l) => ({ ...l, acquiredAt: new Date(l.acquiredAt) })));
  if (transfers.length) c.registerTransfers(transfers.map((t) => ({ ...t, date: new Date(t.date) })));
  return events.map((ev) => c.calculate({ ...ev, date: new Date(ev.date) }, strictSilo));
}

for (const method of ["FIFO", "LIFO", "HIFO", "IN_VDA"]) {
  test(`${method}: service returns exactly the engine's result`, async () => {
    const lots = [
      lot("A", 0.5, 20000, "2022-01-05T10:00:00Z"),
      lot("B", 0.3, 9000, "2022-06-01T10:00:00Z"),
      lot("C", 0.7, 42000, "2023-11-20T10:00:00Z"),
    ];
    const events = [sale("S1", 0.6, 15000, "2023-12-01T00:00:00Z"), sale("S2", 0.4, 30000, "2024-05-01T00:00:00Z")];
    const r = await post({ method, strictSilo: false, lots, events });
    assert.equal(r.status, 200);
    const got = (await r.json()).results;
    const want = direct(method, false, lots, events);
    assert.equal(got.length, want.length);
    got.forEach((g, i) => {
      assert.equal(g.gainLoss, want[i].gainLoss);
      assert.equal(g.holdingPeriod, want[i].holdingPeriod);
      assert.equal(g.method, want[i].method);
      assert.deepEqual(g.matchedLots.map((m) => [m.lotId, m.amountConsumed, m.costBasisUsd]),
        want[i].matchedLots.map((m) => [m.lotId, m.amountConsumed, m.costBasisUsd]));
    });
  });
}

test("IN_VDA: a loss is reported as zero (engine's s.115BBH rule), FIFO shows the loss", async () => {
  const lots = [lot("A", 1, 50000, "2023-01-01T00:00:00Z")];
  const events = [sale("S1", 1, 20000, "2024-01-01T00:00:00Z")];
  const vda = (await (await post({ method: "IN_VDA", lots, events })).json()).results[0];
  const fifo = (await (await post({ method: "FIFO", lots, events })).json()).results[0];
  assert.equal(vda.gainLoss, 0);
  assert.equal(fifo.gainLoss, -30000);
});

test("wallet-by-wallet is the default; a transfer carries basis and date", async () => {
  const lots = [lot("L1", 1, 10000, "2023-01-01T00:00:00Z", "EXCH")];
  const transfers = [{ id: "T1", asset: "BTC", amount: 1, date: "2023-02-01T00:00:00Z", fromSourceId: "EXCH", toSourceId: "SELF" }];
  const events = [sale("S1", 1, 25000, "2024-03-01T00:00:00Z", "SELF")];
  const out = await (await post({ method: "FIFO", lots, events, transfers, form8949: { taxYear: 2024 } })).json();
  assert.equal(out.strictSilo, true);
  const r = out.results[0];
  assert.equal(r.unmatchedAmount, 0);
  assert.equal(r.gainLoss, 15000);
  assert.equal(r.holdingPeriod, "LONG_TERM");
  assert.equal(r.matchedLots[0].baseLotId, "L1");
  // Form 8949 column (b) shows the date the coin was bought, not "VARIOUS"
  assert.equal(out.form8949.report.lines[0].dateAcquired, "01/01/2023");
  assert.equal(out.form8949.report.lines[0].box, "F");
  assert.match(out.form8949.csv, /^Box,Description of Property/);
});

test("wallet-by-wallet: coins with no funded lot in that wallet are flagged unmatched", async () => {
  const lots = [lot("L1", 1, 10000, "2023-01-01T00:00:00Z", "EXCH")];
  const events = [sale("S1", 0.4, 12000, "2024-03-01T00:00:00Z", "OTHER")];
  const r = (await (await post({ method: "FIFO", lots, events })).json()).results[0];
  assert.equal(r.unmatchedAmount, 0.4);
  const pooled = (await (await post({ method: "FIFO", strictSilo: false, lots, events })).json()).results[0];
  assert.equal(pooled.unmatchedAmount, 0);
});

test("disposals are calculated in date order whatever the request order", async () => {
  const lots = [lot("A", 1, 100, "2023-01-01T00:00:00Z"), lot("B", 1, 900, "2023-02-01T00:00:00Z")];
  const events = [sale("LATE", 1, 1000, "2024-02-01T00:00:00Z"), sale("EARLY", 1, 1000, "2024-01-01T00:00:00Z")];
  const res = (await (await post({ method: "FIFO", lots, events })).json()).results;
  assert.deepEqual(res.map((r) => [r.eventId, r.matchedLots[0].lotId]), [["EARLY", "A"], ["LATE", "B"]]);
});
