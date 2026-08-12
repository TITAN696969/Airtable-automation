const Airtable = require("airtable");
const fetch = require("node-fetch");
const http = require("http");
const sharp = require("sharp");

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "app7381NQaLvJhj2Y";
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblZLPqHrhyAIGHW9";
const MODELS_TABLE = process.env.AIRTABLE_MODELS_TABLE || "Models";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-image";
const POLL_MS = Number(process.env.POLL_MS || 15000);
const PORT = process.env.PORT || 3000;

const LOOKS = {
  2: { name: "warm-sun", modulate: { brightness: 1.03, saturation: 1.07, hue: 5 }, linear: [1.05, 2], gamma: 1.02 },
  3: { name: "cool-clean", modulate: { brightness: 1.02, saturation: 0.93, hue: -7 }, linear: [1.06, 0], gamma: 0.98 },
  4: { name: "soft-matte", modulate: { brightness: 1.03, saturation: 0.94, hue: 2 }, linear: [0.86, 16], gamma: 1.05 },
  5: { name: "crisp-editorial", modulate: { brightness: 1.02, saturation: 1.05, hue: -1 }, linear: [1.1, -3], gamma: 0.97, sharpen: { sigma: 0.7 } }
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

async function patch(id, fields) {
  try {
    await jobs.update(id, fields);
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

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log("  Gemini", i, "try", attempt);
    const t = Date.now();
    try {
      const res = await callGemini(parts);
      log("  Gemini", res.status, ((Date.now() - t) / 1000).toFixed(1) + "s");
      if (!res.ok) {
        last = new Error("Gemini " + res.status + " " + JSON.stringify(res.json).slice(0, 240));
        continue;
      }
      const img = extractImage(res.json);
      if (!img) {
        last = new Error("no image " + JSON.stringify(res.json).slice(0, 240));
        continue;
      }
      return img;
    } catch (e) {
      last = e;
      log("  Gemini err", e.message);
    }
  }
  throw last || new Error("Gemini failed");
}

async function upload(recordId, field, b64, filename, type) {
  const url = "https://content.airtable.com/v0/" + BASE_ID + "/" + recordId + "/" + encodeURIComponent(field) + "/uploadAttachment";
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + AIRTABLE_API_KEY, "Content-Type": "application/json" },
    timeout: 60000,
    body: JSON.stringify({ contentType: type || "image/jpeg", file: b64, filename })
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("upload " + field + " " + r.status + " " + txt.slice(0, 160));
  log("  uploaded", field, filename);
}

async function applyLook(buffer, look) {
  let img = sharp(buffer, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  if (Math.max(meta.width || 0, meta.height || 0) > 2048) {
    img = img.resize({ width: 2048, height: 2048, fit: "inside" });
  }
  if (look.modulate) img = img.modulate(look.modulate);
  if (look.linear) img = img.linear(look.linear[0], look.linear[1]);
  if (look.gamma) img = img.gamma(look.gamma);
  if (look.sharpen) img = img.sharpen(look.sharpen);
  return img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function fillStyledOutputs(id, buffers) {
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
        await upload(id, field, out.toString("base64"), "output_" + n + "_" + look.name + "_" + (i + 1) + ".jpg", "image/jpeg");
        saved += 1;
      } catch (e) {
        log("skip", field, i + 1, e.message);
      }
    }
  }
  return saved;
}

async function runAi(record) {
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
    await note(id, "Generating Output 1 image " + (i + 1) + "/" + queue.length);
    try {
      const img = await generateOne(modelRefs, queue[i], prompt, i + 1, queue.length);
      await upload(id, "Output 1", img.data, "output_1_" + (i + 1) + ".png", img.mime);
      buffers.push(Buffer.from(img.data, "base64"));
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

async function run(record, mode) {
  const id = record.id;
  log("START", id, mode);
  await patch(id, { Status: "Generating" });
  await note(id, "Started (" + mode + ")");

  let buffers = [];
  if (mode === "Style") {
    buffers = await loadOutput1(record);
    if (!buffers.length) throw new Error("Output 1 is empty — generate first");
  } else {
    buffers = await runAi(record);
  }

  const styled = await fillStyledOutputs(id, buffers);
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
      const peek = await jobs.select({ maxRecords: 6 }).firstPage();
      log("idle", peek.map((r) => (r.get("Status") || "?")).join(","));
      return;
    }

    const rec = found[0];
    try {
      await run(rec, rec.get("Status"));
    } catch (e) {
      log("FAIL", rec.id, e.message);
      if (e.stack) log(e.stack);
      await note(rec.id, "FAILED: " + e.message);
      await patch(rec.id, { Status: "Failed" });
    }
  } catch (e) {
    log("poll", e.message);
  } finally {
    busy = false;
  }
}

log("worker", { base: BASE_ID, table: TABLE_ID, model: MODEL, at: !!AIRTABLE_API_KEY, gm: !!GEMINI_API_KEY });
setInterval(poll, POLL_MS);
poll();
