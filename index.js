const Airtable = require("airtable");
const fetch = require("node-fetch");
const http = require("http");
const sharp = require("sharp");
const crypto = require("crypto");
const { Readable } = require("stream");
const { google } = require("googleapis");

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "app7381NQaLvJhj2Y";
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblZLPqHrhyAIGHW9";
const MODELS_TABLE = process.env.AIRTABLE_MODELS_TABLE || "Models";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-image"; // Nano Banana (Flash) — faster than Pro, lower max resolution
const POLL_MS = Number(process.env.POLL_MS || 15000);
const STALE_MS = Number(process.env.STALE_MS || 20 * 60 * 1000);
const PORT = process.env.PORT || 3000;
const WORKER_ID = crypto.randomUUID();

// Drive uploads are optional. Two auth modes, pick one:
//   - Service account: set GOOGLE_SERVICE_ACCOUNT_JSON (the key JSON, base64-encoded)
//     and point DRIVE_ROOT_FOLDER_ID at a folder inside a Shared Drive the service
//     account's client_email has been added to (Content Manager+). Fully headless.
//   - OAuth as yourself: set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and
//     GOOGLE_OAUTH_REFRESH_TOKEN (from scripts/drive-oauth-setup.js, run once locally),
//     and point DRIVE_ROOT_FOLDER_ID at any regular folder in your own Drive. Uploads
//     use your personal quota, no Shared Drive needed.
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || "";
const DRIVE_AUTH_MODE = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? "service_account"
  : (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN)
    ? "oauth"
    : null;
const DRIVE_ENABLED = !!(DRIVE_AUTH_MODE && DRIVE_ROOT_FOLDER_ID);
// Airtable field the per-job Drive folder link gets written into. Must already
// exist in the table (as a URL or single-line text field) — Airtable rejects
// writes to unknown field names, which patch() just logs and moves past.
const DRIVE_LINK_FIELD = process.env.DRIVE_LINK_FIELD || "Drive Folder";

const LOOKS = {
  2: { name: "warm-sun", modulate: { brightness: 1.03, saturation: 1.07, hue: 5 }, linear: [1.05, 2], gamma: 1.02 },
  3: { name: "cool-clean", modulate: { brightness: 1.02, saturation: 0.93, hue: -7 }, linear: [1.06, 0] },
  4: { name: "soft-matte", modulate: { brightness: 1.03, saturation: 0.94, hue: 2 }, linear: [0.86, 16], gamma: 1.05 },
  5: { name: "crisp-editorial", modulate: { brightness: 1.02, saturation: 1.05, hue: -1 }, linear: [1.1, -3], sharpen: { sigma: 0.7 } }
};

const root = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);
const jobs = root(TABLE_ID);
const models = root(MODELS_TABLE);
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

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function atts(record, wanted) {
  const want = norm(wanted);
  for (const name of Object.keys(record.fields || {})) {
    if (norm(name) !== want) continue;
    const v = record.fields[name];
    if (Array.isArray(v) && v[0] && v[0].url) return v;
  }
  return [];
}

let driveClient = null;
function getDrive() {
  if (!DRIVE_ENABLED) return null;
  if (driveClient) return driveClient;
  let auth;
  if (DRIVE_AUTH_MODE === "service_account") {
    const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8"));
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] });
  } else {
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    auth = oauth2;
  }
  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

function safeFolderName(s) {
  return String(s || "").replace(/[\/\\]/g, "-").trim().slice(0, 200) || "Untitled";
}

