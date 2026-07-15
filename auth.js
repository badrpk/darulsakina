/**
 * Unified auth (Node): signup/signin + OTP + Google/Facebook OAuth.
 * Verified / social users login WITHOUT OTP.
 */
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const nodemailerSkip = true; // use raw SMTP via child if needed; demo OTP fallback always available

const USERS = {};      // email -> user
const SESSIONS = {};   // token -> session
const OTPS = {};       // email -> otp

function now() { return Date.now() / 1000; }
function iso() { return new Date().toISOString(); }
function uid(p = "usr") { return `${p}_${crypto.randomBytes(6).toString("hex")}`; }

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
    ...loadEnvFile(path.join(home, "auth.env")),
    ...loadEnvFile(path.join(home, "oauth.env")),
    ...loadEnvFile(path.join(home, "messaging.env")),
    ...loadEnvFile(path.join(os.homedir(), ".shmry_email.env")),
    ...process.env,
  };
}

function hashPw(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return { salt, digest };
}
function checkPw(password, salt, digest) {
  return hashPw(password, salt).digest === digest;
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name || "", verified: !!u.verified,
    providers: u.providers || [], created_at: u.created_at,
    otp_required_on_login: !u.verified,
  };
}

function issueOtp(email, purpose) {
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  OTPS[email] = { code, exp: now() + 600, purpose };
  return OTPS[email];
}

function sendOtpEmail(to, code, product, cfg) {
  const expose = String(cfg.AUTH_EXPOSE_OTP || "true").toLowerCase() !== "false";
  // Always return demo_code for open-source client testing unless AUTH_EXPOSE_OTP=false
  return {
    sent: false,
    demo_code: expose ? code : null,
    note: "OTP issued; demo_code returned for clients (set AUTH_EXPOSE_OTP=false to hide). Configure SMTP on Python services for real email.",
  };
}

function createSession(email, days = 30) {
  const token = crypto.randomBytes(32).toString("base64url");
  SESSIONS[token] = { email, exp: now() + days * 86400, created_at: iso() };
  return token;
}

function signup({ email, password, name = "" }, product = "app") {
  const email_l = String(email || "").trim().toLowerCase();
  if (!email_l.includes("@")) return { ok: false, error: "invalid_email" };
  if (!password || password.length < 6) return { ok: false, error: "password_min_6" };
  if (USERS[email_l]) return { ok: false, error: "email_already_registered" };
  const { salt, digest } = hashPw(password);
  const u = {
    id: uid("usr"), email: email_l, name: name || email_l.split("@")[0],
    salt, password_hash: digest, verified: false, providers: ["password"], created_at: iso(),
  };
  USERS[email_l] = u;
  const otp = issueOtp(email_l, "signup");
  const mail = sendOtpEmail(email_l, otp.code, product, loadConfig());
  return {
    ok: true, user: publicUser(u), otp_required: true,
    otp: { purpose: "signup", expires_in_sec: 600, ...mail },
    message: "Account created. Verify OTP. After verification, future logins skip OTP.",
  };
}

function login({ email, password, force_otp = false }, product = "app") {
  const email_l = String(email || "").trim().toLowerCase();
  const u = USERS[email_l];
  if (!u || !(u.providers || []).includes("password")) return { ok: false, error: "invalid_credentials" };
  if (!checkPw(password, u.salt, u.password_hash)) return { ok: false, error: "invalid_credentials" };
  if (u.verified && !force_otp) {
    return {
      ok: true, otp_required: false, token: createSession(email_l), user: publicUser(u),
      message: "Welcome back — OTP skipped for verified/existing user.",
    };
  }
  const otp = issueOtp(email_l, "login");
  const mail = sendOtpEmail(email_l, otp.code, product, loadConfig());
  return {
    ok: true, otp_required: true, user: publicUser(u),
    otp: { purpose: "login", expires_in_sec: 600, ...mail },
    message: "OTP required to complete first-time verification.",
  };
}

function requestOtp({ email, purpose = "login" }, product = "app") {
  const email_l = String(email || "").trim().toLowerCase();
  if (!USERS[email_l] && purpose !== "signup") return { ok: false, error: "user_not_found" };
  const otp = issueOtp(email_l, purpose);
  const mail = sendOtpEmail(email_l, otp.code, product, loadConfig());
  return { ok: true, email: email_l, purpose, expires_in_sec: 600, ...mail };
}

function verifyOtp({ email, code }) {
  const email_l = String(email || "").trim().toLowerCase();
  const rec = OTPS[email_l];
  if (!rec) return { ok: false, error: "otp_not_found" };
  if (now() > rec.exp) return { ok: false, error: "otp_expired" };
  if (String(code).trim() !== rec.code) return { ok: false, error: "otp_invalid" };
  delete OTPS[email_l];
  const u = USERS[email_l];
  if (!u) return { ok: false, error: "user_not_found" };
  u.verified = true;
  return {
    ok: true, verified: true, token: createSession(email_l), user: publicUser(u),
    message: "Verified. Future password logins will not require OTP.",
  };
}

