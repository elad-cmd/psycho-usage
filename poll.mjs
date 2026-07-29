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
  { id: "acc-elad",         label: "elad@psycho.co.il" },
  { id: "acc-elad362",      label: "elad362@gmail.com" },
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
      for (const s of (res && res.data) || []) if (s && s.id) byId.set(s.id, s);
    } catch (e) {
      console.log(`   · תגית ${tag}: ${(e && e.message) || e}`);
    }
  }
  if (!anyOk) return null;
  return [...byId.values()]
    .sort((a, b) => new Date(b.last_event_at || 0) - new Date(a.last_event_at || 0))
    .slice(0, MAX_SESSIONS)
    .map((s) => ({
      t: (s.title && String(s.title).trim()) || "(שיחה ללא שם)",
      u: "https://claude.ai/cowork/" + s.id,
    }));
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
  if (!usage.weeklyAll && !usage.weeklyFable) throw new Error("ה-usage לא כלל weekly");
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

function merge(accounts, fresh) {
  const now = Date.now();
  for (const r of fresh) {
    let acc = accounts.find((a) => (a.label || "").toLowerCase().trim() === r.email.toLowerCase().trim());
    if (!acc) {
      acc = { id: "acc-" + r.email.replace(/[^a-z0-9]/gi, "").slice(0, 14), label: r.email, plan: "Max (20x)", notes: "", sessions: [] };
      accounts.push(acc);
    }
    acc.usage = r.usage;
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
