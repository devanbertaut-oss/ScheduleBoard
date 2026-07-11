/* RNGD Look-Ahead — shared board state on Netlify Blobs.
   One JSON envelope { rev, savedAt, device, state } under key "board-v1".
   Access is open unless the BOARD_KEY env var is set, in which case every
   request must carry the same value in the x-board-key header.
   The rev is generated here and mirrored as the ETag, so the client never
   depends on Netlify Blobs' own etag shape (and a local dev stub can
   reproduce the contract exactly). */
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

const KEY = "board-v1";
const MAX_BYTES = 2_000_000;
// x-board:1 tells the client "this really is the sync endpoint" — a missing
// function (Netlify 404) or a service-worker page can never carry it.
const BASE = { "cache-control": "no-store", "x-board": "1" };

const respond = (status, body, extra = {}) =>
  new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...BASE,
      ...(body != null && { "content-type": "application/json" }),
      ...extra,
    },
  });

export default async (req) => {
  const requiredKey = process.env.BOARD_KEY;
  if (requiredKey && req.headers.get("x-board-key") !== requiredKey)
    return respond(401, { error: "unauthorized" });

  const store = getStore({ name: "lookahead", consistency: "strong" });

  if (req.method === "GET") {
    const env = await store.get(KEY, { type: "json" });
    if (!env) return respond(204, null);
    if (req.headers.get("if-none-match") === `"${env.rev}"`)
      return respond(304, null, { etag: `"${env.rev}"` });
    return respond(200, env, { etag: `"${env.rev}"` });
  }

  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_BYTES) return respond(413, { error: "too large" });
    let body;
    try { body = JSON.parse(text); } catch { return respond(400, { error: "bad json" }); }
    const { state, savedAt, device } = body || {};
    if (!state || typeof state !== "object" || !(state.tasks || state.crews))
      return respond(400, { error: "bad state" });
    const cur = await store.get(KEY, { type: "json" });
    // Stored copy is newer — hand it back so the stale client applies it.
    if (cur && +cur.savedAt > +savedAt)
      return respond(409, cur, { etag: `"${cur.rev}"` });
    const env = {
      rev: Date.now().toString(36) + "-" + randomUUID().slice(0, 8),
      savedAt: +savedAt || Date.now(),
      device: String(device || "?").slice(0, 32),
      state,
    };
    await store.setJSON(KEY, env, { metadata: { savedAt: env.savedAt, device: env.device } });
    return respond(200, { rev: env.rev, savedAt: env.savedAt }, { etag: `"${env.rev}"` });
  }

  return respond(405, { error: "method not allowed" });
};

export const config = { path: "/api/state" };
