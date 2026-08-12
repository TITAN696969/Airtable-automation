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

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);
const jobs = base(TABLE_ID);
const models = base(MODELS_TABLE);
let busy = false;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok\n");
}).listen(PORT, () => console.log("http", PORT));

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function getBuf(url) {
  const r = await fetch(url, { timeout: 30000 });
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

async function postGemini(parts) {
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

async function gemini(modelRefs, scene, prompt, i, total) {
  const parts = [];
  for (const att of modelRefs.slice(0, 2)) {
    const buf = await smallJpeg(att.url, 768);
    parts.push({ inline_data: { mime_type: "image/jpeg", data: buf.toString("base64") } });
  }
  if (scene) {
    const buf = await smallJpeg(scene.url, 1024);
    parts.push({ inline_data: { mime_type: "image/jpeg", data: buf.toString("base64") } });
  }
  parts.push({
    text: "You are an expert image editor. Recreate the scene from the last reference photo. The person must match the first reference photos. Photorealistic. Image " + i + " of " + total + ". " + (prompt || "")
  });

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log("  Gemini try", attempt);
    const t = Date.now();
    try {
      const res = await postGemini(parts);
      log("  Gemini", res.status, ((Date.now() - t) / 1000).toFixed(1) + "s");
      if (!res.ok) {
        last = new Error("Gemini " + res.status + " " + JSON.stringify(res.json).slice(0, 300));
        continue;
      }
      const img = extractImage(res.json);
      if (!img) {
        last = new Error("no image " + JSON.stringify(res.json).slice(0, 400));
        continue;
      }
      return img;
    } catch (e) {
      last = e;
      log("  Gemini error", e.message);
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
    body: JSON.stringify({ contentType: type || "image/jpeg", file: b64, filename: filename || "out.jpg" })
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("upload " + field + " " + r.status + " " + txt.slice(0, 250));
  log("  uploaded", field, filename);
}

async function clear(recordId, field) {
  try { await jobs.update(recordId, { [field]: [] }); } catch (e) { log("clear", field, e.message); }
}

async function styleBuf(buffer, look) {
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

async function styleOutputs(recordId) {
  const rec = await jobs.find(recordId);
  const src = rec.get("Output 1") || [];
  if (!src.length) throw new Error("Output 1 empty");
  log("styling", src.length, "into 2-5");
  const bufs = [];
  for (const att of src) bufs.push(await getBuf(att.url));
  for (const n of [2, 3, 4, 5]) {
    const look = LOOKS[n];
    const field = "Output " + n;
    await clear(recordId, field);
    for (let i = 0; i < bufs.length; i++) {
      const out = await styleBuf(bufs[i], look);
      await upload(recordId, field, out.toString("base64"), "output_" + n + "_" + look.name + "_" + (i + 1) + ".jpg", "image/jpeg");
    }
    log("ok", field, look.name);
  }
}

async function generateOutput1(record) {
  const id = record.id;
  const linked = record.get("Model") || [];
  if (!linked.length) throw new Error("No Model");
  const modelRec = await models.find(linked[0]);
  const modelRefs = modelRec.get("Reference image") || [];
  const inputs = record.get("Input References") || [];
  const prompt = record.get("Prompt") || "";
  log("model", modelRec.get("Name") || linked[0], "refs", modelRefs.length, "inputs", inputs.length);
  if (!modelRefs.length && !inputs.length) throw new Error("no refs");
  await clear(id, "Output 1");
  const queue = inputs.length ? inputs : [null];
  let ok = 0;
  let lastErr = null;
  for (let i = 0; i < queue.length; i++) {
    log("AI", i + 1, "/", queue.length);
    try {
      const img = await gemini(modelRefs, queue[i], prompt, i + 1, queue.length);
      await upload(id, "Output 1", img.data, "output_1_" + (i + 1) + ".png", img.mime);
      ok += 1;
    } catch (e) {
      lastErr = e;
      log("skip image", i + 1, e.message);
    }
  }
  if (!ok) throw lastErr || new Error("all AI images failed");
  log("AI done", ok, "/", queue.length);
}

async function fail(record, err) {
  log("FAIL", record.id, err && err.message);
  if (err && err.stack) log(err.stack);
  const n = Number(record.get("Failed generations") || 0);
  try { await jobs.update(record.id, { Status: "Failed", "Failed generations": n + 1 }); } catch (e) {}
}

async function run(record, mode) {
  log("START", record.id, mode);
  await jobs.update(record.id, { Status: "Generating" });
  if (mode === "Generate") await generateOutput1(record);
  await styleOutputs(record.id);
  await jobs.update(record.id, { Status: "In Review" });
  log("DONE", record.id);
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
      const peek = await jobs.select({ maxRecords: 5 }).firstPage();
      log("idle", peek.map((r) => r.get("Status")).join(","));
      return;
    }
    try { await run(found[0], found[0].get("Status")); }
    catch (e) { await fail(found[0], e); }
  } catch (e) {
    log("poll", e.message);
  } finally {
    busy = false;
  }
}

log("start", BASE_ID, TABLE_ID, MODEL, { at: !!AIRTABLE_API_KEY, gm: !!GEMINI_API_KEY });
setInterval(poll, POLL_MS);
poll();
