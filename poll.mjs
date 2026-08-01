/**
 * פסיכו — פולר מכסות + שיחות Cowork (Node) · רץ ב-GitHub Actions וגם מקומית
 * ---------------------------------------------------------------------------
 * קורא צד-שרת מ-claude.ai (בלי דפדפן, בלי CORS) עם sessionKey בלבד:
 *   1. usage אמיתי           → /api/organizations/{org}/usage
 *   2. שיחות Cowork אחרונות  → /v1/code/sessions?tags=cowork-remote | cowork-local
 *
 * שיחות Cowork הן "code sessions" (מזהה cse_…), לא chat_conversations.
 * chat_conversations מחזיר שיחות צ׳אט רגילות (platform=CLAUDE_AI) — לא להשתמש בו כאן.
 * ה-endpoint של /v1/ דורש כותרת anthropic-version וגם את עוגיית lastActiveOrg (ראה למטה).
 *
 * מצבי הרצה:
 *   node poll.mjs           → כותב usage.json לדיסק (זה מה ש-GitHub Actions צריך; ה-workflow מבצע commit)
 *   node poll.mjs --push    → דוחף ישירות ל-GitHub API (הרצה מקומית מ-IP ביתי)
 *
 * מפתחות: SESSION_KEYS (Secret/env) או keys.json מקומי — מערך [{hint,key}].
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "usage.json");
const WEEK_MS = 7 * 24 * 3600e3;
const PUSH = process.argv.includes("--push") || process.env.PUSH_TO_GITHUB === "1";
const OWNER = "elad-cmd", REPO = "psycho-usage", GH_PATH = "usage.json";
const GH_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${GH_PATH}`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_SESSIONS = 5;
const COWORK_TAGS = ["cowork-remote", "cowork-local"];

/* רשימת החשבונות הקנונית — משמשת רק להקמה ראשונה של קובץ שלא קיים.
   אחרי זה הקובץ הקיים הוא המקור, ולעולם לא מוחקים ממנו חשבון. */
const SEED = [
  { id: "acc-office",       label: "office@psycho.co.il" },
  { id: "acc-claudepsycho", label: "claude.psycho.co.il@gmail.com" },
  { id: "acc-claude2",      label: "claude2.psycho.co.il@gmail.com" },
  { id: "acc-claude3",      label: "claude3.psycho.co.il@gmail.com" },
  { id: "acc-claude4",      label: "claude4.psycho.co.il@gmail.com" },
  { id: "acc-elad",         label: "elad@psycho.co.il" },
  { id: "acc-elad362",      label: "elad362@gmail.com" },
  // חשבונות רזרבה — נוצרים כרשומות ריקות ("טרם סונכרן") כדי שיופיעו בדשבורד
  // עוד לפני שרכשו להם מנוי ולפני שיש להם מפתח. סדר העדיפות להפעלה שאלעד
  // קבע: info → essay → psychoshop → essaymanager.
  { id: "acc-info",         label: "info@psycho.co.il" },
  { id: "acc-essay",        label: "essay@psycho.co.il" },
  { id: "acc-shop",         label: "psychoshop@psycho.co.il" },
  { id: "acc-essaymgr",     label: "essaymanager@psycho.co.il" },
].map((a) => ({ ...a, plan: "Max (20x)", notes: "", sessions: [], usage: null, lastSyncAt: null, updatedAt: 0 }));

function loadKeys() {
  if (process.env.SESSION_KEYS) return JSON.parse(process.env.SESSION_KEYS);
  return JSON.parse(readFileSync(join(HERE, "keys.json"), "utf8"));
}
function loadToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const p = join(HERE, "github-token.txt");
  if (!existsSync(p)) throw new Error("חסר github-token.txt (טוקן GitHub עם Contents:write)");
  return readFileSync(p, "utf8").trim();
}

async function claudeGet(path, sk, extraHeaders, extraCookies) {
  const cookie = "sessionKey=" + sk + (extraCookies ? "; " + extraCookies : "");
  const r = await fetch("https://claude.ai" + path, {
    method: "GET",
    headers: Object.assign({
      Cookie: cookie,
      Accept: "application/json",
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
      "anthropic-client-platform": "web_claude_ai",
      Referer: "https://claude.ai/",
    }, extraHeaders || {}),
  });
  const text = await r.text();
  const label = path.split("?")[0];
  if (!r.ok) throw new Error(label + " -> " + r.status + " " + text.slice(0, 120));
  try { return JSON.parse(text); }
  catch { throw new Error(label + " -> לא-JSON (דף אתגר/התחברות): " + text.slice(0, 120)); }
}

