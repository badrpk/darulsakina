/**
 * Darul Sakina — community & faith portal API + static site
 * Parity target: MosqueFinder / Islamic community CMS (events, prayer, donations, volunteers)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT || 8765;
const uid = (p = "id") => `${p}_${crypto.randomBytes(5).toString("hex")}`;
const iso = () => new Date().toISOString();

const state = {
  events: [
    { id: "ev1", title: "Friday Khutbah", date: "2026-07-18", time: "13:00", location: "Main Hall", capacity: 400, rsvp: 120 },
    { id: "ev2", title: "Youth Quran Circle", date: "2026-07-20", time: "17:30", location: "Library", capacity: 40, rsvp: 18 },
  ],
  volunteers: [],
  donations: [],
  announcements: [
    { id: "an1", title: "Ramadan schedule posted", body: "Iftar timings available in prayer times.", at: iso() },
  ],
  contacts: [],
};

function prayerTimes(city = "Karachi") {
  // Approximate static table for demo parity (not astronomical calc)
  const base = {
    Karachi: { fajr: "04:25", dhuhr: "12:30", asr: "16:05", maghrib: "19:18", isha: "20:40" },
    Lahore: { fajr: "03:55", dhuhr: "12:15", asr: "15:50", maghrib: "19:05", isha: "20:30" },
    Islamabad: { fajr: "03:50", dhuhr: "12:10", asr: "15:45", maghrib: "19:00", isha: "20:25" },
  };
  return { city, date: new Date().toISOString().slice(0, 10), times: base[city] || base.Karachi, method: "demo_table" };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({ _error: "invalid_json" }); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname.replace(/\/$/, "") || "/";

  if (req.method === "GET" && (p === "/api" || p === "/api/health")) {
    return json(res, 200, {
      ok: true, service: "darulsakina", version: "2.0.0",
      parity_target: "MosqueFinder / community CMS",
      routes: ["/api/prayer-times", "/api/events", "/api/announcements", "/api/donations",
               "/api/volunteers", "/api/capabilities"],
    });
  }
  if (req.method === "GET" && p === "/api/capabilities") {
    return json(res, 200, {
      ok: true, competitor: "MosqueFinder / Islamic community portals",
      features: ["prayer_times", "events_rsvp", "donations", "volunteers", "announcements", "contact_form", "static_site"],
    });
  }
  if (req.method === "GET" && p === "/api/prayer-times") {
    return json(res, 200, { ok: true, ...prayerTimes(u.searchParams.get("city") || "Karachi") });
  }
  if (req.method === "GET" && p === "/api/events") return json(res, 200, { ok: true, events: state.events });
  if (req.method === "GET" && p === "/api/announcements") return json(res, 200, { ok: true, announcements: state.announcements });
  if (req.method === "GET" && p === "/api/donations") return json(res, 200, { ok: true, donations: state.donations, total_pkr: state.donations.reduce((s, d) => s + d.amount_pkr, 0) });
  if (req.method === "GET" && p === "/api/volunteers") return json(res, 200, { ok: true, volunteers: state.volunteers });

  if (req.method === "POST" && p === "/api/events") {
    const b = await readBody(req);
    const ev = { id: uid("ev"), title: b.title || "Event", date: b.date || "", time: b.time || "", location: b.location || "", capacity: b.capacity || 100, rsvp: 0 };
    state.events.push(ev);
    return json(res, 201, { ok: true, event: ev });
  }
  if (req.method === "POST" && p.startsWith("/api/events/") && p.endsWith("/rsvp")) {
    const id = p.split("/")[3];
    const ev = state.events.find((e) => e.id === id);
    if (!ev) return json(res, 404, { ok: false, error: "not_found" });
    if (ev.rsvp >= ev.capacity) return json(res, 400, { ok: false, error: "full" });
    ev.rsvp += 1;
    return json(res, 200, { ok: true, event: ev });
  }
  if (req.method === "POST" && p === "/api/donations") {
    const b = await readBody(req);
    const d = { id: uid("don"), name: b.name || "Anonymous", amount_pkr: Number(b.amount_pkr) || 0, method: b.method || "bank", cause: b.cause || "general", at: iso() };
    if (d.amount_pkr <= 0) return json(res, 400, { ok: false, error: "invalid_amount" });
    state.donations.push(d);
    return json(res, 201, { ok: true, donation: d, receipt: `DS-${d.id}` });
  }
  if (req.method === "POST" && p === "/api/volunteers") {
    const b = await readBody(req);
    const v = { id: uid("vol"), name: b.name || "", phone: b.phone || "", skills: b.skills || [], availability: b.availability || "", at: iso() };
    if (!v.name) return json(res, 400, { ok: false, error: "name_required" });
    state.volunteers.push(v);
    return json(res, 201, { ok: true, volunteer: v });
  }
  if (req.method === "POST" && p === "/api/contact") {
    const b = await readBody(req);
    const c = { id: uid("msg"), name: b.name || "", email: b.email || "", message: b.message || "", at: iso() };
    state.contacts.push(c);
    return json(res, 201, { ok: true, ticket: c.id });
  }
  if (req.method === "POST" && p === "/api/announcements") {
    const b = await readBody(req);
    const a = { id: uid("an"), title: b.title || "", body: b.body || "", at: iso() };
    state.announcements.unshift(a);
    return json(res, 201, { ok: true, announcement: a });
  }

  // static files
  let file = path.join(__dirname, "public", p === "/" ? "index.html" : p.replace(/^\//, ""));
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: "not_found", hint: "try /api/health" });
    const ext = path.extname(file);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`Darul Sakina v2 http://127.0.0.1:${PORT}  (API /api/health)`));
