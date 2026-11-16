// Maa Welfare - donations backend (Cloudflare Worker + KV).
// Secrets (set in Cloudflare, never in code): ADMIN_USER, ADMIN_PASS, SESSION_SECRET
// KV binding: DONATIONS
const CURS = ["PKR","OMR","USD","AED","SAR","GBP","EUR","QAR","KWD","BHD","CAD","AUD"];
const FUNDS = ["Education","Medical","General"];
const METHODS = ["Bank transfer","Cheque","Online payment","Cash","Other"];
const MAX_FILE = 1500000; // bytes of base64 text per file
const enc = new TextEncoder();

const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n);
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function same(a, b) { const x = await sha(a), y = await sha(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; }
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function newRef() {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(8));
  return "MW-" + [...r].map(x => a[x % a.length]).join("");
}
async function limit(env, key, max, secs) {
  const k = "rl:" + key, n = parseInt(await env.DONATIONS.get(k) || "0", 10);
  if (n >= max) return false;
  await env.DONATIONS.put(k, String(n + 1), { expirationTtl: secs });
  return true;
}
const ip = req => req.headers.get("cf-connecting-ip") || "x";

async function isAdmin(req, env) {
  if (!env.SESSION_SECRET) return false;
  const m = /(?:^|;\s*)mw_admin=([^;]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return same(sig, await hmac(env.SESSION_SECRET, "admin." + exp));
}

function validDonation(b) {
  const name = clean(b.name, 100), contact = clean(b.contact, 120);
  const amount = Number(String(b.amount).replace(/,/g, ""));
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact);
  const phone = /^\+?[0-9][0-9\s-]{6,17}[0-9]$/.test(contact);
  if (name.length < 2) return "Please enter your name.";
  if (!email && !phone) return "Please enter a valid phone number or email.";
  if (!(amount > 0) || amount > 100000000) return "Please enter an amount above zero.";
  if (!CURS.includes(b.currency)) return "Please choose a currency.";
  if (b.terms !== true) return "Please accept the terms for donations.";
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.DONATIONS) return json({ error: "Storage is not set up yet." }, 503);
    try {
      // ---- public: submit a donation ----
      if (p === "/api/donations" && req.method === "POST") {
        if (!(await limit(env, "sub:" + ip(req), 10, 3600))) return json({ error: "Too many submissions. Please try later." }, 429);
        const b = await req.json();
        const bad = validDonation(b); if (bad) return json({ error: bad }, 400);
        const ref = newRef(), files = [];
        for (const f of (Array.isArray(b.files) ? b.files.slice(0, 2) : [])) {
          const data = String(f.data || ""), type = String(f.type || "");
          if (!/^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,/.test(data)) return json({ error: "Receipts must be a photo or PDF." }, 400);
          if (data.length > MAX_FILE) return json({ error: "A file is too large. Please use a photo under 1 MB." }, 400);
          files.push({ label: clean(f.label, 40) || "File", name: clean(f.name, 80), data, type });
        }
        const rec = {
          ref, status: "review", created: new Date().toISOString(),
          name: clean(b.name, 100), contact: clean(b.contact, 120), currency: b.currency, amount: Number(String(b.amount).replace(/,/g, "")),
          date: clean(b.date, 10), method: METHODS.includes(b.method) ? b.method : "Other", txn: clean(b.txn, 80),
          fund: FUNDS.includes(b.fund) ? b.fund : "General", note: clean(b.note, 500), wantReceipt: b.wantReceipt === true, files: files.map(f => ({ label: f.label, name: f.name }))
        };
        for (let i = 0; i < files.length; i++) await env.DONATIONS.put("f:" + ref + ":" + i, files[i].data);
        await env.DONATIONS.put("d:" + ref, JSON.stringify(rec));
        return json({ ok: true, ref, status: "review" });
      }
      // ---- public: status of one donation by reference (no personal data) ----
      let m = /^\/api\/status\/(MW-[A-Z0-9]{8})$/.exec(p);
      if (m && req.method === "GET") {
        const r = await env.DONATIONS.get("d:" + m[1]);
        if (!r) return json({ error: "Reference not found." }, 404);
        return json({ ref: m[1], status: JSON.parse(r).status });
      }
      // ---- public: totals of CONFIRMED donations only ----
      if (p === "/api/summary" && req.method === "GET") {
        const t = {}; let count = 0, cursor;
        do {
          const l = await env.DONATIONS.list({ prefix: "d:", cursor }); cursor = l.list_complete ? null : l.cursor;
          const rows = await Promise.all(l.keys.map(k => env.DONATIONS.get(k.name)));
          for (const r of rows) { if (!r) continue; const d = JSON.parse(r); if (d.status === "confirmed") { count++; t[d.currency] = (t[d.currency] || 0) + (d.receivedAmount || d.amount); } }
        } while (cursor);
        return json({ count, totals: t });
      }
      // ---- admin login / logout ----
      if (p === "/api/admin/login" && req.method === "POST") {
        if (!env.ADMIN_USER || !env.ADMIN_PASS || !env.SESSION_SECRET) return json({ error: "Admin login is not set up yet." }, 503);
        if (!(await limit(env, "login:" + ip(req), 5, 900))) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
        const b = await req.json();
        const ok = (await same(String(b.user || ""), env.ADMIN_USER)) & (await same(String(b.pass || ""), env.ADMIN_PASS));
        if (!ok) return json({ error: "Wrong username or password." }, 401);
        const exp = Date.now() + 8 * 3600 * 1000, tok = exp + "." + await hmac(env.SESSION_SECRET, "admin." + exp);
        return json({ ok: true }, 200, { "set-cookie": `mw_admin=${encodeURIComponent(tok)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` });
      }
      if (p === "/api/admin/logout" && req.method === "POST") return json({ ok: true }, 200, { "set-cookie": "mw_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
      // ---- everything below needs the admin cookie ----
      if (p.startsWith("/api/admin/")) {
        if (!(await isAdmin(req, env))) return json({ error: "Please sign in." }, 401);
        if (p === "/api/admin/me") return json({ ok: true });
        if (p === "/api/admin/donations" && req.method === "GET") {
          const out = []; let cursor;
          do {
            const l = await env.DONATIONS.list({ prefix: "d:", cursor }); cursor = l.list_complete ? null : l.cursor;
            const rows = await Promise.all(l.keys.map(k => env.DONATIONS.get(k.name)));
            rows.forEach(r => r && out.push(JSON.parse(r)));
          } while (cursor);
          out.sort((a, b) => b.created.localeCompare(a.created));
          return json({ donations: out });
        }
        m = /^\/api\/admin\/file\/(MW-[A-Z0-9]{8})\/([01])$/.exec(p);
        if (m && req.method === "GET") {
          const d = await env.DONATIONS.get("f:" + m[1] + ":" + m[2]);
          if (!d) return json({ error: "No file." }, 404);
          const [head, b64] = d.split(","), type = /data:([^;]+)/.exec(head)[1];
          return new Response(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { headers: { "content-type": type, "cache-control": "no-store", "content-disposition": "inline", "x-content-type-options": "nosniff" } });
        }
        m = /^\/api\/admin\/donations\/(MW-[A-Z0-9]{8})$/.exec(p);
        if (m && req.method === "POST") {
          const raw = await env.DONATIONS.get("d:" + m[1]); if (!raw) return json({ error: "Not found." }, 404);
          const d = JSON.parse(raw), b = await req.json();
          if (b.action === "confirm") {
            const a = Number(String(b.receivedAmount).replace(/,/g, ""));
            if (!(a > 0)) return json({ error: "Enter the amount actually received." }, 400);
            d.status = "confirmed"; d.receivedAmount = a;
          } else if (b.action === "reject") d.status = "rejected";
          else return json({ error: "Unknown action." }, 400);
          d.reviewNote = clean(b.note, 300); d.reviewed = new Date().toISOString();
          await env.DONATIONS.put("d:" + m[1], JSON.stringify(d));
          return json({ ok: true, donation: d });
        }
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  }
};