/* שיחות Cowork אחרונות.
   המלכודת שעלתה בריצה חיה: `/v1/code/sessions` החזיר 401 authentication_error בזמן
   ש-`/api/…/usage` עבד מצוין עם אותו sessionKey בדיוק. הסיבה אינה מפתח פג — השער של
   `/v1/` דורש גם את עוגיית **lastActiveOrg**, שהיא פשוט ה-uuid של הארגון (לא סוד, ואנחנו
   ממילא שולפים אותו שורה קודם). בלעדיה: 401. איתה: 200. אומת בבידוד בדפדפן — מחיקת
   העוגייה הפילה ל-401, החזרתה הקפיצה חזרה ל-200, וכל שאר העוגיות לא השפיעו.

   כישלון כאן לעולם לא מפיל את סנכרון ה-usage — מחזיר null, והקורא משאיר את הרשימה הקודמת. */
async function fetchCoworkSessions(sk, orgUuid) {
  if (!orgUuid) return null;
  const V1 = { "anthropic-version": "2023-06-01" };
  const COOKIES = "lastActiveOrg=" + orgUuid;      // חובה — בלעדיה השער מחזיר 401
  const byId = new Map();
  let anyOk = false;
  for (const tag of COWORK_TAGS) {
    try {
      const res = await claudeGet(`/v1/code/sessions?limit=${MAX_SESSIONS + 3}&tags=${encodeURIComponent(tag)}`, sk, V1, COOKIES);
      anyOk = true;
      for (const s of (res && res.data) || []) if (s && s.id) { dumpSessionShape(s); byId.set(s.id, s); }
    } catch (e) {
      console.log(`   · תגית ${tag}: ${(e && e.message) || e}`);
    }
  }
  if (!anyOk) return null;
  return [...byId.values()]
    .sort((a, b) => new Date(b.last_event_at || 0) - new Date(a.last_event_at || 0))
    .slice(0, MAX_SESSIONS)
    .map((s) => {
      const rec = {
        t: (s.title && String(s.title).trim()) || "(שיחה ללא שם)",
        u: "https://claude.ai/cowork/" + s.id,
      };
      // מטא-דאטה שימושי שה-API כן מחזיר
      if (s.status) rec.st = String(s.status).slice(0, 32);
      if (s.status_bucket) rec.sb = String(s.status_bucket).slice(0, 32);
      if (s.last_event_at) rec.ev = s.last_event_at;
      if (Array.isArray(s.tags)) rec.tag = s.tags.includes("cowork-local") ? "local" : "remote";
      // עומס השיחה: ה-API טרם תועד כמחזיר נתון כזה. במקום לנחש — סורקים
      // שדות מספריים ששמם מרמז על ניצול הקשר, ורק אם נמצא כזה כותבים `load`.
      // אם לא נמצא — אין שדה, והדשבורד יציג טבעת אפורה עם "?" ולא מספר מומצא.
      const lv = findLoad(s);
      if (lv !== null) rec.load = lv;
      return rec;
    });
}

/* ---- עומס שיחה: גישוש זהיר -----------------------------------------
   מחפש בעץ התשובה שדה מספרי ששמו מרמז על ניצול חלון ההקשר
   (context/token/usage/window + used/pct/percent/ratio/fraction).
   מנרמל: 0-1 → אחוזים; 0-100 → כמו שהוא. לא נמצא ⇒ null, ואז הדשבורד
   מציג "לא ידוע" במפורש. בנוסף, בריצה הראשונה מדפיסים פעם אחת את שמות
   השדות שה-API החזיר, כדי שנדע אם בכלל יש שדה כזה בלי לנחש.
   -------------------------------------------------------------------- */
const LOAD_HINT = /(context|token|usage|window).*(used|pct|percent|ratio|fraction|remaining)|(used|pct|percent).*(context|token|window)/i;
let dumpedSessionKeys = false;
function findLoad(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && isFinite(v) && LOAD_HINT.test(k)) {
      if (v >= 0 && v <= 1) return Math.round(v * 100);
      if (v >= 0 && v <= 100) return Math.round(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const r = findLoad(v, depth + 1); if (r !== null) return r; }
  }
  return null;
}
function dumpSessionShape(s) {
  if (dumpedSessionKeys || !s) return;
  dumpedSessionKeys = true;
  console.log("   · שדות שהוחזרו לשיחת Cowork:", Object.keys(s).join(", "));
}