function jobLabel(record) {
  const fields = record.fields || {};
  for (const key of Object.keys(fields)) {
    const n = norm(key);
    if (n !== "name" && n !== "title" && n !== "jobname") continue;
    const v = fields[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return record.id;
}

async function getModelName(record) {
  const linked = record.get("Model") || [];
  if (!linked.length) return null;
  try {
    const modelRec = await models.find(linked[0]);
    return modelRec.get("Name") || linked[0];
  } catch (e) {
    log("drive model lookup fail", e.message);
    return null;
  }
}

const folderCache = new Map();

async function getOrCreateFolder(name, parentId) {
  const key = parentId + "::" + name;
  if (folderCache.has(key)) return folderCache.get(key);
  const p = (async () => {
    const drive = getDrive();
    const q = "name='" + name.replace(/'/g, "\\'") + "' and '" + parentId + "' in parents" +
      " and mimeType='application/vnd.google-apps.folder' and trashed=false";
    const found = await drive.files.list({
      q,
      fields: "files(id,name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives"
    });
    if (found.data.files && found.data.files.length) return found.data.files[0].id;
    const created = await drive.files.create({
      requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
      fields: "id",
      supportsAllDrives: true
    });
    return created.data.id;
  })();
  folderCache.set(key, p);
  p.catch(() => folderCache.delete(key)); // don't let a transient failure poison the cache forever
  return p;
}

// Resolves (and creates if needed) the "<Model>/<Job>" Drive folder for a record.
// Never throws — Drive is a best-effort side channel alongside Airtable uploads.
async function resolveDriveFolder(record) {
  if (!DRIVE_ENABLED) return null;
  try {
    const modelName = await getModelName(record);
    const modelFolder = await getOrCreateFolder(safeFolderName(modelName || "Unassigned"), DRIVE_ROOT_FOLDER_ID);
    return await getOrCreateFolder(safeFolderName(jobLabel(record)), modelFolder);
  } catch (e) {
    log("drive folder fail", e.message);
    return null;
  }
}

async function uploadToDrive(folderId, filename, buffer, mimeType) {
  if (!folderId) return;
  try {
    const drive = getDrive();
    await withRetry(() => drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: mimeType || "image/jpeg", body: Readable.from(buffer) },
      fields: "id",
      supportsAllDrives: true
    }), { label: "drive upload " + filename });
    log("  drive uploaded", filename);
  } catch (e) {
    log("  drive upload skip", filename, e.message);
  }
}

async function patch(id, fields) {
  try {
    await withRetry(() => jobs.update(id, fields), { label: "patch " + Object.keys(fields).join(",") });
    return true;
  } catch (e) {
    log("patch fail", Object.keys(fields).join(","), e.message);
    return false;
  }
}

async function note(id, text) {
  log("NOTE", text);
  await patch(id, { Notes: String(text).slice(0, 900) });
}

async function getBuf(url) {
  const r = await fetch(url, { timeout: 45000 });
  if (!r.ok) throw new Error("download " + r.status);
  return r.buffer();
}

async function smallJpeg(url, max) {
  const raw = await getBuf(url);
  const out = await sharp(raw, { failOn: "none" })
    .rotate()
    .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  log("  resized", raw.length, "->", out.length);
  return out;
}

function extractImage(data) {
  for (const p of data?.candidates?.[0]?.content?.parts || []) {
    const x = p.inlineData || p.inline_data;
    if (x && x.data) return { data: x.data, mime: x.mimeType || x.mime_type || "image/png" };
  }
  return null;
}

async function callGemini(parts) {
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 90000,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["IMAGE"] }
      })
    }
  );
  const json = await r.json();
  return { ok: r.ok, status: r.status, json };
}

async function generateOne(modelRefs, scene, prompt, i, total) {
  const parts = [];
  for (const att of modelRefs.slice(0, 2)) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: (await smallJpeg(att.url, 768)).toString("base64") } });
  }
  if (scene) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: (await smallJpeg(scene.url, 1024)).toString("base64") } });
  }
  parts.push({
    text: "You are an expert image editor. Recreate the scene from the last reference photo. The person must match the first reference photos. Photorealistic, natural skin, high quality. Image " + i + " of " + total + ". " + (prompt || "")
  });

  const MAX_ATTEMPTS = 3;
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log("  Gemini", i, "try", attempt);
    const t = Date.now();
    try {
      const res = await callGemini(parts);
      log("  Gemini", res.status, ((Date.now() - t) / 1000).toFixed(1) + "s");
      if (!res.ok) {
        last = new Error("Gemini " + res.status + " " + JSON.stringify(res.json).slice(0, 240));
        if (attempt < MAX_ATTEMPTS) await sleep(res.status === 429 ? 15000 * attempt : 2000 * attempt);
        continue;
      }
      const img = extractImage(res.json);
      if (!img) {
        last = new Error("no image " + JSON.stringify(res.json).slice(0, 240));
        if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
        continue;
      }
      return img;
    } catch (e) {
      last = e;
      log("  Gemini err", e.message);
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
    }
  }
  throw last || new Error("Gemini failed");
}

