#!/usr/bin/env node
/* Local dev/test server for ScheduleBoard.
   Serves the repo root statically AND emulates the Netlify Blobs sync function
   (/api/state) in-memory with the exact production contract, so sync can be
   exercised without a Netlify deploy:
     node tools/dev-server.mjs [--port 8888] [--no-api] [--latency ms]
     BOARD_KEY=secret node tools/dev-server.mjs   # exercise the 401/key flow
   --no-api answers /api/state with a plain 404 (no x-board header) to simulate
   non-Netlify hosting — the app must degrade to local-only. */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = +opt("--port", 8888);
const NO_API = flag("--no-api");
const LATENCY = +opt("--latency", 0);
const KEY = process.env.BOARD_KEY || "";

let envl = null; // in-memory blob envelope {rev, savedAt, device, state}
const MAX = 2_000_000;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".css": "text/css",
};

const api = async (req, res) => {
  const send = (code, body, extra = {}) => {
    const h = { "cache-control": "no-store", "x-board": "1", ...extra };
    if (body != null) h["content-type"] = "application/json";
    res.writeHead(code, h);
    res.end(body == null ? undefined : JSON.stringify(body));
  };
  if (KEY && req.headers["x-board-key"] !== KEY) return send(401, { error: "unauthorized" });
  if (req.method === "GET") {
    if (!envl) return send(204, null);
    if (req.headers["if-none-match"] === `"${envl.rev}"`) return send(304, null, { etag: `"${envl.rev}"` });
    return send(200, envl, { etag: `"${envl.rev}"` });
  }
  if (req.method === "PUT") {
    let text = "";
    for await (const c of req) { text += c; if (text.length > MAX + 1024) return send(413, { error: "too large" }); }
    if (text.length > MAX) return send(413, { error: "too large" });
    let body; try { body = JSON.parse(text); } catch { return send(400, { error: "bad json" }); }
    const { state, savedAt, device } = body || {};
    if (!state || typeof state !== "object" || !(state.tasks || state.crews)) return send(400, { error: "bad state" });
    if (envl && +envl.savedAt > +savedAt) return send(409, envl, { etag: `"${envl.rev}"` });
    envl = { rev: Date.now().toString(36) + "-" + randomUUID().slice(0, 8),
             savedAt: +savedAt || Date.now(), device: String(device || "?").slice(0, 32), state };
    return send(200, { rev: envl.rev, savedAt: envl.savedAt }, { etag: `"${envl.rev}"` });
  }
  return send(405, { error: "method not allowed" });
};

http.createServer(async (req, res) => {
  if (LATENCY) await new Promise(r => setTimeout(r, LATENCY));
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/state") {
    if (NO_API) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not Found"); }
    try { return await api(req, res); } catch (e) { res.writeHead(500); return res.end(); }
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  p = normalize(p).replace(/^([.][.][/\\])+/, "");
  try {
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(buf);
  } catch (e) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not Found"); }
}).listen(PORT, "127.0.0.1", () =>
  console.log(`dev-server http://127.0.0.1:${PORT} api=${!NO_API} key=${KEY ? "required" : "open"}`));