async function syncOne(sk) {
  const boot = await claudeGet("/api/bootstrap", sk);
  const email = boot && boot.account && (boot.account.email_address || boot.account.email);
  if (!email) throw new Error("לא נמצא מייל (מפתח לא תקין/פג?)");
  const orgs = await claudeGet("/api/organizations", sk);
  if (!Array.isArray(orgs) || !orgs.length) throw new Error("אין ארגונים");
  const org = orgs.find((o) => (o.name || "").toLowerCase().includes(email.toLowerCase())) || orgs[0];
  const u = await claudeGet("/api/organizations/" + org.uuid + "/usage", sk);
  const pick = (k) => {
    const l = (u.limits || []).find((x) => x.kind === k);
    return l ? { pct: Math.round(l.percent || 0), resetsAt: l.resets_at || null } : null;
  };
  const usage = {
    session: pick("session"),
    weeklyAll: pick("weekly_all"),
    weeklyFable: pick("weekly_scoped") || pick("weekly_all"),
  };
  // לא זורקים כשה-weekly חסר: מיד אחרי איפוס claude.ai עשוי להשמיט את המכסה
  // או להחזיר resets_at=null. במקרה כזה merge() משלים את שעת האיפוס מהמחזור
  // השבועי הידוע, במקום שהחשבון "ייעלם" מהלוח עד שיהיה בשימוש שוב.
  if (!Array.isArray(u.limits)) throw new Error("תשובת usage לא תקינה (אין limits)");
  const sessions = await fetchCoworkSessions(sk, org.uuid);
  return { email, usage, sessions };
}

/* קריאת המאגר הקיים. ההבחנה כאן קריטית:
   קובץ שלא קיים → מתחילים מה-SEED (הקמה ראשונה).
   קובץ פגום     → זורקים שגיאה ולא כותבים כלום. אסור להתחיל מרשימה ריקה,
                   כי אז כל חשבון שהמפתח שלו מת באותו רגע נמחק מהקובץ ו"נעלם"
                   מהדשבורד עד שהמפתח שלו יחזור לעבוד. */
function readStore(raw) {
  if (raw === null) { console.log("usage.json לא קיים — הקמה ראשונה מה-SEED."); return SEED.map((a) => ({ ...a })); }
  let blob;
  try { blob = JSON.parse(raw); }
  catch (e) { throw new Error("usage.json פגום (JSON לא תקין) — לא כותבים, כדי לא לאבד חשבונות: " + ((e && e.message) || e)); }
  if (!blob || !Array.isArray(blob.accounts) || !blob.accounts.length) {
    throw new Error("usage.json בלי accounts — לא כותבים, כדי לא לאבד חשבונות.");
  }
  return blob.accounts;
}

/* גלגול שעת איפוס שבועית קדימה. המחזור קבוע (7 ימים), אז אם השעה הידועה
   כבר בעבר — מוסיפים שבועות עד שהיא בעתיד. */
function rollWeekly(iso, now) {
  if (!iso) return null;
  let t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  let guard = 0;
  while (t <= now && guard++ < 520) t += WEEK_MS;
  return new Date(t).toISOString();
}

/* אף פעם לא מאבדים שעת איפוס ידועה. אחרי איפוס שבועי claude.ai מחזיר
   resets_at=null (או משמיט את המכסה) עד לשימוש הבא — וזה מה שגרם לחשבון
   להיעלם מהלוח לכמה שעות. כאן שומרים את השעה הקודמת, מגולגלת קדימה. */
function carryUsage(prev, next, now) {
  const out = { ...(next || {}) };
  for (const k of ["weeklyAll", "weeklyFable"]) {
    const p = prev && prev[k], n = out[k];
    const carried = rollWeekly(p && p.resetsAt, now);
    if (!n) { if (carried) out[k] = { pct: 0, resetsAt: carried, estimated: true }; continue; }
    if (!n.resetsAt && carried) out[k] = { ...n, resetsAt: carried, estimated: true };
  }
  return out;
}

