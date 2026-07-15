/**
 * Darul Sakina v3 — community CMS gaps + multi-rail donations (ultra-low fees)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const pay = require("./payments");
const PORT = process.env.PORT || 8765;
const uid = (p = "id") => `${p}_${crypto.randomBytes(5).toString("hex")}`;
const iso = () => new Date().toISOString();

const state = {
  events: [
    { id: "ev1", title: "Friday Khutbah", date: "2026-07-18", time: "13:00", location: "Main Hall", capacity: 400, rsvp: 120 },
    { id: "ev2", title: "Youth Quran Circle", date: "2026-07-20", time: "17:30", location: "Library", capacity: 40, rsvp: 18 },
  ],
  volunteers: [], donations: [], announcements: [
    { id: "an1", title: "Ramadan schedule posted", body: "Iftar timings available.", at: iso() },
  ],
  contacts: [], memberships: [],
};

function prayerTimes(city = "Karachi") {
  const base = {
    Karachi: { fajr: "04:25", dhuhr: "12:30", asr: "16:05", maghrib: "19:18", isha: "20:40" },
    Lahore: { fajr: "03:55", dhuhr: "12:15", asr: "15:50", maghrib: "19:05", isha: "20:30" },
    Islamabad: { fajr: "03:50", dhuhr: "12:10", asr: "15:45", maghrib: "19:00", isha: "20:25" },
  };
  return { city, date: new Date().toISOString().slice(0, 10), times: base[city] || base.Karachi, method: "demo_table" };
}
function zakatCalc(assets, liabilities = 0) {
  const nisab_pkr = 150000; // illustrative
  const net = Math.max(0, Number(assets) - Number(liabilities));
  const due = net >= nisab_pkr ? net * 0.025 : 0;
  return { assets: Number(assets), liabilities: Number(liabilities), net, nisab_pkr, zakat_due_pkr: Math.round(due), rate: "2.5%" };
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
  res.end(JSON.stringify(obj, null, 2));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = ""; req.on("data", c => data += c);
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({ _error: "invalid_json" }); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname.replace(/\/$/, "") || "/";

  if (req.method === "GET" && (p === "/api" || p === "/api/health")) {
    return json(res, 200, { ok: true, service: "darulsakina", version: "3.0.0",
      gaps_closed: ["zakat_calculator", "recurring_donations", "membership", "multi_rail_pay", "low_fees"] });
  }
  if (p === "/api/capabilities") return json(res, 200, { ok: true, competitor: "MosqueFinder / donation platforms",
    features: ["prayer_times","events_rsvp","donations","volunteers","announcements","zakat","membership","stripe","jazzcash"] });
  if (p === "/api/pricing") return json(res, 200, { ok: true, ...pay.pricing("darulsakina") });
  if (p === "/api/payments/rails") return json(res, 200, { ok: true, rails: pay.RAILS });
  if (p === "/api/gap-analysis") return json(res, 200, { ok: true, added: ["zakat calc", "recurring donations", "membership", "stripe multi-rail", "0.5% fee vs ~2.9%"] });
  if (p === "/api/prayer-times") return json(res, 200, { ok: true, ...prayerTimes(u.searchParams.get("city") || "Karachi") });
  if (p === "/api/zakat") return json(res, 200, { ok: true, ...zakatCalc(u.searchParams.get("assets") || 0, u.searchParams.get("liabilities") || 0) });
  if (p === "/api/events") return json(res, 200, { ok: true, events: state.events });
  if (p === "/api/announcements") return json(res, 200, { ok: true, announcements: state.announcements });
  if (p === "/api/donations") return json(res, 200, { ok: true, donations: state.donations, total_pkr: state.donations.reduce((s,d)=>s+(d.amount_pkr||0),0) });
  if (p === "/api/volunteers") return json(res, 200, { ok: true, volunteers: state.volunteers });
  if (p === "/api/memberships") return json(res, 200, { ok: true, memberships: state.memberships });

  if (req.method === "POST" && p === "/api/donations") {
    const b = await readBody(req);
    const amount = Number(b.amount_pkr) || 0;
    if (amount <= 0) return json(res, 400, { ok: false, error: "invalid_amount" });
    const fee_pct = 0.5;
    const fee = Math.round(amount * fee_pct / 100);
    const method = b.method || "stripe";
    const inv = await pay.createInvoice({ product: "darulsakina", amount, currency: "PKR", method, customer: b.name || "Anonymous", description: b.cause || "general donation" });
    const d = { id: uid("don"), name: b.name || "Anonymous", amount_pkr: amount, fee_pkr: fee, fee_pct, method, cause: b.cause || "general",
      recurring: !!b.recurring, interval: b.interval || null, invoice: inv, at: iso(), receipt: null };
    d.receipt = `DS-${d.id}`;
    state.donations.push(d);
    return json(res, 201, { ok: true, donation: d, fee_note: "0.5% platform fee vs ~2.9% on many platforms" });
  }
  if (req.method === "POST" && p === "/api/memberships") {
    const b = await readBody(req);
    const inv = await pay.createInvoice({ product: "darulsakina", amount: 100, currency: "PKR", method: b.method || "jazzcash", sku: "membership", customer: b.name || "member" });
    const m = { id: uid("mem"), name: b.name, phone: b.phone, invoice: inv, status: "active", at: iso() };
    state.memberships.push(m);
    return json(res, 201, { ok: true, membership: m });
  }
  if (req.method === "POST" && p === "/api/events") {
    const b = await readBody(req);
    const ev = { id: uid("ev"), title: b.title || "Event", date: b.date || "", time: b.time || "", location: b.location || "", capacity: b.capacity || 100, rsvp: 0 };
    state.events.push(ev); return json(res, 201, { ok: true, event: ev });
  }
  if (req.method === "POST" && p.startsWith("/api/events/") && p.endsWith("/rsvp")) {
    const ev = state.events.find(e => e.id === p.split("/")[3]);
    if (!ev) return json(res, 404, { ok: false });
    if (ev.rsvp >= ev.capacity) return json(res, 400, { ok: false, error: "full" });
    ev.rsvp += 1; return json(res, 200, { ok: true, event: ev });
  }
  if (req.method === "POST" && p === "/api/volunteers") {
    const b = await readBody(req);
    if (!b.name) return json(res, 400, { ok: false, error: "name_required" });
    const v = { id: uid("vol"), name: b.name, phone: b.phone || "", skills: b.skills || [], at: iso() };
    state.volunteers.push(v); return json(res, 201, { ok: true, volunteer: v });
  }
  if (req.method === "POST" && p === "/api/contact") {
    const b = await readBody(req);
    const c = { id: uid("msg"), name: b.name || "", email: b.email || "", message: b.message || "", at: iso() };
    state.contacts.push(c); return json(res, 201, { ok: true, ticket: c.id });
  }
  if (req.method === "POST" && p === "/api/payments/create") {
    const b = await readBody(req);
    const inv = await pay.createInvoice({ product: "darulsakina", amount: b.amount, currency: "PKR", method: b.method || "stripe", sku: b.sku });
    return json(res, 201, { ok: true, invoice: inv });
  }

  let file = path.join(__dirname, "public", p === "/" ? "index.html" : p.replace(/^\//, ""));
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: "not_found", hint: "try /api/health" });
    const ext = path.extname(file);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`Darul Sakina v3 http://127.0.0.1:${PORT}`));
