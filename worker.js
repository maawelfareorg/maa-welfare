// Maa Welfare Organization - submissions server (Cloudflare Worker).
// Stores what donors and help seekers submit (details + attachments) in Workers KV (binding SUBS).
// Serves the website files too (binding ASSETS). The admin reads submissions with a secret key (ADMIN_KEY).
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-admin-key",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-max-age": "86400"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: Object.assign({"content-type": "application/json", "cache-control": "no-store"}, CORS)});
const MAX_FILES = 8, MAX_FILE_B64 = 4300000, MAX_TOTAL_B64 = 16000000;
const OK_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/i;
const clean = (s, n = 300) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
const rnd = n => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(n)); return Array.from(b, x => a[x % a.length]).join(""); };
const ymd = () => new Date().toISOString().slice(2, 10).replace(/-/g, "");
async function sha(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function sameKey(a, b) { const x = await sha(a), y = await sha(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; }
async function limited(env, name, max, seconds) {
  const k = "rl:" + name + ":" + Math.floor(Date.now() / (seconds * 1000));
  const n = parseInt((await env.SUBS.get(k)) || "0", 10);
  if (n >= max) return true;
  await env.SUBS.put(k, String(n + 1), {expirationTtl: Math.max(60, seconds * 2)});
  return false;
}
async function isAdmin(req, env, ip) {
  if (!env.ADMIN_KEY) return {ok: false, why: "not_configured"};
  const bad = parseInt((await env.SUBS.get("rlbad:" + ip)) || "0", 10);
  if (bad >= 12) return {ok: false, why: "slow_down"};
  const k = req.headers.get("x-admin-key") || "";
  if (k && await sameKey(k.trim(), String(env.ADMIN_KEY).trim())) return {ok: true};
  await env.SUBS.put("rlbad:" + ip, String(bad + 1), {expirationTtl: 3600});
  return {ok: false, why: "bad_key"};
}
async function submit(req, env, ip) {
  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > 20000000) return json({ok: false, error: "Files are too large. Please send smaller photos."}, 413);
  if (await limited(env, "sub:" + ip, 10, 3600)) return json({ok: false, error: "Too many submissions from this connection. Please try again later."}, 429);
  let body; try { body = await req.json(); } catch (e) { return json({ok: false, error: "Bad request."}, 400); }
  const type = body && body.type, d = (body && body.data) || {};
  if (type !== "help" && type !== "donation") return json({ok: false, error: "Bad request."}, 400);
  if (clean(d.website)) return json({ok: true, ref: "OK-" + rnd(4)});
  const data = {};
  Object.keys(d).slice(0, 60).forEach(k => { if (/^[A-Za-z0-9_]{1,40}$/.test(k)) data[k] = clean(d[k], k === "details" || k === "note" ? 2000 : 300); });
  if (type === "help") { if (!data.name || !data.phone || !data.details || !(parseFloat(data.amount) > 0)) return json({ok: false, error: "Please fill in the name, phone, the need and the amount."}, 400); }
  else { if (!data.name || !data.contact || !(parseFloat(data.amount) > 0)) return json({ok: false, error: "Please fill in your name, a phone number or email, and the amount."}, 400); }
  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
  let total = 0; const meta = [];
  for (const f of files) {
    const b64 = String((f && f.data) || ""), t = clean(f && f.type, 60), nm = clean(f && f.name, 120) || "file";
    if (!b64 || b64.length > MAX_FILE_B64 || !OK_TYPES.test(t) || /[^A-Za-z0-9+\/=]/.test(b64)) return json({ok: false, error: "A file was not accepted. Use photos (JPG or PNG) or PDF files under 3 MB."}, 400);
    total += b64.length; if (total > MAX_TOTAL_B64) return json({ok: false, error: "The files together are too large."}, 413);
  }
  const id = String(9999999999999 - Date.now()).padStart(13, "0") + "-" + rnd(5), ref = (type === "help" ? "REQ-" : "DON-") + ymd() + "-" + rnd(4);
  let n = 0;
  for (const f of files) { await env.SUBS.put("f:" + id + ":" + n, f.data, {metadata: {name: clean(f.name, 120) || "file", type: clean(f.type, 60), label: clean(f.label, 80)}}); meta.push({n, name: clean(f.name, 120) || "file", type: clean(f.type, 60), label: clean(f.label, 80), size: Math.round(f.data.length * 0.75)}); n++; }
  await env.SUBS.put("s:" + id, JSON.stringify({id, type, ref, at: new Date().toISOString(), status: "new", data, files: meta}));
  return json({ok: true, ref, id});
}
async function list(env, status) {
  const out = []; let cursor;
  do {
    const r = await env.SUBS.list({prefix: "s:", cursor, limit: 100});
    for (const k of r.keys) { const v = await env.SUBS.get(k.name); if (v) { try { const o = JSON.parse(v); if (status === "all" || o.status === status) out.push(o); } catch (e) {} } if (out.length >= 300) break; }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && out.length < 300);
  return out;
}
async function admin(req, env, url, ip) {
  const a = await isAdmin(req, env, ip);
  if (!a.ok) return json({ok: false, error: a.why === "not_configured" ? "The server has no admin key yet. Add the secret ADMIN_KEY in Cloudflare." : a.why === "slow_down" ? "Too many tries. Please wait an hour." : "That key is not correct."}, a.why === "bad_key" ? 401 : a.why === "slow_down" ? 429 : 503);
  const p = url.pathname;
  if (p === "/api/admin/check") return json({ok: true});
  if (p === "/api/admin/list") return json({ok: true, items: await list(env, url.searchParams.get("status") || "new")});
  if (p === "/api/admin/file") {
    const id = clean(url.searchParams.get("id"), 40), n = parseInt(url.searchParams.get("n") || "0", 10);
    if (!/^[0-9]{13}-[A-Z0-9]{5}$/.test(id)) return json({ok: false}, 400);
    const r = await env.SUBS.getWithMetadata("f:" + id + ":" + n);
    if (!r.value) return json({ok: false, error: "No such file."}, 404);
    const bin = Uint8Array.from(atob(r.value), c => c.charCodeAt(0)), t = (r.metadata && r.metadata.type) || "application/octet-stream";
    return new Response(bin, {headers: Object.assign({"content-type": t, "content-disposition": "inline", "x-content-type-options": "nosniff", "cache-control": "private, no-store"}, CORS)});
  }
  if (req.method !== "POST") return json({ok: false}, 405);
  let b = {}; try { b = await req.json(); } catch (e) {}
  const id = clean(b.id, 40); if (!/^[0-9]{13}-[A-Z0-9]{5}$/.test(id)) return json({ok: false, error: "Bad id."}, 400);
  const raw = await env.SUBS.get("s:" + id); if (!raw) return json({ok: false, error: "Not found."}, 404);
  const o = JSON.parse(raw);
  if (p === "/api/admin/mark") { const st = clean(b.status, 20); if (!["new", "accepted", "imported", "declined"].includes(st)) return json({ok: false}, 400); o.status = st; o.note = clean(b.note, 500); o.doneAt = new Date().toISOString(); await env.SUBS.put("s:" + id, JSON.stringify(o)); return json({ok: true}); }
  if (p === "/api/admin/delete") { for (const f of o.files || []) await env.SUBS.delete("f:" + id + ":" + f.n); await env.SUBS.delete("s:" + id); return json({ok: true}); }
  return json({ok: false}, 404);
}
async function team(req, env, ip) {
  const a = await isAdmin(req, env, ip);
  if (!a.ok) return json({ok: false, error: a.why === "not_configured" ? "The server has no admin key yet. Add the secret ADMIN_KEY in Cloudflare." : a.why === "slow_down" ? "Too many tries. Please wait an hour." : "That server key is not correct."}, a.why === "bad_key" ? 401 : a.why === "slow_down" ? 429 : 503);
  const cur = JSON.parse((await env.SUBS.get("team:db")) || "null") || {rev: 0, store: null};
  if (req.method === "GET") return json({ok: true, rev: cur.rev, at: cur.at || null, store: cur.store});
  if (req.method === "PUT") {
    const len = parseInt(req.headers.get("content-length") || "0", 10);
    if (len > 20000000) return json({ok: false, error: "The records are too large to save (over 20 MB)."}, 413);
    let b; try { b = await req.json(); } catch (e) { return json({ok: false, error: "Bad request."}, 400); }
    if (!b || typeof b.store !== "object" || b.store === null) return json({ok: false, error: "Bad request."}, 400);
    if ((parseInt(b.base, 10) || 0) !== cur.rev) return json({ok: false, conflict: true, rev: cur.rev}, 409);
    const nx = {rev: cur.rev + 1, at: new Date().toISOString(), store: b.store};
    await env.SUBS.put("team:db", JSON.stringify(nx));
    return json({ok: true, rev: nx.rev});
  }
  return json({ok: false, error: "Not found."}, 404);
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", {status: 404});
    if (req.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS});
    if (!env.SUBS) return json({ok: false, error: "Storage is not connected yet."}, 503);
    const ip = req.headers.get("cf-connecting-ip") || "x";
    try {
      if (url.pathname === "/api/ping") return json({ok: true, v: 1, admin: !!env.ADMIN_KEY});
      if (url.pathname === "/api/team") return await team(req, env, ip);
      if (url.pathname === "/api/submit" && req.method === "POST") return await submit(req, env, ip);
      if (url.pathname.startsWith("/api/admin/")) return await admin(req, env, url, ip);
      return json({ok: false, error: "Not found."}, 404);
    } catch (e) { return json({ok: false, error: "Server error. Please try again."}, 500); }
  }
};