function httpsGet(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

async function oauthLogin({ provider, token, profile }, product = "app") {
  provider = String(provider || "").toLowerCase();
  if (provider === "gmail") provider = "google";
  if (!["google", "facebook"].includes(provider)) {
    return { ok: false, error: "unsupported_provider", allowed: ["google", "facebook"] };
  }
  const cfg = loadConfig();
  let info = null;
  if (token && provider === "google") {
    info = await httpsGet(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (info && info.email) {
      info = { email: String(info.email).toLowerCase(), name: info.name || info.email.split("@")[0], provider_user_id: info.sub || info.email };
    } else info = null;
  }
  if (token && provider === "facebook") {
    const data = await httpsGet(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(token)}`);
    if (data && data.id) {
      info = {
        email: String(data.email || `fb_${data.id}@facebook.local`).toLowerCase(),
        name: data.name || "Facebook User",
        provider_user_id: String(data.id),
      };
    }
  }
  if (!info && profile && (cfg.AUTH_DEMO_OAUTH || "true").toLowerCase() !== "false") {
    const email = String(profile.email || "").trim().toLowerCase();
    if (email.includes("@")) {
      info = {
        email,
        name: profile.name || email.split("@")[0],
        provider_user_id: String(profile.provider_user_id || profile.id || email),
      };
    }
  }
  if (!info) {
    return {
      ok: false, error: "oauth_validation_failed",
      hint: "Provide Google id_token / Facebook access_token, or demo profile when AUTH_DEMO_OAUTH=true",
    };
  }
  const email_l = info.email;
  let u = USERS[email_l];
  if (!u) {
    u = {
      id: uid("usr"), email: email_l, name: info.name, salt: "", password_hash: "",
      verified: true, providers: [provider], created_at: iso(),
    };
    USERS[email_l] = u;
  } else {
    u.verified = true;
    if (!(u.providers || []).includes(provider)) u.providers = [...(u.providers || []), provider];
  }
  return {
    ok: true, otp_required: false, provider, token: createSession(email_l), user: publicUser(u),
    message: `Logged in with ${provider}. OTP not required for social / existing verified users.`,
  };
}

function me(token) {
  if (!token) return { ok: false, error: "missing_token" };
  const sess = SESSIONS[token];
  if (!sess || now() > sess.exp) return { ok: false, error: "invalid_or_expired_token" };
  const u = USERS[sess.email];
  if (!u) return { ok: false, error: "user_missing" };
  return { ok: true, user: publicUser(u) };
}

function logout(token) {
  if (token) delete SESSIONS[token];
  return { ok: true };
}

function extractToken(headers = {}, body = {}) {
  const auth = headers.authorization || headers.Authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headers["x-auth-token"] || headers["X-Auth-Token"] || body.token || "";
}

function capabilities() {
  const cfg = loadConfig();
  return {
    signup: true, login_password: true, otp: true, otp_skip_for_verified_users: true,
    oauth: {
      google: true, facebook: true,
      google_client_id_configured: !!cfg.GOOGLE_CLIENT_ID,
      facebook_app_id_configured: !!cfg.FACEBOOK_APP_ID,
      demo_oauth_profile: (cfg.AUTH_DEMO_OAUTH || "true").toLowerCase() !== "false",
    },
    routes: [
      "POST /auth/signup", "POST /auth/login", "POST /auth/otp/request", "POST /auth/otp/verify",
      "POST /auth/oauth/google", "POST /auth/oauth/facebook", "GET /auth/me", "POST /auth/logout", "GET /auth/capabilities",
    ],
  };
}

async function handleAuth(method, pathname, body = {}, headers = {}, product = "app") {
  const p = pathname.replace(/\/$/, "") || "/";
  if (method === "GET" && (p === "/auth" || p === "/auth/capabilities")) {
    return { status: 200, body: { ok: true, product, ...capabilities() } };
  }
  if (method === "GET" && p === "/auth/me") {
    const r = me(extractToken(headers, body));
    return { status: r.ok ? 200 : 401, body: r };
  }
  if (method === "POST" && p === "/auth/signup") {
    const r = signup(body, product);
    return { status: r.ok ? 201 : 400, body: r };
  }
  if (method === "POST" && p === "/auth/login") {
    const r = login(body, product);
    return { status: r.ok ? 200 : 401, body: r };
  }
  if (method === "POST" && (p === "/auth/otp/request" || p === "/auth/otp")) {
    const r = requestOtp(body, product);
    return { status: r.ok ? 200 : 400, body: r };
  }
  if (method === "POST" && p === "/auth/otp/verify") {
    const r = verifyOtp({ email: body.email, code: body.code || body.otp });
    return { status: r.ok ? 200 : 400, body: r };
  }
  if (method === "POST" && (p === "/auth/oauth/google" || p === "/auth/google" || p === "/auth/gmail")) {
    const r = await oauthLogin({ provider: "google", token: body.id_token || body.token, profile: body.profile }, product);
    return { status: r.ok ? 200 : 401, body: r };
  }
  if (method === "POST" && (p === "/auth/oauth/facebook" || p === "/auth/facebook")) {
    const r = await oauthLogin({ provider: "facebook", token: body.access_token || body.token, profile: body.profile }, product);
    return { status: r.ok ? 200 : 401, body: r };
  }
  if (method === "POST" && p === "/auth/logout") {
    return { status: 200, body: logout(extractToken(headers, body)) };
  }
  return { status: 404, body: { ok: false, error: "auth_route_not_found", path: p } };
}

module.exports = {
  signup, login, requestOtp, verifyOtp, oauthLogin, me, logout, handleAuth, capabilities, extractToken, publicUser,
};
