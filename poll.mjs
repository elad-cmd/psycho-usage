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
/* כמה שיחות Cowork נשמרות לכל חשבון ב-usage.json.
   היה 5 — ויוזר עם יותר מחמש שיחות היה מפיל שיחה מגל 0 בדשבורד
   (הרשימה נחתכת כאן, כך שהדשבורד פשוט לא רואה אותה).
   8.12 (אלעד 09.08): הועלה מ-10 ל-50 — טאב «שיחות לפי יוזר» בדשבורד מציג
   עכשיו את כל ההיסטוריה, כולל שיחות סגורות, וההיסטוריה נחתכת רק כאן.
   בדשבורד עצמו MAX_SESSIONS=10 נשאר תקרת-תצוגה לכרטיסי היוזרים בלבד. */
const MAX_SESSIONS = 50;
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
async function fetchCoworkSessions(sk, orgUuids) {
  // 8.23: מקבל את *כל* הארגונים של החשבון וסורק את כולם — היו חשבונות (elad362, info)
  // שה-usage שלהם עבד אבל השיחות ישבו בארגון אחר מזה שנבחר, והרשימה חזרה ריקה.
  if (!Array.isArray(orgUuids)) orgUuids = orgUuids ? [orgUuids] : [];
  if (!orgUuids.length) return null;
  const V1 = { "anthropic-version": "2023-06-01" };
  const byId = new Map();
  let anyOk = false;
  for (const orgUuid of orgUuids) {
    const COOKIES = "lastActiveOrg=" + orgUuid;
    for (const tag of COWORK_TAGS) {
      try {
        const res = await claudeGet(`/v1/code/sessions?limit=${MAX_SESSIONS + 3}&tags=${encodeURIComponent(tag)}`, sk, V1, COOKIES);
        anyOk = true;
        for (const s of (res && res.data) || []) if (s && s.id) { dumpSessionShape(s); byId.set(s.id, s); }
      } catch (e) {
        console.log(`   · ארגון ${String(orgUuid).slice(0, 8)} תגית ${tag}: ${(e && e.message) || e}`);
      }
    }
  }
  // 8.24: נפילה-לאחור — יש חשבונות (M4/M5) שהשיחות שלהם חוזרות ריקות בסינון תגיות
  // (כנראה אפליקציה שלא מתייגת). אם לא נמצא כלום — שולפים בלי תגיות וממזגים.
  if (!byId.size) {
    for (const orgUuid of orgUuids) {
      const COOKIES = "lastActiveOrg=" + orgUuid;
      try {
        const res = await claudeGet(`/v1/code/sessions?limit=${MAX_SESSIONS + 3}`, sk, V1, COOKIES);
        anyOk = true;
        for (const s of (res && res.data) || []) if (s && s.id) { dumpSessionShape(s); byId.set(s.id, s); }
      } catch (e) {
        console.log(`   · ללא-תגיות ארגון ${String(orgUuid).slice(0, 8)}: ${(e && e.message) || e}`);
      }
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
      if (s.created_at) rec.c = s.created_at;                        // 8.14 — בר משך הביצוע בדשבורד
      if (s.worker_status) rec.ws = String(s.worker_status).slice(0, 24); // 8.14 — כחול=רצה עכשיו
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
  const sessions = await fetchCoworkSessions(sk, orgs.map((o) => o.uuid));
  return { email, usage, sessions };
}

/* קריאת המאגר הקיים. ההבחנה כאן קריטית:
   קובץ שלא קיים → מתחילים מה-SEED (הקמה ראשונה).
   קובץ פגום     → זורקים שגיאה ולא כותבים כלום. אסור להתחיל מרשימה ריקה,
                   כי אז כל חשבון שהמפתח שלו מת באותו רגע נמחק מהקובץ ו"נעלם"
                   מהדשבורד עד שהמפתח שלו יחזור לעבוד. */
/* 8.42 — savedAt של הכתיבה הקודמת: חלון הדגימה למדידת עבודה-בפועל. */
function readPrevSavedAt(raw) {
  try { const b = JSON.parse(raw); return (b && typeof b.savedAt === "number") ? b.savedAt : 0; }
  catch { return 0; }
}
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

function merge(accounts, fresh, prevSavedAt) {
  const now = Date.now();
  ensureRoster(accounts);
  /* 8.42 — מדידת עבודה-בפועל, בשיטת «מדידת זמני עבודה אמיתיים» (דוח 11.08):
     ev שהתקדם בין שתי כתיבות = השיחה עבדה בחלון הזה; wm (דקות) צובר.
     ev קפוא = שינה/המתנה — לא נספר. חור ארוך בין כתיבות נספר עד 25 דק'. */
  const winMin = prevSavedAt ? Math.round(Math.min(Math.max(now - prevSavedAt, 0), 25 * 60e3) / 60000) : 0;
  for (const r of fresh) {
    let acc = accounts.find((a) => (a.label || "").toLowerCase().trim() === r.email.toLowerCase().trim());
    if (!acc) {
      acc = { id: "acc-" + r.email.replace(/[^a-z0-9]/gi, "").slice(0, 14), label: r.email, plan: "Max (20x)", notes: "", sessions: [] };
      accounts.push(acc);
    }
    acc.usage = carryUsage(acc.usage, r.usage, now);
    acc.lastSyncAt = now;
    acc.updatedAt = now;
    if (Array.isArray(r.sessions)) {
      const prevByU = {};
      for (const x of acc.sessions || []) if (x && x.u) prevByU[x.u] = x;
      for (const s of r.sessions) {
        const old = s && s.u ? prevByU[s.u] : null;
        let wm = (old && typeof old.wm === "number") ? old.wm : 0;
        if (winMin > 0 && old && old.ev && s.ev && old.ev !== s.ev) wm += winMin;
        if (wm > 0) s.wm = wm;
      }
      acc.sessions = r.sessions; // רק אם באמת נמשכו — אחרת משאירים את הקודמות
    }
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
  // 8.40: redirect:"manual" — אם ה-repo שונה-שם/הועבר, GitHub מחזיר 3xx, ו-fetch
  // היה הופך PUT מופנה ל-GET ומחזיר 200 «הצלחה» ריקה שלא כותבת דבר (זה מקור ה-main
  // הקפוא). עכשיו 3xx נשאר 3xx (put.ok=false) ונתפס ככישלון רועש למטה.
  return fetch(GH_API, { method: "PUT", redirect: "manual", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "psycho-poller" }, body: JSON.stringify(body) });
}

/* 8.16 — מושבים ופיד דואר מהדיסק המשותף (טאב היוזרים בדשבורד).
   קריאה בלבד; כשל כאן לעולם לא מפיל את סנכרון המכסות. */
import { readdirSync, statSync } from "node:fs";
const SHARED = "C:\\PsychoShared";
function collectMetrics() {
  try { return JSON.parse(readFileSync("C:\\PsychoShared\\05_state\\metrics.json", "utf8")); } catch (e) { return null; }
}
function collectBookStates() {
  // 8.26: הערכת התקדמות גסה למטריצת הספרים — נקרא מקבצי ה-state של השיחות.
  const out = {};
  try {
    const dir = "C:\\PsychoShared\\05_state\\sessions";
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(`${dir}\\${f}`, "utf8"));
        const fin = (d && d.findings) || {};
        const eq = (d && d.eladQueue) || null;
        out[f.replace(/\.json$/, "")] = {
          round: (d && d.round) ? String(d.round).slice(0, 120) : null,
          total: typeof fin.total === "number" ? fin.total : null,
          applied: typeof fin.applied === "number" ? fin.applied : null,
          am: typeof fin.appliedMaster === "number" ? fin.appliedMaster : null, // 8.40 (פריט 8) — מונה «הוחל על המאסטר», נפרד מעותק העבודה
          at: (d && d.updatedAt) || null,
          eladQ: eq && typeof eq.remaining === "number" ? { r: eq.remaining, i: (typeof eq.initial === "number" ? eq.initial : null), n: eq.note ? String(eq.note).slice(0, 90) : null } : null,
          vb: (d && d.verifyBatches && typeof d.verifyBatches.done === "number") ? { d: d.verifyBatches.done, t: d.verifyBatches.total } : null,
        };
      } catch (e) { /* קובץ פגום — מדלגים */ }
    }
  } catch (e) { /* אין תיקייה — משאירים ריק */ }
  return out;
}
function collectSeats() {
  const out = {};
  try {
    const dir = SHARED + "\\05_state\\seats";
    for (const f of readdirSync(dir)) {
      if (!/^(M[1-6]|X1|MICHAL)\.json$/.test(f)) continue;
      try { out[f.slice(0, -5)] = JSON.parse(readFileSync(dir + "\\" + f, "utf8")); } catch {}
    }
  } catch {}
  return out;
}
function parseMailName(name) {
  const m = /^(.+?)--(\d{8})-(\d{4})--(.+)\.md$/.exec(name);
  if (!m) return null;
  const [, from, d, t, subj] = m;
  return { from, at: `${d.slice(6, 8)}.${d.slice(4, 6)} ${t.slice(0, 2)}:${t.slice(2)}`,
           stamp: d + t, subject: subj.slice(0, 90) };
}
function collectMailFeed() {
  const out = {};
  for (let n = 1; n <= 6; n++) {
    const M = "M" + n, feed = [];
    try {
      for (const f of readdirSync(`${SHARED}\\07_mail\\to_${M}`)) {
        const e = parseMailName(f); if (e) feed.push({ ...e, dir: "אל", _p: `${SHARED}\\07_mail\\to_${M}\\${f}` });
      }
    } catch {}
    try {
      for (const f of readdirSync(`${SHARED}\\07_mail\\_to_manager`)) {
        if (!f.startsWith(M + "--")) continue;
        const e = parseMailName(f); if (e) feed.push({ ...e, dir: "מאת" });
      }
    } catch {}
    feed.sort((a, b) => (b.stamp < a.stamp ? -1 : 1));
    out[M] = feed.slice(0, 5).map(({ stamp, _p, ...rest }) => {
      // 8.31: לאיזו שיחה ממוען מכתב מנהל — כדי שדגל «לא זזה» יידלק רק על שיחה שמחכים לה
      if (_p && rest.dir === "אל") {
        try {
          const head = readFileSync(_p, "utf8").slice(0, 400);
          const mm = head.match(/^אל:\s*(.+)$/m);
          if (mm) rest.to = mm[1].trim().slice(0, 80);
        } catch {}
      }
      return rest;
    });
  }
  return out;
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

  const seats = collectSeats(), mailFeed = collectMailFeed();

  if (!PUSH) {
    const raw = existsSync(STORE) ? readFileSync(STORE, "utf8") : null;
    const payload = merge(readStore(raw), fresh, raw ? readPrevSavedAt(raw) : 0);
    payload.seats = seats; payload.mailFeed = mailFeed;
  payload.bookStates = collectBookStates();
    payload.metrics = collectMetrics();
    writeFileSync(STORE, JSON.stringify(payload, null, 2));
    console.log(`✓ usage.json עודכן — ${fresh.length}/${keys.length} חשבונות סונכרנו, ${payload.accounts.length} בקובץ.`);
    return;
  }

  const token = loadToken();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { sha, raw } = await ghGet(token);
    const payload = merge(readStore(raw), fresh, raw ? readPrevSavedAt(raw) : 0);
    payload.seats = seats; payload.mailFeed = mailFeed;
    payload.bookStates = collectBookStates();
    payload.metrics = collectMetrics(); // 8.30 — גם במסלול הדחיפה (מוני eladQ והברים החיים)
    try { writeFileSync(STORE, JSON.stringify(payload, null, 2)); } catch {} // 8.16 — עותק מקומי גם בדחיפה (למעקב המנהל)
    const put = await ghPut(token, payload, sha);
    if (put.ok) {
      // 8.40: אימות-אחרי-כתיבה. «נדחף ✓» לבדו שיקר בעבר — הדחיפה חזרה 200 וה-main
      // נשאר קפוא. מאמתים שה-savedAt שכתבנו באמת יושב עכשיו ב-main לפני שמכריזים הצלחה.
      let landed = false, gotSavedAt = null;
      try {
        const chk = await ghGet(token);
        const got = chk && chk.raw ? JSON.parse(chk.raw) : null;
        gotSavedAt = got && got.savedAt;
        landed = !!(got && got.savedAt === payload.savedAt);
      } catch (e) { console.log("⚠ אימות-אחרי-כתיבה נכשל: " + ((e && e.message) || e)); }
      if (landed) { console.log(`✓ נדחף ל-GitHub ואומת — ${fresh.length}/${keys.length} חשבונות סונכרנו, ${payload.accounts.length} בקובץ.`); return; }
      console.log(`✗ הדחיפה החזירה ${put.status} אך main לא מציג את הכתיבה (savedAt ב-main: ${gotSavedAt}, ציפינו: ${payload.savedAt}). בדוק שם/כתובת ה-repo וההרשאות. יוצא בכישלון כדי שזה לא יישאר שקט.`);
      process.exit(1);
    }
    if (put.status === 409) { console.log(`התנגשות (ניסיון ${attempt}) — מנסה שוב...`); continue; }
    if (put.status >= 300 && put.status < 400) { console.log(`✗ GitHub הפנה את ה-PUT (status ${put.status}) — כמעט תמיד repo ששונה-שם/הועבר. כתובת ה-API: ${GH_API}. תקן OWNER/REPO והרשאות.`); process.exit(1); }
    console.log("כתיבה ל-GitHub נכשלה: " + put.status + " " + (await put.text()).slice(0, 160));
    process.exit(1);
  }
  console.log("נכשל אחרי 3 ניסיונות (התנגשויות).");
  process.exit(1);
}

main().catch((e) => { console.error("שגיאה כללית:", (e && e.message) || e); process.exit(1); });
