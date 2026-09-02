// Independent carousel distribution worker. Connects to the IG Master Airtable
// base (a different base than the generation worker uses) and allocates
// finished carousel content — one row per Style folder in the Carousel
// Distribution table — to eligible Instagram accounts.
//
// This is a fully separate system from IG Master's own allocate_ready_accounts.py
// (which drives the Ready to Post/reels pipeline): it never writes to Ready to
// Post, only reads it, purely to count each account's existing reel load so
// warm-up daily caps stay account-wide rather than per-content-type. It writes
// exclusively to its own Carousel Distribution table.
//
// Expected schema (create these yourself in the IG Master base — this script
// never creates tables or fields, only records):
//
//   IG Accounts (existing table, read-only here):
//     Status ("Warming" | "Active" | "Paused" | "Churned")
//     Model (link to Models)
//     Owner (link to Posters)
//     Warm-up Start (date)
//     Restriction Status (free text, e.g. "banned"/"restricted"/etc.)
//
//   Ready to Post (existing table, read-only here, just for quota counting):
//     IG Account (link), Scheduled For (date), Posted At (date), Status
//
//   Carousel Distribution (new table this script reads/writes):
//     Model (link to Models)
//     Batch Key (text — same value across a Carousel's reroll siblings, e.g.
//       "<Model>:Carousel 2", so Carousel 2 and Carousel 2_1 count as one
//       piece of content for dedup purposes)
//     Style (number 1-5, informational)
//     Drive Link (url — the Style folder the poster opens)
//     IG Account (link, filled in by this script)
//     Assigned Poster (link to Posters, filled in by this script)
//     Scheduled For (date, filled in by this script)
//     Status ("Unassigned" | "Scheduled" | "Posted" | "Failed")
//     Posted At (date, filled in by the poster)
//     IG Post URL (url, filled in by the poster)
//
// Populating Carousel Distribution with new Unassigned rows from finished
// carousel jobs is a separate step, not yet built — this script only handles
// matching existing Unassigned rows to accounts.

const Airtable = require("airtable");
const http = require("http");

const IG_MASTER_API_KEY = process.env.IG_MASTER_API_KEY;
const IG_MASTER_BASE_ID = process.env.IG_MASTER_BASE_ID;
const IG_ACCOUNTS_TABLE = process.env.IG_ACCOUNTS_TABLE || "IG Accounts";
const IG_MASTER_MODELS_TABLE = process.env.IG_MASTER_MODELS_TABLE || "Models";
const READY_TO_POST_TABLE = process.env.READY_TO_POST_TABLE || "Ready to Post";
const CAROUSEL_DIST_TABLE = process.env.CAROUSEL_DIST_TABLE || "Carousel Distribution";
const POLL_MS = Number(process.env.DISTRIBUTE_POLL_MS || 60000);
const PORT = process.env.DISTRIBUTE_PORT || process.env.PORT || 3001;

// Warm-up tiers, mirroring IG Master's own reels system: Warming accounts get
// zero posts until day WARMUP_POSTS_FROM_DAY of warm-up, then WARMUP_DAILY_POSTS/day.
// Active accounts get a flat ACTIVE_DAILY_POSTS/day. Both caps are shared across
// content types (reels + carousels count against the same daily budget).
const WARMUP_POSTS_FROM_DAY = Number(process.env.WARMUP_POSTS_FROM_DAY || 3);
const WARMUP_DAILY_POSTS = Number(process.env.WARMUP_DAILY_POSTS || 1);
const ACTIVE_DAILY_POSTS = Number(process.env.ACTIVE_DAILY_POSTS || 3);
const ALLOCATE_HORIZON_DAYS = Number(process.env.ALLOCATE_HORIZON_DAYS || 14);

const RESTRICTION_KEYWORDS = ["banned", "disabled", "action blocked", "restricted"];

const root = new Airtable({ apiKey: IG_MASTER_API_KEY }).base(IG_MASTER_BASE_ID);
const accountsTable = root(IG_ACCOUNTS_TABLE);
const modelsTable = root(IG_MASTER_MODELS_TABLE);
const distTable = root(CAROUSEL_DIST_TABLE);
const readyTable = root(READY_TO_POST_TABLE);

let busy = false;

// Reports, per Model, how many eligible accounts exist vs. how many have
// never received any carousel content at all (batchKeys empty) — the
// accounts most in need of fresh content for that Model.
async function buildNeedReport() {
  const [accounts, usage, modelRecords] = await Promise.all([
    loadEligibleAccounts(),
    buildUsage(),
    modelsTable.select({ maxRecords: 5000, fields: ["Name"] }).all()
  ]);

  const modelNames = new Map(modelRecords.map((m) => [m.id, m.get("Name") || m.id]));
  const byModel = new Map(); // modelId -> { model, total, needCarousel }

  for (const a of accounts) {
    const modelId = (a.get("Model") || [])[0];
    if (!modelId) continue;
    if (!byModel.has(modelId)) {
      byModel.set(modelId, { model: modelNames.get(modelId) || modelId, total: 0, needCarousel: 0 });
    }
    const m = byModel.get(modelId);
    m.total += 1;
    const u = usage.get(a.id);
    if (!u || u.batchKeys.size === 0) m.needCarousel += 1;
  }

  return {
    totalEligibleAccounts: accounts.length,
    byModel: [...byModel.values()].sort((x, y) => y.needCarousel - x.needCarousel)
  };
}

