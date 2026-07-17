/* RNGD Look-Ahead — shared board state on Netlify Blobs.
   One JSON envelope { rev, savedAt, device, deviceName, state } under key "board-v1".
   Access is open unless the BOARD_KEY env var is set, in which case every
   request must carry the same value in the x-board-key header.

   CONCURRENCY: writes are rev-guarded (optimistic concurrency). A PUT must carry
   `baseRev` — the rev of the envelope the client last saw. If it doesn't match the
   stored rev (or is missing while state exists), the PUT is rejected with 409 + the
   current envelope, and the client adopts it. Wall-clock savedAt is DISPLAY ONLY —
   it decides nothing, so a tab that slept for a day can never overwrite fresh work
   just because its clock says "now".

   HISTORY: a 7-slot weekday ring (board-bk-0..6, Mon..Sun of the outgoing state's
   date). On the first accepted PUT of a new calendar day, the envelope being
   replaced is snapshotted into its weekday's slot — an off-device restore point
   that survives any client-side mistake. GET ?backup=list / ?backup=<0-6> serves it.

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

const dayOf = (ms) => new Date(+ms || 0).toISOString().slice(0, 10);
const dowOf = (ms) => (new Date(+ms || 0).getUTCDay() + 6) % 7; // 0 = Monday

export default async (req) => {
  const requiredKey = process.env.BOARD_KEY;
  if (requiredKey && req.headers.get("x-board-key") !== requiredKey)
    return respond(401, { error: "unauthorized" });

  const store = getStore({ name: "lookahead", consistency: "strong" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const bk = url.searchParams.get("backup");
    if (bk != null) {
      if (bk === "list") {
        const out = [];
        for (let d = 0; d < 7; d++) {
          const env = await store.get("board-bk-" + d, { type: "json" });
          if (env) out.push({ slot: d, savedAt: env.savedAt, device: env.device, deviceName: env.deviceName || "" });
        }
        return respond(200, { backups: out });
      }
      const d = +bk;
      if (!(d >= 0 && d <= 6)) return respond(400, { error: "bad slot" });
      const env = await store.get("board-bk-" + d, { type: "json" });
      return env ? respond(200, env) : respond(204, null);
    }
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
    const { state, savedAt, device, deviceName, baseRev } = body || {};
    if (!state || typeof state !== "object" || !(state.tasks || state.crews))
      return respond(400, { error: "bad state" });
    const cur = await store.get(KEY, { type: "json" });
    // Rev guard: the write must be based on the CURRENT stored envelope. A stale or
    // missing baseRev means this client hasn't seen the latest board — hand the
    // current copy back (409) so it adopts it instead of overwriting it. savedAt
    // plays no part in the decision.
    if (cur && baseRev !== cur.rev)
      return respond(409, cur, { etag: `"${cur.rev}"` });
    // Daily off-device snapshot: first accepted write of a NEW calendar day freezes
    // the outgoing envelope into its weekday slot (self-pruning 7-day ring).
    if (cur && dayOf(cur.savedAt) !== dayOf(Date.now())) {
      try { await store.setJSON("board-bk-" + dowOf(cur.savedAt), cur); } catch {}
    }
    const env = {
      rev: Date.now().toString(36) + "-" + randomUUID().slice(0, 8),
      savedAt: +savedAt || Date.now(),
      device: String(device || "?").slice(0, 32),
      deviceName: String(deviceName || "").slice(0, 48),
      state,
    };
    await store.setJSON(KEY, env, { metadata: { savedAt: env.savedAt, device: env.device } });
    return respond(200, { rev: env.rev, savedAt: env.savedAt }, { etag: `"${env.rev}"` });
  }

  return respond(405, { error: "method not allowed" });
};

export const config = { path: "/api/state" };