function ensureRoster(accounts) {
  for (const seed of SEED) {
    const exists = accounts.some((a) => (a.label || "").toLowerCase().trim() === seed.label.toLowerCase().trim());
    if (!exists) accounts.push({ ...seed });
  }
  return accounts;
}

function merge(accounts, fresh) {
  const now = Date.now();
  ensureRoster(accounts);
  for (const r of fresh) {
    let acc = accounts.find((a) => (a.label || "").toLowerCase().trim() === r.email.toLowerCase().trim());
    if (!acc) {
      acc = { id: "acc-" + r.email.replace(/[^a-z0-9]/gi, "").slice(0, 14), label: r.email, plan: "Max (20x)", notes: "", sessions: [] };
      accounts.push(acc);
    }
    acc.usage = carryUsage(acc.usage, r.usage, now);
    acc.lastSyncAt = now;
    acc.updatedAt = now;
    if (Array.isArray(r.sessions)) acc.sessions = r.sessions; // רק אם באמת נמשכו — אחרת משאירים את הקודמות
    // ניקוי: מציגים אך ורק שיחות Cowork אמיתיות. רשומות ישנות של שיחות צ׳אט
    // (‎/chat/…) נשארו במאגר מגרסה קודמת והוצגו בטעות ככותרת "שיחות Cowork".
    acc.sessions = (acc.sessions || []).filter((x) => x && typeof x.u === "string" && x.u.includes("/cowork/"));
  }
  return { v: 2, savedAt: now, savedBy: PUSH ? "poller:local" : "poller:github", accounts };
}

async function ghGet(token) {
  const r = await fetch(GH_API + "?ref=main", { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "psycho-poller" } });
  if (r.status === 404) return { sha: null, raw: null };
  if (!r.ok) throw new Error("GitHub GET " + r.status + " " + (await r.text()).slice(0, 120));
  const j = await r.json();
  return { sha: j.sha, raw: Buffer.from(j.content, "base64").toString("utf8") };
}
async function ghPut(token, obj, sha) {
  const body = { message: "update usage (local)", content: Buffer.from(JSON.stringify(obj, null, 2)).toString("base64"), branch: "main" };
  if (sha) body.sha = sha;
  return fetch(GH_API, { method: "PUT", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "psycho-poller" }, body: JSON.stringify(body) });
}

async function main() {
  const keys = loadKeys();
  if (!Array.isArray(keys) || !keys.length) throw new Error("רשימת המפתחות ריקה");

  const fresh = [];
  for (const item of keys) {
    const hint = (item && item.hint) || "(ללא תווית)";
    try {
      const r = await syncOne(item.key);
      fresh.push(r);
      const nS = Array.isArray(r.sessions) ? r.sessions.length : "—";
      console.log(`✓ ${hint} → ${r.email}  (weeklyAll ${r.usage.weeklyAll?.pct ?? "?"}%, Fable ${r.usage.weeklyFable?.pct ?? "?"}%, Cowork ${nS})`);
    } catch (e) {
      console.log(`✗ ${hint}: ${(e && e.message) || e}`);
    }
  }
  if (!fresh.length) { console.log("אף חשבון לא סונכרן — לא נוגעים ב-usage.json."); process.exit(1); }

  if (!PUSH) {
    const raw = existsSync(STORE) ? readFileSync(STORE, "utf8") : null;
    const payload = merge(readStore(raw), fresh);
    writeFileSync(STORE, JSON.stringify(payload, null, 2));
    console.log(`✓ usage.json עודכן — ${fresh.length}/${keys.length} חשבונות סונכרנו, ${payload.accounts.length} בקובץ.`);
    return;
  }

  const token = loadToken();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { sha, raw } = await ghGet(token);
    const payload = merge(readStore(raw), fresh);
    const put = await ghPut(token, payload, sha);
    if (put.ok) { console.log(`✓ נדחף ל-GitHub — ${fresh.length}/${keys.length} חשבונות סונכרנו, ${payload.accounts.length} בקובץ.`); return; }
    if (put.status === 409) { console.log(`התנגשות (ניסיון ${attempt}) — מנסה שוב...`); continue; }
    console.log("כתיבה ל-GitHub נכשלה: " + put.status + " " + (await put.text()).slice(0, 160));
    process.exit(1);
  }
  console.log("נכשל אחרי 3 ניסיונות (התנגשויות).");
  process.exit(1);
}

main().catch((e) => { console.error("שגיאה כללית:", (e && e.message) || e); process.exit(1); });
