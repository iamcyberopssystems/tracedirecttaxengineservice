"use strict";
/**
 * POST /v1/parse: exchange CSVs through the engine's own parsers.
 *
 * Fixtures in test/fixtures/csv are fictional files in each exchange's export
 * layout (generic, Coinbase, Binance, Kraken, Gemini: the formats verified for
 * Trace.Direct). The service must return exactly what the engine parses, minus
 * free-text notes and raw rows, and must run in UTC: the engine reads
 * Binance, Kraken and Gemini times in the process's local zone.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createServer } = require("../src/server");
const engine = require("../src/engine");

const TOKEN = "p".repeat(40);
const FIX = path.join(__dirname, "fixtures", "csv");
const read = (name) => fs.readFileSync(path.join(FIX, `${name}.csv`), "utf8");
let server;
let base;

test.before(async () => {
  server = createServer({ token: TOKEN, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function parse(body, { token = TOKEN } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/v1/parse`, { method: "POST", headers, body: JSON.stringify(body) });
}

// Expected first and second row of each fixture, times in UTC.
const EXPECTED = {
  generic: [["BUY", "2025-01-20T00:00:00.000Z", "SOL", 100], ["SELL", "2025-07-20T00:00:00.000Z", "SOL", 50]],
  coinbase: [["BUY", "2025-01-05T14:00:00.000Z", "BTC", 0.5], ["SELL", "2025-03-10T09:30:00.000Z", "BTC", 0.2]],
  binance: [["BUY", "2025-02-01T10:00:00.000Z", "ETH", 2], ["SELL", "2025-04-01T11:00:00.000Z", "ETH", 1]],
  kraken: [["BUY", "2025-01-10T08:00:00.000Z", "BTC", 1], ["SELL", "2025-05-10T08:00:00.000Z", "BTC", 0.4]],
  gemini: [["BUY", "2025-01-15T12:00:00.000Z", "BTC", 1], ["SELL", "2025-06-15T12:00:00.000Z", "BTC", 0.5]],
};

test("parse needs the bearer token", async () => {
  assert.equal((await parse({ csv: read("generic") }, { token: null })).status, 401);
  assert.equal((await parse({ csv: read("generic") }, { token: "x".repeat(40) })).status, 401);
});

for (const [name, rows] of Object.entries(EXPECTED)) {
  test(`${name}: detected, every row parsed, times in UTC`, async () => {
    const res = await parse({ csv: read(name) });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.detectedFormat, name);
    assert.equal(out.format, name);
    assert.equal(out.summary.failed, 0);
    assert.equal(out.transactions.length, 2);
    out.transactions.forEach((tx, i) => {
      const [type, ts, crypto, amount] = rows[i];
      assert.equal(tx.type, type);
      assert.equal(tx.timestamp, ts);
      const asset = type === "BUY" ? tx.receivedAsset : tx.sentAsset;
      const qty = type === "BUY" ? tx.receivedAmount : tx.sentAmount;
      assert.equal(asset, crypto);
      assert.equal(qty, amount);
    });
  });

  test(`${name}: same numbers as the engine called directly`, async () => {
    const out = await (await parse({ csv: read(name) })).json();
    const direct = engine.load().parseCsv(read(name));
    assert.equal(out.transactions.length, direct.transactions.length);
    out.transactions.forEach((tx, i) => {
      for (const [k, v] of Object.entries(tx)) assert.deepEqual(v, direct.transactions[i][k], `${name} row ${i} ${k}`);
    });
  });
}

test("free-text notes are not passed back", async () => {
  const out = await (await parse({ csv: read("coinbase") })).json();
  assert.ok(read("coinbase").includes("Bought 0.5 BTC"));
  assert.ok(!JSON.stringify(out).includes("Bought 0.5 BTC"));
  assert.ok(out.transactions.every((t) => !("notes" in t)));
});

test("row errors name the row, never the raw row", async () => {
  const address = "bc1qsecretaddressdonotechoxx0000000000000";
  const csv = `${read("coinbase").trim()}\nnot-a-date,Buy,BTC,${address},USD,1,1,1,0,\n`;
  const out = await (await parse({ csv })).json();
  assert.equal(out.summary.failed, 1);
  assert.equal(out.errors[0].row > 0, true);
  assert.ok(!JSON.stringify(out).includes(address));
  assert.ok(out.errors.every((e) => Object.keys(e).sort().join() === "message,row"));
});

test("format can be named; unknown formats and fields are refused", async () => {
  const named = await (await parse({ csv: read("kraken"), format: "kraken" })).json();
  assert.equal(named.format, "kraken");
  assert.equal((await parse({ csv: read("kraken"), format: "myexchange" })).status, 400);
  assert.equal((await parse({ csv: read("kraken"), extra: 1 })).status, 400);
  assert.equal((await parse({ csv: "   " })).status, 400);
  assert.equal((await parse({ csv: 42 })).status, 400);
});

test("refuses to start outside UTC", () => {
  const script = `require(${JSON.stringify(path.join(__dirname, "..", "src", "server"))}).createServer({ token: "${TOKEN}" })`;
  for (const tz of ["America/Chicago", "Asia/Kolkata", "Europe/London"]) {
    assert.throws(() => execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, stdio: "pipe" }),
      /TZ=UTC/, tz);
  }
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: "UTC" }, stdio: "pipe" });
});