async function upload(recordId, field, b64, filename, type) {
  const url = "https://content.airtable.com/v0/" + BASE_ID + "/" + recordId + "/" + encodeURIComponent(field) + "/uploadAttachment";
  await withRetry(async () => {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + AIRTABLE_API_KEY, "Content-Type": "application/json" },
      timeout: 60000,
      body: JSON.stringify({ contentType: type || "image/jpeg", file: b64, filename })
    });
    const txt = await r.text();
    if (!r.ok) throw new Error("upload " + field + " " + r.status + " " + txt.slice(0, 160));
    log("  uploaded", field, filename);
  }, { baseMs: 1500, label: "upload " + field });
}

async function applyLook(buffer, look) {
  let img = sharp(buffer, { failOn: "none" }).rotate();
  if (look.modulate) img = img.modulate(look.modulate);
  if (look.linear) img = img.linear(look.linear[0], look.linear[1]);
  if (look.gamma) img = img.gamma(look.gamma);
  if (look.sharpen) img = img.sharpen(look.sharpen);
  return img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function fillStyledOutputs(id, buffers, driveFolder) {
  if (!buffers.length) throw new Error("nothing to style");
  log("styling", buffers.length, "into Output 2-5");
  let saved = 0;
  for (const n of [2, 3, 4, 5]) {
    const look = LOOKS[n];
    const field = "Output " + n;
    log("look", field, look.name);
    await patch(id, { [field]: [] });
    for (let i = 0; i < buffers.length; i++) {
      try {
        const out = await applyLook(buffers[i], look);
        const filename = "output_" + n + "_" + look.name + "_" + (i + 1) + ".jpg";
        await Promise.all([
          upload(id, field, out.toString("base64"), filename, "image/jpeg"),
          uploadToDrive(driveFolder, filename, out, "image/jpeg")
        ]);
        saved += 1;
      } catch (e) {
        log("skip", field, i + 1, e.message);
      }
    }
  }
  return saved;
}

async function runAi(record, noteT, driveFolder) {
  const id = record.id;
  const linked = record.get("Model") || [];
  if (!linked.length) throw new Error("No Model selected");
  const modelRec = await models.find(linked[0]);
  const modelRefs = atts(modelRec, "Reference image");
  const inputs = atts(record, "Input References");
  const prompt = record.get("Prompt") || "";
  log("model", modelRec.get("Name") || linked[0], "faceRefs", modelRefs.length, "inputs", inputs.length);
  if (!modelRefs.length && !inputs.length) throw new Error("No reference photos");

  await patch(id, { "Output 1": [] });
  const queue = inputs.length ? inputs : [null];
  const buffers = [];
  let lastErr = null;

  for (let i = 0; i < queue.length; i++) {
    log("AI", i + 1, "/", queue.length);
    await noteT("Generating Output 1 image " + (i + 1) + "/" + queue.length);
    try {
      const img = await generateOne(modelRefs, queue[i], prompt, i + 1, queue.length);
      const filename = "output_1_" + (i + 1) + ".png";
      const buf = Buffer.from(img.data, "base64");
      await Promise.all([
        upload(id, "Output 1", img.data, filename, img.mime),
        uploadToDrive(driveFolder, filename, buf, img.mime)
      ]);
      buffers.push(buf);
    } catch (e) {
      lastErr = e;
      log("AI skip", i + 1, e.message);
    }
  }

  if (!buffers.length) throw lastErr || new Error("AI produced 0 images");
  log("AI done", buffers.length, "/", queue.length);
  return buffers;
}

async function loadOutput1(record) {
  const fresh = await jobs.find(record.id);
  const files = atts(fresh, "Output 1");
  const buffers = [];
  for (const f of files) {
    try { buffers.push(await getBuf(f.url)); }
    catch (e) { log("load Output 1 skip", e.message); }
  }
  return buffers;
}

// Claims a record by stamping a unique, parseable tag into Notes, then re-reading
// it back to make sure a concurrent worker didn't win the same record in between.
async function claim(record, mode) {
  const tag = "[claim:" + WORKER_ID + ";mode=" + mode + ";at=" + Date.now() + "]";
  const ok = await patch(record.id, { Status: "Generating", Notes: tag + " Started (" + mode + ")" });
  if (!ok) return null;
  try {
    const fresh = await jobs.find(record.id);
    const notes = fresh.get("Notes") || "";
    return notes.startsWith(tag) ? tag : null;
  } catch (e) {
    log("claim verify fail", e.message);
    return null;
  }
}

// Requeues records stuck in "Generating" (e.g. the worker crashed mid-run) once
// their claim tag is older than STALE_MS. Only records claimed by this same
// tagging scheme can be recovered; untagged records are left alone.
const CLAIM_RE = /^\[claim:[^;]+;mode=(Generate|Style);at=(\d+)\]/;

async function requeueStale() {
  const stuck = await jobs.select({ filterByFormula: '{Status}="Generating"', maxRecords: 10 }).firstPage();
  if (!stuck.length) {
    log("idle");
    return;
  }
  for (const rec of stuck) {
    const m = CLAIM_RE.exec(rec.get("Notes") || "");
    if (!m) continue;
    const age = Date.now() - Number(m[2]);
    if (age < STALE_MS) continue;
    log("REQUEUE stale", rec.id, "mode", m[1], "age(ms)", age);
    await patch(rec.id, { Status: m[1] });
    await note(rec.id, "Requeued after stale timeout (" + Math.round(age / 1000) + "s)");
  }
}

async function run(record, mode, tag) {
  const id = record.id;
  log("START", id, mode);
  const noteT = (text) => note(id, tag + " " + text);
  const driveFolder = await resolveDriveFolder(record);
  if (driveFolder) {
    await patch(id, { [DRIVE_LINK_FIELD]: "https://drive.google.com/drive/folders/" + driveFolder });
  }

  let buffers = [];
  if (mode === "Style") {
    buffers = await loadOutput1(record);
    if (!buffers.length) throw new Error("Output 1 is empty — generate first");
  } else {
    buffers = await runAi(record, noteT, driveFolder);
  }

  const styled = await fillStyledOutputs(id, buffers, driveFolder);
  await patch(id, { Status: "In Review" });
  await note(id, "Done. Output 1 = " + buffers.length + " AI photos. Output 2-5 styled (" + styled + " files).");
  log("DONE", id);
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const found = await jobs.select({
      filterByFormula: 'OR({Status}="Generate",{Status}="Style")',
      maxRecords: 1
    }).firstPage();

    if (!found.length) {
      await requeueStale();
      return;
    }

    const rec = found[0];
    const mode = rec.get("Status");
    const tag = await claim(rec, mode);
    if (!tag) {
      log("SKIP", rec.id, "lost claim race");
      return;
    }

    try {
      await run(rec, mode, tag);
    } catch (e) {
      log("FAIL", rec.id, e.message);
      if (e.stack) log(e.stack);
      await note(rec.id, tag + " FAILED: " + e.message);
      await patch(rec.id, { Status: "Failed" });
    }
  } catch (e) {
    log("poll", e.message);
  } finally {
    busy = false;
  }
}

log("worker", { base: BASE_ID, table: TABLE_ID, model: MODEL, workerId: WORKER_ID, at: !!AIRTABLE_API_KEY, gm: !!GEMINI_API_KEY, drive: DRIVE_ENABLED });
setInterval(poll, POLL_MS);
poll();
