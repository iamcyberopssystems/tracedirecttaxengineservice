"use strict";
/**
 * Trace.Direct tax engine service.
 *
 * Private HTTP service around the unmodified dTax tax engine. Only the
 * Trace.Direct backend calls it, over a private network, with a shared secret.
 * Request and response bodies are never logged.
 *
 *   GET  /healthz         liveness, engine pin (no auth)
 *   GET  /source          where to get the source of this service and the engine (AGPL s.13; no auth)
 *   POST /v1/calculate    cost basis, gains, optional Form 8949 data (bearer token)
 *   POST /v1/parse        detect and parse an exchange CSV with the engine's parsers (bearer token)
 *
 * Runs in UTC only: the engine reads Binance, Kraken and Gemini times in the
 * process's local zone, so any other zone would shift every trade.
 */
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const { validateCalculate, validateParse, ValidationError } = require("./validate");
const engine = require("./engine");

const MAX_BODY = 10 * 1024 * 1024;
const LOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "engine", "engine.lock.json"), "utf8"));
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const BUILD_FILE = path.join(engine.ENGINE_DIR, "..", "engine-build.json");
const BUILD = fs.existsSync(BUILD_FILE) ? JSON.parse(fs.readFileSync(BUILD_FILE, "utf8")) : null;
const SOURCE = {
  service: { name: PKG.name, version: PKG.version, license: "AGPL-3.0-only", repository: PKG.repository.url },
  engine: { name: "@dtax/tax-engine", license: "AGPL-3.0", repository: LOCK.repository, commit: LOCK.commit,
    manifestSha256: LOCK.manifest_sha256, modified: false, build: BUILD },
};

const sha = (s) => crypto.createHash("sha256").update(s).digest();

function tokenMatches(header, expectedDigest) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return crypto.timingSafeEqual(sha(header.slice(7)), expectedDigest);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > MAX_BODY) return reject(Object.assign(new Error("too large"), { status: 413 }));
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function assertUtc() {
  // Both a January and a July date, so a zone with summer time can't pass.
  const offsets = [new Date(2025, 0, 15).getTimezoneOffset(), new Date(2025, 6, 15).getTimezoneOffset()];
  if (offsets.some((o) => o !== 0)) {
    throw new Error("the service must run with TZ=UTC: exchange times would be shifted otherwise");
  }
}

function createServer({ token, log = (line) => process.stdout.write(`${line}\n`) }) {
  assertUtc();
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("ENGINE_SERVICE_TOKEN must be set to at least 32 characters");
  }
  const expected = sha(token);
  engine.load(); // fail at start, not on the first request, if the engine is not built

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const route = `${req.method} ${(req.url || "").split("?")[0]}`;
    res.on("finish", () => log(JSON.stringify({ route, status: res.statusCode, ms: Date.now() - started })));
    try {
      if (route === "GET /healthz") return send(res, 200, { status: "ok", engineCommit: LOCK.commit });
      if (route === "GET /source") return send(res, 200, SOURCE);
      if (route !== "POST /v1/calculate" && route !== "POST /v1/parse") return send(res, 404, { error: "not found" });
      if (!tokenMatches(req.headers.authorization, expected)) return send(res, 401, { error: "unauthorized" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
        return send(res, 415, { error: "content-type must be application/json" });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.status === 413) return send(res, 413, { error: "request body too large" });
        return send(res, 400, { error: "body is not valid JSON" });
      }
      if (route === "POST /v1/parse") {
        const parseInput = validateParse(body);
        try {
          return send(res, 200, engine.parse(parseInput));
        } catch (err) {
          return send(res, 422, { error: "the file could not be parsed" });
        }
      }
      const input = validateCalculate(body);
      let out;
      try {
        out = engine.calculate(input);
      } catch (err) {
        // Engine refusals (e.g. events out of order) name ids only, never values.
        return send(res, 422, { error: "engine rejected the input", detail: String(err.message).slice(0, 300) });
      }
      return send(res, 200, out);
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: "invalid request", detail: err.message });
      log(JSON.stringify({ route, error: "internal" }));
      return send(res, 500, { error: "internal error" });
    }
  });
}

if (require.main === module) {
  const server = createServer({ token: process.env.ENGINE_SERVICE_TOKEN });
  const port = Number(process.env.PORT || 8080);
  server.requestTimeout = 60000;
  server.listen(port, process.env.HOST || "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ listening: port, engineCommit: LOCK.commit })}\n`);
  });
}

module.exports = { assertUtc, createServer, SOURCE };