http.createServer((req, res) => {
  if (req.url === "/status") {
    buildNeedReport()
      .then((report) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(report, null, 2));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("error: " + e.message);
      });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok\n");
}).listen(PORT, () => console.log("http", PORT));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { attempts = 3, baseMs = 1000, label = "" } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      log("  retry", label, i + "/" + attempts, e.message);
      if (i < attempts) await sleep(baseMs * i);
    }
  }
  throw last;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function isRestricted(account) {
  const s = String(account.get("Restriction Status") || "").toLowerCase();
  return RESTRICTION_KEYWORDS.some((kw) => s.includes(kw));
}

function dailyCapFor(account, date) {
  const status = account.get("Status");
  if (status === "Active") return ACTIVE_DAILY_POSTS;
  if (status !== "Warming") return 0;
  const start = account.get("Warm-up Start");
  if (!start) return 0;
  const daysSinceStart = Math.floor((date - new Date(start)) / 86400000);
  return daysSinceStart >= WARMUP_POSTS_FROM_DAY ? WARMUP_DAILY_POSTS : 0;
}

async function loadEligibleAccounts() {
  const records = await accountsTable.select({
    filterByFormula: 'OR({Status}="Warming",{Status}="Active")',
    maxRecords: 5000
  }).all();
  return records.filter((a) => {
    const model = a.get("Model");
    return Array.isArray(model) && model.length && !isRestricted(a);
  });
}

async function loadUnassignedRows() {
  return distTable.select({
    filterByFormula: '{Status}="Unassigned"',
    sort: [{ field: "Batch Key", direction: "asc" }]
  }).all();
}

// Scans both the Carousel Distribution table (for its own batch-key dedup)
// and the Ready to Post table (read-only, just to count existing reel load)
// so daily quota is shared across both content types per account.
async function buildUsage() {
  const usage = new Map();
  const slot = (id) => {
    if (!usage.has(id)) usage.set(id, { byDay: new Map(), batchKeys: new Set() });
    return usage.get(id);
  };
  const bump = (id, day) => {
    const s = slot(id);
    s.byDay.set(day, (s.byDay.get(day) || 0) + 1);
  };

  const distRows = await distTable.select({
    filterByFormula: 'OR({Status}="Scheduled",{Status}="Posted")',
    maxRecords: 10000
  }).all();
  for (const r of distRows) {
    const acct = r.get("IG Account");
    if (!acct || !acct.length) continue;
    const date = r.get("Scheduled For") || r.get("Posted At");
    if (date) bump(acct[0], dayKey(new Date(date)));
    const bk = r.get("Batch Key");
    if (bk) slot(acct[0]).batchKeys.add(bk);
  }

  const readyRows = await readyTable.select({
    filterByFormula: 'OR({Status}="Scheduled",{Status}="Posted")',
    maxRecords: 10000,
    fields: ["IG Account", "Scheduled For", "Posted At"]
  }).all();
  for (const r of readyRows) {
    const acct = r.get("IG Account");
    if (!acct || !acct.length) continue;
    const date = r.get("Scheduled For") || r.get("Posted At");
    if (date) bump(acct[0], dayKey(new Date(date)));
  }

  return usage;
}

async function allocateOne(row, accounts, usage) {
  const model = row.get("Model");
  const modelId = Array.isArray(model) && model[0];
  const batchKey = row.get("Batch Key");
  if (!modelId || !batchKey) {
    log("skip row missing Model/Batch Key", row.id);
    return false;
  }

  const eligible = accounts.filter((a) => {
    const am = a.get("Model");
    return Array.isArray(am) && am[0] === modelId;
  });

  const today = new Date();
  let best = null;

  for (const account of eligible) {
    const u = usage.get(account.id) || { byDay: new Map(), batchKeys: new Set() };
    if (u.batchKeys.has(batchKey)) continue; // this account already has a variant of this carousel

    for (let d = 0; d < ALLOCATE_HORIZON_DAYS; d++) {
      const date = addDays(today, d);
      const cap = dailyCapFor(account, date);
      if (cap <= 0) continue;
      const day = dayKey(date);
      const used = u.byDay.get(day) || 0;
      if (used >= cap) continue;

      const totalLoad = [...u.byDay.values()].reduce((a, b) => a + b, 0);
      if (!best || totalLoad < best.totalLoad || (totalLoad === best.totalLoad && d < best.d)) {
        best = { account, day, totalLoad, d };
      }
      break; // first open day for this account is what we compare across accounts
    }
  }

  if (!best) {
    log("no eligible slot", row.id, "batchKey", batchKey);
    return false;
  }

  await withRetry(() => distTable.update(row.id, {
    "IG Account": [best.account.id],
    "Assigned Poster": best.account.get("Owner") || [],
    "Scheduled For": best.day,
    Status: "Scheduled"
  }, { typecast: true }), { label: "assign " + row.id });

  log("ASSIGNED", row.id, "->", best.account.get("Handle") || best.account.id, best.day);

  const u = usage.get(best.account.id) || { byDay: new Map(), batchKeys: new Set() };
  u.byDay.set(best.day, (u.byDay.get(best.day) || 0) + 1);
  u.batchKeys.add(batchKey);
  usage.set(best.account.id, u);

  return true;
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const [accounts, rows] = await Promise.all([loadEligibleAccounts(), loadUnassignedRows()]);
    if (!rows.length) {
      log("idle");
      return;
    }
    const usage = await buildUsage();
    let assigned = 0;
    for (const row of rows) {
      if (await allocateOne(row, accounts, usage)) assigned += 1;
    }
    log("cycle", assigned, "/", rows.length, "assigned");
  } catch (e) {
    log("poll", e.message);
  } finally {
    busy = false;
  }
}

log("distributor", {
  base: IG_MASTER_BASE_ID,
  distTable: CAROUSEL_DIST_TABLE,
  at: !!IG_MASTER_API_KEY
});
setInterval(poll, POLL_MS);
poll();
