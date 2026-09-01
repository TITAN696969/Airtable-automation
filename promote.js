// Promote step: bridges the carousel generator (this repo's own Airtable base
// + Drive) to the IG Master base's Carousel Distribution table. Watches for
// carousel jobs that are Done AND manually marked Creative Approved, and for
// each one creates an Unassigned Carousel Distribution row per existing Style
// folder — the actual distributable units that distribute.js then allocates
// to accounts.
//
// This never touches distribute.js's allocation logic or IG Master's own
// reels pipeline — it only ever creates fresh Unassigned rows.
//
// New fields required on the carousel generator's own Jobs table (create
// these yourself, same as Drive Folder / Reroll Of earlier):
//   Creative Approved (checkbox) — human review gate, you check this by hand
//     once you're happy with a Done carousel and want it distributable.
//   Promoted (checkbox) — written by this script once a carousel has been
//     turned into Distribution rows, so it's never promoted twice. Don't
//     check this yourself.
//
// Reuses the same AIRTABLE_* and GOOGLE_*/DRIVE_* env vars as index.js (point
// this at the same env group and it just works), plus the same IG_MASTER_*
// env vars as distribute.js, plus IG_MASTER_MODELS_TABLE to resolve a model
// name into that base's own Models record for linking.

const Airtable = require("airtable");
const http = require("http");
const { google } = require("googleapis");

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "app7381NQaLvJhj2Y";
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblZLPqHrhyAIGHW9";
const MODELS_TABLE = process.env.AIRTABLE_MODELS_TABLE || "Models";
const DRIVE_LINK_FIELD = process.env.DRIVE_LINK_FIELD || "Drive Folder";
const APPROVED_FIELD = process.env.APPROVED_FIELD || "Creative Approved";
const PROMOTED_FIELD = process.env.PROMOTED_FIELD || "Promoted";

const IG_MASTER_API_KEY = process.env.IG_MASTER_API_KEY;
const IG_MASTER_BASE_ID = process.env.IG_MASTER_BASE_ID;
const IG_MASTER_MODELS_TABLE = process.env.IG_MASTER_MODELS_TABLE || "Models";
const CAROUSEL_DIST_TABLE = process.env.CAROUSEL_DIST_TABLE || "Carousel Distribution";

const DRIVE_AUTH_MODE = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? "service_account"
  : (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN)
    ? "oauth"
    : null;

const POLL_MS = Number(process.env.PROMOTE_POLL_MS || 2 * 60 * 1000);
const PORT = process.env.PROMOTE_PORT || process.env.PORT || 3002;

const jobs = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID)(TABLE_ID);
const models = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID)(MODELS_TABLE);
const igModels = new Airtable({ apiKey: IG_MASTER_API_KEY }).base(IG_MASTER_BASE_ID)(IG_MASTER_MODELS_TABLE);
const distTable = new Airtable({ apiKey: IG_MASTER_API_KEY }).base(IG_MASTER_BASE_ID)(CAROUSEL_DIST_TABLE);

let busy = false;

http.createServer((req, res) => {
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

let driveClient = null;
function getDrive() {
  if (driveClient) return driveClient;
  let auth;
  if (DRIVE_AUTH_MODE === "service_account") {
    const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8"));
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] });
  } else if (DRIVE_AUTH_MODE === "oauth") {
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    auth = oauth2;
  } else {
    throw new Error("no Drive credentials configured");
  }
  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

function driveFolderIdFromLink(link) {
  const m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(String(link || ""));
  return m ? m[1] : null;
}

async function getFolderName(folderId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId: folderId, fields: "name", supportsAllDrives: true });
  return res.data.name || "";
}

async function findStyleFolder(carouselFolderId, n) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: "name='Style " + n + "' and '" + carouselFolderId + "' in parents" +
      " and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives"
  });
  const f = res.data.files && res.data.files[0];
  return f ? f.id : null;
}

async function styleFolderHasFiles(folderId) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: "'" + folderId + "' in parents and trashed=false",
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives"
  });
  return !!(res.data.files && res.data.files.length);
}

const modelCache = new Map(); // model name -> IG Master Models record id (or null)

async function findIgMasterModelId(name) {
  if (modelCache.has(name)) return modelCache.get(name);
  const safe = String(name).replace(/'/g, "\\'");
  const found = await igModels.select({
    filterByFormula: "{Name}='" + safe + "'",
    maxRecords: 1
  }).firstPage();
  const id = found.length ? found[0].id : null;
  modelCache.set(name, id);
  return id;
}

// Strips a "_M" reroll suffix so Carousel 2 and Carousel 2_1 share a batch key.
function baseCarouselName(folderName) {
  return folderName.replace(/_\d+$/, "");
}

async function promoteOne(record) {
  const id = record.id;
  const driveLink = record.get(DRIVE_LINK_FIELD);
  const carouselFolderId = driveFolderIdFromLink(driveLink);
  if (!carouselFolderId) throw new Error("no Drive Folder link on this record");

  const linked = record.get("Model") || [];
  if (!linked.length) throw new Error("no Model linked");
  const modelRec = await models.find(linked[0]);
  const modelName = modelRec.get("Name") || linked[0];

  const igModelId = await findIgMasterModelId(modelName);
  if (!igModelId) throw new Error('no matching Model named "' + modelName + '" in IG Master');

  const carouselName = await getFolderName(carouselFolderId);
  const batchKey = modelName + ":" + baseCarouselName(carouselName);

  let created = 0;
  for (let n = 1; n <= 5; n++) {
    const styleFolderId = await findStyleFolder(carouselFolderId, n);
    if (!styleFolderId) continue;
    if (!(await styleFolderHasFiles(styleFolderId))) continue;

    await withRetry(() => distTable.create({
      Model: [igModelId],
      "Batch Key": batchKey,
      Style: n,
      "Drive Link": "https://drive.google.com/drive/folders/" + styleFolderId,
      Status: "Unassigned"
    }, { typecast: true }), { label: "create dist row " + id + " style " + n });
    created += 1;
  }

  if (!created) throw new Error("no Style folders with files found under " + driveLink);

  await withRetry(() => jobs.update(id, { [PROMOTED_FIELD]: true }, { typecast: true }), { label: "mark promoted " + id });
  log("PROMOTED", id, batchKey, created, "rows");
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const found = await jobs.select({
      filterByFormula: 'AND({Status}="Done", {' + APPROVED_FIELD + '}=1, {' + PROMOTED_FIELD + '}!=1)',
      maxRecords: 10
    }).firstPage();

    if (!found.length) {
      log("idle");
      return;
    }

    for (const record of found) {
      try {
        await promoteOne(record);
      } catch (e) {
        log("FAIL promote", record.id, e.message);
      }
    }
  } catch (e) {
    log("poll", e.message);
  } finally {
    busy = false;
  }
}

log("promoter", {
  base: BASE_ID,
  igMasterBase: IG_MASTER_BASE_ID,
  distTable: CAROUSEL_DIST_TABLE,
  drive: !!DRIVE_AUTH_MODE
});
setInterval(poll, POLL_MS);
poll();
