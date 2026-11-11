"use strict";
/**
 * Strict request validation. Unknown fields are refused, so no personal data
 * (names, tax ids, addresses) can be sent by mistake: the request carries only
 * opaque ids, asset symbols, amounts, USD values and dates.
 */

const METHODS = new Set(["FIFO", "LIFO", "HIFO", "IN_VDA"]);
const REPORTING = new Set(["none", "all_reported"]);
const MAX_ITEMS = 50000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ASSET_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

class ValidationError extends Error {}

function fail(where, msg) {
  throw new ValidationError(`${where}: ${msg}`);
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function onlyKeys(obj, where, required, optional = []) {
  if (!isObject(obj)) fail(where, "must be an object");
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) fail(where, `unknown field "${k}"`);
  for (const k of required) if (!(k in obj)) fail(where, `missing field "${k}"`);
}

function id(v, where) {
  // "~" is excluded: the engine reserves "~t" for ids of lots moved between wallets.
  if (typeof v !== "string" || !ID_RE.test(v)) fail(where, "must be an id of 1-128 letters, digits or _.:-");
}

function asset(v, where) {
  if (typeof v !== "string" || !ASSET_RE.test(v)) fail(where, "must be an asset symbol");
}

function num(v, where, { positive = false, min } = {}) {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(where, "must be a finite number");
  if (positive && !(v > 0)) fail(where, "must be greater than 0");
  if (min !== undefined && v < min) fail(where, `must be at least ${min}`);
}

function date(v, where) {
  if (typeof v !== "string" || !ISO_RE.test(v) || Number.isNaN(Date.parse(v))) {
    fail(where, "must be a UTC ISO-8601 timestamp like 2024-01-31T12:00:00Z");
  }
  // Reject calendar overflow (e.g. 2024-02-30), which Date silently rolls over.
  if (new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19)) fail(where, "is not a real date");
}

function list(v, where, each) {
  if (!Array.isArray(v)) fail(where, "must be an array");
  if (v.length > MAX_ITEMS) fail(where, `has more than ${MAX_ITEMS} items`);
  const seen = new Set();
  v.forEach((item, i) => {
    each(item, `${where}[${i}]`);
    if (seen.has(item.id)) fail(`${where}[${i}].id`, `duplicate id "${item.id}"`);
    seen.add(item.id);
  });
}

function lot(l, w) {
  onlyKeys(l, w, ["id", "asset", "amount", "costBasisUsd", "acquiredAt", "sourceId"]);
  id(l.id, `${w}.id`);
  asset(l.asset, `${w}.asset`);
  num(l.amount, `${w}.amount`, { positive: true });
  num(l.costBasisUsd, `${w}.costBasisUsd`, { min: 0 });
  date(l.acquiredAt, `${w}.acquiredAt`);
  id(l.sourceId, `${w}.sourceId`);
}

function event(e, w) {
  onlyKeys(e, w, ["id", "asset", "amount", "proceedsUsd", "date", "sourceId"], ["feeUsd"]);
  id(e.id, `${w}.id`);
  asset(e.asset, `${w}.asset`);
  num(e.amount, `${w}.amount`, { positive: true });
  num(e.proceedsUsd, `${w}.proceedsUsd`, { min: 0 });
  date(e.date, `${w}.date`);
  id(e.sourceId, `${w}.sourceId`);
  if (e.feeUsd !== undefined) num(e.feeUsd, `${w}.feeUsd`, { min: 0 });
}

function transfer(t, w) {
  onlyKeys(t, w, ["id", "asset", "amount", "date", "fromSourceId", "toSourceId"], ["feeAmount"]);
  id(t.id, `${w}.id`);
  asset(t.asset, `${w}.asset`);
  num(t.amount, `${w}.amount`, { min: 0 });
  date(t.date, `${w}.date`);
  id(t.fromSourceId, `${w}.fromSourceId`);
  id(t.toSourceId, `${w}.toSourceId`);
  if (t.feeAmount !== undefined) num(t.feeAmount, `${w}.feeAmount`, { min: 0 });
}

/** Returns a normalised request or throws ValidationError. */
function validateCalculate(body) {
  onlyKeys(body, "request", ["method", "lots", "events"],
    ["strictSilo", "transfers", "consumptionEvents", "form8949"]);
  if (!METHODS.has(body.method)) fail("method", `must be one of ${[...METHODS].join(", ")}`);
  if (body.strictSilo !== undefined && typeof body.strictSilo !== "boolean") fail("strictSilo", "must be true or false");
  list(body.lots, "lots", lot);
  list(body.events, "events", event);
  const transfers = body.transfers ?? [];
  const consumptionEvents = body.consumptionEvents ?? [];
  list(transfers, "transfers", transfer);
  list(consumptionEvents, "consumptionEvents", event);
  const eventIds = new Set(body.events.map((e) => e.id));
  consumptionEvents.forEach((e, i) => {
    if (eventIds.has(e.id)) fail(`consumptionEvents[${i}].id`, `"${e.id}" is also a reported event`);
  });

  let form8949 = null;
  if (body.form8949 !== undefined) {
    onlyKeys(body.form8949, "form8949", ["taxYear"], ["reportingBasis"]);
    const y = body.form8949.taxYear;
    if (!Number.isInteger(y) || y < 2009 || y > 2100) fail("form8949.taxYear", "must be a year");
    const rb = body.form8949.reportingBasis ?? "none";
    if (!REPORTING.has(rb)) fail("form8949.reportingBasis", `must be one of ${[...REPORTING].join(", ")}`);
    form8949 = { taxYear: y, reportingBasis: rb };
  }

  return {
    method: body.method,
    // US default (Rev. Proc. 2024-28): wallet-by-wallet basis. Callers must opt out explicitly.
    strictSilo: body.strictSilo ?? true,
    lots: body.lots,
    events: body.events,
    transfers,
    consumptionEvents,
    form8949,
  };
}

// The engine's CsvFormat values (pinned engine). A caller may name one to skip detection.
const CSV_FORMATS = new Set(["generic", "coinbase", "binance", "binance_us", "kraken", "kraken_trades", "etherscan",
  "etherscan_erc20", "gemini", "crypto_com", "kucoin", "okx", "bybit", "gate", "bitget", "mexc", "htx", "solscan",
  "solscan_defi", "bitfinex", "poloniex", "koinly", "cointracker", "cryptact", "bitstamp", "upbit", "robinhood",
  "wazirx", "coindcx", "zebpay"]);
const MAX_CSV_CHARS = 8 * 1024 * 1024;

function validateParse(body) {
  onlyKeys(body, "request", ["csv"], ["format"]);
  if (typeof body.csv !== "string" || !body.csv.trim()) fail("csv", "must be non-empty text");
  if (body.csv.length > MAX_CSV_CHARS) fail("csv", "is too large");
  if (body.format !== undefined && !CSV_FORMATS.has(body.format)) fail("format", "is not a supported format");
  return { csv: body.csv, format: body.format };
}

module.exports = { validateCalculate, validateParse, ValidationError, METHODS, MAX_ITEMS, CSV_FORMATS };
