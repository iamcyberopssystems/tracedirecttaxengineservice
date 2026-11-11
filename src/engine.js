"use strict";
/**
 * Thin adapter over the unmodified dTax tax engine.
 *
 * Uses only the engine's public exports (CostBasisCalculator, baseLotId,
 * generateForm8949, form8949ToCsv, detectCsvFormat, parseCsv). It converts JSON to the engine's input
 * types and the engine's results back to JSON. It never registers custom
 * strategies, never changes engine objects, and adds no tax logic.
 */
const path = require("node:path");

const ENGINE_DIR = process.env.DTAX_ENGINE_DIR || path.join(__dirname, "..", "build", "engine");

let engine;
function load() {
  if (!engine) {
    // eslint-disable-next-line global-require
    engine = require(path.join(ENGINE_DIR, "packages", "tax-engine", "dist", "index.js"));
  }
  return engine;
}

const toDate = (iso) => new Date(iso);

function lotIn(l) {
  return { id: l.id, asset: l.asset, amount: l.amount, costBasisUsd: l.costBasisUsd,
    acquiredAt: toDate(l.acquiredAt), sourceId: l.sourceId };
}

function eventIn(e) {
  const out = { id: e.id, asset: e.asset, amount: e.amount, proceedsUsd: e.proceedsUsd,
    date: toDate(e.date), sourceId: e.sourceId };
  if (e.feeUsd !== undefined) out.feeUsd = e.feeUsd;
  return out;
}

function transferIn(t) {
  const out = { id: t.id, asset: t.asset, amount: t.amount, date: toDate(t.date),
    fromSourceId: t.fromSourceId, toSourceId: t.toSourceId };
  if (t.feeAmount !== undefined) out.feeAmount = t.feeAmount;
  return out;
}

function resultOut(r) {
  return {
    eventId: r.event.id,
    asset: r.event.asset,
    amount: r.event.amount,
    proceedsUsd: r.event.proceedsUsd,
    date: r.event.date.toISOString(),
    sourceId: r.event.sourceId,
    gainLoss: r.gainLoss,
    holdingPeriod: r.holdingPeriod,
    method: r.method,
    unmatchedAmount: r.unmatchedAmount ?? 0,
    matchedLots: r.matchedLots.map((m) => ({
      lotId: m.lotId,
      baseLotId: load().baseLotId(m.lotId),
      amountConsumed: m.amountConsumed,
      costBasisUsd: m.costBasisUsd,
      fullyConsumed: m.fullyConsumed,
    })),
  };
}

/**
 * Run one calculation. `req` has already passed validate.js.
 * Disposals are calculated in date order (ties keep request order).
 */
function calculate(req) {
  const e = load();
  const calc = new e.CostBasisCalculator(req.method);
  const lots = req.lots.map(lotIn);
  calc.addLots(lots);
  if (req.transfers.length) calc.registerTransfers(req.transfers.map(transferIn));
  if (req.consumptionEvents.length) calc.registerConsumptionEvents(req.consumptionEvents.map(eventIn));

  const events = req.events.map(eventIn)
    .map((ev, i) => [ev, i])
    .sort((a, b) => a[0].date.getTime() - b[0].date.getTime() || a[1] - b[1])
    .map(([ev]) => ev);
  const results = events.map((ev) => calc.calculate(ev, req.strictSilo));

  const out = {
    method: req.method,
    strictSilo: req.strictSilo,
    results: results.map(resultOut),
    remainingLots: calc.getLots().map((l) => ({
      id: l.id, asset: l.asset, amount: l.amount, costBasisUsd: l.costBasisUsd,
      acquiredAt: l.acquiredAt.toISOString(), sourceId: l.sourceId,
    })),
  };

  if (req.form8949) {
    // Form 8949 column (b): the engine looks dates up by matched lot id; a lot
    // moved between wallets has a derived id, so map it to the date of the lot
    // as bought (engine's own baseLotId).
    const acquired = new Map(lots.map((l) => [l.id, l.acquiredAt]));
    const lotDates = new Map();
    for (const r of results) {
      for (const m of r.matchedLots) {
        const d = acquired.get(e.baseLotId(m.lotId));
        if (d) lotDates.set(m.lotId, d);
      }
    }
    const report = e.generateForm8949(results, {
      taxYear: req.form8949.taxYear,
      reportingBasis: req.form8949.reportingBasis,
      lotDates,
    });
    out.form8949 = { report, csv: e.form8949ToCsv(report) };
  }
  return out;
}

// Fields of a parsed row passed back. `notes` (free text) is dropped: it can
// hold names or addresses, and nothing downstream needs it.
const TX_FIELDS = ["type", "timestamp", "receivedAsset", "receivedAmount", "receivedValueUsd", "sentAsset",
  "sentAmount", "sentValueUsd", "feeAsset", "feeAmount", "feeValueUsd", "source", "chain"];

/**
 * Detect the format and parse an exchange CSV with the engine's own parsers.
 * Row errors carry the row number and the engine's message only, never the
 * raw row (it can hold wallet addresses or names).
 */
function parse(req) {
  const e = load();
  const detected = e.detectCsvFormat(req.csv);
  const result = e.parseCsv(req.csv, req.format ? { format: req.format } : undefined);
  const transactions = result.transactions.map((tx) => {
    const out = {};
    for (const k of TX_FIELDS) if (tx[k] !== undefined && tx[k] !== null && tx[k] !== "") out[k] = tx[k];
    return out;
  });
  return {
    detectedFormat: detected,
    format: result.summary.format,
    summary: { totalRows: result.summary.totalRows, parsed: result.summary.parsed, failed: result.summary.failed },
    transactions,
    errors: result.errors.map((err) => ({ row: err.row, message: String(err.message).slice(0, 200) })),
  };
}

module.exports = { calculate, parse, load, ENGINE_DIR };
