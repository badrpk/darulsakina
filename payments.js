/**
 * Multi-rail payments (Node) — Stripe + JazzCash + EasyPaisa + UPaisa + crypto + COD
 * Loads ~/.config/sophyane/{stripe,payments,crypto}.env when present.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const os = require("os");

function loadEnvFile(p) {
  const out = {};
  try {
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}

function loadConfig() {
  const home = path.join(os.homedir(), ".config", "sophyane");
  return {
    ...loadEnvFile(path.join(home, "stripe.env")),
    ...loadEnvFile(path.join(home, "payments.env")),
    ...loadEnvFile(path.join(home, "crypto.env")),
    ...process.env,
  };
}

const INVOICES = {};
const uid = (p = "inv") => `${p}_${crypto.randomBytes(6).toString("hex")}`;
const iso = () => new Date().toISOString();

const CATALOG = {
  laibabadar: { competitor: "Foodpanda restaurant", currency: "PKR", items: [
    { sku: "delivery_fee", name: "Brand delivery", competitor_price: 120, our_price: 50 },
    { sku: "reservation", name: "Table reservation", competitor_price: 500, our_price: 0 },
  ]},
  rangoons: { competitor: "Shopify + WA Business", currency: "USD", items: [
    { sku: "starter", name: "SME store plan", competitor_price: 29, our_price: 9.99 },
    { sku: "wa_commerce", name: "WhatsApp commerce", competitor_price: 15, our_price: 3.99 },
  ]},
  darulsakina: { competitor: "donation platforms", currency: "PKR", items: [
    { sku: "zakat_fee_pct", name: "Zakat fee %", competitor_price: 2.9, our_price: 0.5 },
    { sku: "membership", name: "Optional membership", competitor_price: 500, our_price: 100 },
  ]},
  nifdu: { competitor: "news premium", currency: "PKR", items: [
    { sku: "adfree", name: "Ad-free", competitor_price: 399, our_price: 99 },
  ]},
  vps: { competitor: "DigitalOcean", currency: "USD", items: [
    { sku: "s-1vcpu-1gb", name: "1GB droplet", competitor_price: 6, our_price: 2.99 },
    { sku: "s-2vcpu-2gb", name: "2GB droplet", competitor_price: 12, our_price: 5.99 },
    { sku: "backup", name: "Backups", competitor_price: 1.2, our_price: 0.49 },
  ]},
};

const RAILS = ["stripe","jazzcash","easypaisa","upaisa","coinbase","binance","monero","cod","bank"];

function pricing(product) {
  const cat = CATALOG[product] || { competitor: "market", currency: "USD", items: [] };
  return {
    product, competitor: cat.competitor, currency: cat.currency,
    policy: "Prices set well below typical competitor list rates.",
    items: cat.items.map(it => ({
      ...it,
      savings_percent: Math.round(((it.competitor_price - it.our_price) / Math.max(it.competitor_price, 0.0001)) * 1000) / 10,
    })),
    rails: RAILS,
  };
}

function stripePI(amountMinor, currency, description, cfg) {
  return new Promise((resolve) => {
    const key = cfg.STRIPE_SECRET_KEY;
    if (!key) return resolve(null);
    const body = new URLSearchParams({
      amount: String(amountMinor),
      currency: currency.toLowerCase(),
      description,
      "payment_method_types[]": "card",
    }).toString();
    const req = https.request({
      hostname: "api.stripe.com", path: "/v1/payment_intents", method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); }
      });
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

async function createInvoice({ product, amount, currency = "USD", method = "stripe", description = "", customer = "guest", sku }) {
  const cfg = loadConfig();
  const cat = CATALOG[product];
  if (sku && cat) {
    const it = cat.items.find(x => x.sku === sku);
    if (it) { amount = it.our_price; currency = cat.currency; description = description || it.name; }
  }
  const id = uid("inv");
  const inv = {
    id, product, amount: Number(amount), currency: String(currency).toUpperCase(), method,
    description: description || `${product} payment`, customer, sku: sku || null,
    status: "pending", created_at: iso(), pay_instructions: {}, stripe: null,
  };
  if (method === "stripe") {
    const cur = inv.currency;
    const minor = ["PKR", "JPY", "KRW"].includes(cur) ? Math.round(inv.amount) : Math.round(inv.amount * 100);
    const pi = await stripePI(minor, cur, inv.description, cfg);
    if (pi && pi.id && !pi.error) {
      inv.stripe = { payment_intent_id: pi.id, client_secret: pi.client_secret, status: pi.status };
      inv.status = pi.status || "requires_payment_method";
      inv.pay_instructions = { type: "stripe_payment_intent", client_secret: pi.client_secret };
    } else {
      inv.status = "pending_demo";
      inv.stripe = { demo: true, error: pi && pi.error };
      inv.pay_instructions = { type: "demo_card", use_test_card: "4242 4242 4242 4242" };
    }
  } else if (method === "jazzcash") {
    inv.pay_instructions = { type: "jazzcash", phone: cfg.JAZZCASH_PHONE || "set_in_payments.env", reference: id, amount: inv.amount };
  } else if (method === "easypaisa") {
    inv.pay_instructions = { type: "easypaisa", phone: cfg.EASYPAISA_PHONE || "set_in_payments.env", reference: id, amount: inv.amount };
  } else if (method === "upaisa") {
    inv.pay_instructions = { type: "upaisa", phone: cfg.UPAISA_PHONE || "set_in_payments.env", reference: id, amount: inv.amount };
  } else if (method === "coinbase") {
    inv.pay_instructions = { type: "coinbase", btc: cfg.COINBASE_BTC_ADDRESS, eth: cfg.COINBASE_ETH_ADDRESS, usdc: cfg.COINBASE_USDC_ADDRESS, reference: id };
  } else if (method === "binance") {
    inv.pay_instructions = { type: "binance", usdt: cfg.BINANCE_USDT_ADDRESS, network: cfg.BINANCE_USDT_NETWORK || "TRC20", reference: id };
  } else if (method === "monero") {
    inv.pay_instructions = { type: "monero", address: cfg.MONERO_PRIMARY_ADDRESS || cfg.MONERO_SUBADDRESS, reference: id };
  } else if (method === "cod") {
    inv.status = "cod_pending";
    inv.pay_instructions = { type: "cod", reference: id };
  } else if (method === "bank") {
    inv.pay_instructions = { type: "bank", email: cfg.MERCHANT_EMAIL, reference: id };
  } else {
    inv.status = "error";
    inv.pay_instructions = { error: "unknown_method", allowed: RAILS };
  }
  INVOICES[id] = inv;
  return inv;
}

function getInvoice(id) { return INVOICES[id] || null; }
function markPaid(id, proof = "") {
  const inv = INVOICES[id];
  if (!inv) return null;
  inv.status = "paid"; inv.paid_at = iso(); inv.proof = String(proof).slice(0, 500);
  return inv;
}

module.exports = { pricing, createInvoice, getInvoice, markPaid, RAILS, loadConfig };
