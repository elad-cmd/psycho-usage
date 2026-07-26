/**
 * פסיכו — פולר מכסות (Node) · רץ ב-GitHub Actions וגם מקומית
 * קורא usage אמיתי צד-שרת מ-claude.ai (בלי דפדפן/CORS) וכותב usage.json.
 * מפתחות: SESSION_KEYS (Secret) או keys.json מקומי. שומר label/plan/notes/sessions.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "usage.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function loadKeys() {
  if (process.env.SESSION_KEYS) return JSON.parse(process.env.SESSION_KEYS);
  return JSON.parse(readFileSync(join(HERE, "keys.json"), "utf8"));
}
async function claudeGet(path, sk) {
  const r = await fetch("https://claude.ai" + path, {
    method: "GET",
    headers: {
      Cookie: "sessionKey=" + sk, Accept: "application/json", "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
      "anthropic-client-platform": "web_claude_ai", Referer: "https://claude.ai/",
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + text.slice(0, 120));
  try { return JSON.parse(text); }
  catch { throw new Error(path + " -> לא-JSON (דף אתגר/התחברות): " + text.slice(0, 120)); }
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
  const usage = { session: pick("session"), weeklyAll: pick("weekly_all"),
    weeklyFable: pick("weekly_scoped") || pick("weekly_all") };
  if (!usage.weeklyAll && !usage.weeklyFable) throw new Error("ה-usage לא כלל weekly");
  let sessions = null;
  try {
    const convos = await claudeGet("/api/organizations/" + org.uuid + "/chat_conversations", sk);
    if (Array.isArray(convos)) {
      sessions = convos
        .slice()
        .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
        .slice(0, 5)
        .map((c) => ({ t: (c.name && c.name.trim()) || "(שיחה ללא שם)", u: "https://claude.ai/chat/" + c.uuid }));
    }
  } catch (e) { sessions = null; }
  return { email, usage, sessions };
}
async function main() {
  const keys = loadKeys();
  if (!Array.isArray(keys) || !keys.length) throw new Error("רשימת המפתחות ריקה");
  const fresh = [];
  for (const item of keys) {
    const hint = (item && item.hint) || "(ללא תווית)";
    try {
      const r = await syncOne(item.key); fresh.push(r);
      console.log(`✓ ${hint} → ${r.email}  (weeklyAll ${r.usage.weeklyAll?.pct ?? "?"}%, Fable ${r.usage.weeklyFable?.pct ?? "?"}%)`);
    } catch (e) { console.log(`✗ ${hint}: ${(e && e.message) || e}`); }
  }
  if (!fresh.length) { console.log("אף חשבון לא סונכרן — לא נוגעים ב-usage.json."); process.exit(1); }
  let blob = null;
  if (existsSync(STORE)) { try { blob = JSON.parse(readFileSync(STORE, "utf8")); } catch {} }
  const accounts = blob && Array.isArray(blob.accounts) ? blob.accounts : [];
  const now = Date.now();
  for (const r of fresh) {
    let acc = accounts.find((a) => (a.label || "").toLowerCase().trim() === r.email.toLowerCase().trim());
    if (!acc) { acc = { id: "acc-" + r.email.replace(/[^a-z0-9]/gi, "").slice(0, 14), label: r.email, plan: "Max (20x)", notes: "", sessions: [] }; accounts.push(acc); }
    acc.usage = r.usage; acc.lastSyncAt = now; acc.updatedAt = now;
    if (Array.isArray(r.sessions)) acc.sessions = r.sessions;
  }
  writeFileSync(STORE, JSON.stringify({ v: 2, savedAt: now, savedBy: "poller:github", accounts }, null, 2));
  console.log(`✓ usage.json עודכן — ${fresh.length}/${keys.length} חשבונות סונכרנו.`);
}
main().catch((e) => { console.error("שגיאה כללית:", e); process.exit(1); });
