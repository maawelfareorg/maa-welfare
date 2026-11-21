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
const adminFail = a => json({ok: false, error: a.why === "not_configured" ? "The server has no admin key yet. Add the secret ADMIN_KEY in Cloudflare." : a.why === "slow_down" ? "Too many tries. Please wait an hour." : "That server key is not correct."}, a.why === "bad_key" ? 401 : a.why === "slow_down" ? 429 : 503);
const getJ = async (env, k, d) => { const v = await env.SUBS.get(k); if (!v) return d; try { return JSON.parse(v) || d; } catch (e) { return d; } };
const splitPath = p => { const i = String(p).indexOf("/"); return i < 1 ? null : [p.slice(0, i), p.slice(i + 1)]; };
async function metaOf(env) {
  let m = await getJ(env, "team:meta", null);
  if (m) return m;
  m = {rev: 0, cols: {}};
  const old = await getJ(env, "team:db", null);
  if (old && old.store) {
    const g = {};
    Object.keys(old.store).forEach(p => { const sp = splitPath(p); if (sp) (g[sp[0]] = g[sp[0]] || {})[sp[1]] = old.store[p]; });
    m.rev = old.rev || 1;
    for (const c of Object.keys(g)) { await env.SUBS.put("team:col:" + c, JSON.stringify({docs: g[c]})); m.cols[c] = m.rev; }
    await env.SUBS.put("team:meta", JSON.stringify(m));
  }
  return m;
}
async function team(req, env, ip, url) {
  const a = await isAdmin(req, env, ip); if (!a.ok) return adminFail(a);
  const path = url.pathname;
  if (path === "/api/team/sync" && req.method === "GET") {
    const m = await metaOf(env); let since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
    if (m.reset && since < m.reset) since = 0;
    const out = {};
    for (const c of Object.keys(m.cols)) if (m.cols[c] > since) { const v = await getJ(env, "team:col:" + c, {docs: {}}); out[c] = {rev: m.cols[c], docs: v.docs || {}}; }
    return json({ok: true, rev: m.rev, reset: m.reset || 0, cols: out});
  }
  if (path === "/api/team/ops" && req.method === "POST") {
    const len = parseInt(req.headers.get("content-length") || "0", 10);
    if (len > 20000000) return json({ok: false, error: "That save is too large (over 20 MB)."}, 413);
    let b; try { b = await req.json(); } catch (e) { return json({ok: false, error: "Bad request."}, 400); }
    const ops = Array.isArray(b && b.ops) ? b.ops : []; if (!ops.length) return json({ok: false, error: "Nothing to save."}, 400);
    const g = {};
    for (const o of ops) { const sp = o && splitPath(String(o.p || "")); if (!sp || String(o.p).length > 220 || (o.d !== null && (typeof o.d !== "object" || Array.isArray(o.d)))) return json({ok: false, error: "Bad request."}, 400); (g[sp[0]] = g[sp[0]] || []).push([sp[1], o.d]); }
    const m = await metaOf(env), nr = m.rev + 1;
    for (const c of Object.keys(g)) {
      const v = await getJ(env, "team:col:" + c, {docs: {}}); v.docs = v.docs || {};
      g[c].forEach(([id, d]) => { if (d === null) delete v.docs[id]; else v.docs[id] = d; });
      await env.SUBS.put("team:col:" + c, JSON.stringify(v)); m.cols[c] = nr;
    }
    m.rev = nr; await env.SUBS.put("team:meta", JSON.stringify(m));
    return json({ok: true, rev: nr});
  }
  if (path === "/api/team/reset" && req.method === "POST") {
    const m = await metaOf(env);
    for (const c of Object.keys(m.cols)) await env.SUBS.delete("team:col:" + c);
    const nm = {rev: m.rev + 1, cols: {}, reset: m.rev + 1}; await env.SUBS.put("team:meta", JSON.stringify(nm));
    return json({ok: true, rev: nm.rev});
  }
  return json({ok: false, error: "Not found."}, 404);
}
async function confirmAdmin(req, env, ip, url) {
  const a = await isAdmin(req, env, ip); if (!a.ok) return adminFail(a);
  const idx = await getJ(env, "cf:index", {items: {}});
  if (url.pathname === "/api/confirm/status") return json({ok: true, items: idx.items});
  if (url.pathname === "/api/confirm/create" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ok: false, error: "Bad request."}, 400); }
    const refId = clean(b.refId, 60), kind = b.kind === "payment" ? "payment" : "donation", amount = parseFloat(b.amount);
    if (!refId || !(amount > 0)) return json({ok: false, error: "Bad request."}, 400);
    const rec = {kind, amount, cur: clean(b.cur, 6) || "PKR", date: clean(b.date, 20), party: clean(b.party, 120), purpose: clean(b.purpose, 160)};
    const ex = idx.items[refId];
    if (ex) { const old = await getJ(env, "cf:" + ex.token, null); if (old && old.amount === amount && old.date === rec.date && old.party === rec.party && old.kind === kind) return json({ok: true, token: ex.token, status: ex.status}); }
    const token = rnd(14);
    await env.SUBS.put("cf:" + token, JSON.stringify(Object.assign({token, refId, status: "Sent", createdAt: new Date().toISOString()}, rec)));
    idx.items[refId] = {token, status: "Sent", amount, kind}; await env.SUBS.put("cf:index", JSON.stringify(idx));
    return json({ok: true, token, status: "Sent"});
  }
  return json({ok: false, error: "Not found."}, 404);
}
async function confirmPublic(req, env, ip, url) {
  if (await limited(env, "cf:" + ip, 60, 3600)) return json({ok: false, error: "Too many tries. Please try again later."}, 429);
  if (url.pathname === "/api/confirm/view" && req.method === "GET") {
    const t = clean(url.searchParams.get("t"), 40); if (!/^[A-Za-z0-9]{8,30}$/.test(t)) return json({ok: false, error: "This link is not valid."}, 404);
    const r = await getJ(env, "cf:" + t, null); if (!r) return json({ok: false, error: "This link is not valid."}, 404);
    return json({ok: true, kind: r.kind, amount: r.amount, cur: r.cur, date: r.date, party: r.party, purpose: r.purpose, status: r.status, by: r.by || "", at: r.at || ""});
  }
  if (url.pathname === "/api/confirm/respond" && req.method === "POST") {
    let b; try { b = await req.json(); } catch (e) { return json({ok: false, error: "Bad request."}, 400); }
    const t = clean(b.t, 40), name = clean(b.name, 80), note = clean(b.note, 400), yes = b.decision === "yes";
    if (!/^[A-Za-z0-9]{8,30}$/.test(t)) return json({ok: false, error: "This link is not valid."}, 404);
    if (name.length < 2) return json({ok: false, error: "Please type your name."}, 400);
    if (!yes && !note) return json({ok: false, error: "Please tell us what is wrong."}, 400);
    const r = await getJ(env, "cf:" + t, null); if (!r) return json({ok: false, error: "This link is not valid."}, 404);
    if (r.status === "Confirmed") return json({ok: true, status: r.status, by: r.by, at: r.at, already: true});
    r.status = yes ? "Confirmed" : "Disputed"; r.by = name; r.note = note; r.at = new Date().toISOString();
    await env.SUBS.put("cf:" + t, JSON.stringify(r));
    const idx = await getJ(env, "cf:index", {items: {}}); if (idx.items[r.refId]) { idx.items[r.refId].status = r.status; idx.items[r.refId].by = name; idx.items[r.refId].at = r.at; idx.items[r.refId].note = note; await env.SUBS.put("cf:index", JSON.stringify(idx)); }
    return json({ok: true, status: r.status, by: name, at: r.at});
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
      if (url.pathname === "/api/ping") return json({ok: true, v: 2, admin: !!env.ADMIN_KEY});
      if (url.pathname.startsWith("/api/team/")) return await team(req, env, ip, url);
      if (url.pathname === "/api/confirm/status" || url.pathname === "/api/confirm/create") return await confirmAdmin(req, env, ip, url);
      if (url.pathname.startsWith("/api/confirm/")) return await confirmPublic(req, env, ip, url);
      if (url.pathname === "/api/submit" && req.method === "POST") return await submit(req, env, ip);
      if (url.pathname.startsWith("/api/admin/")) return await admin(req, env, url, ip);
      return json({ok: false, error: "Not found."}, 404);
    } catch (e) { return json({ok: false, error: "Server error. Please try again."}, 500); }
  }
};
