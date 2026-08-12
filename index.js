/**
 * Carousel generator worker
 *
 * Watches Airtable for Status = "Generate".
 * For each Input Reference (one at a time):
 *   - send that photo + the model's first 2 face refs to Gemini
 *   - upload the result into Output 1 only (appends)
 * Then set Status = "In Review".
 *
 * REQUIRED: turn OFF the native Airtable automation
 * ("Generate carousel batch") or it will steal the record
 * before this worker sees Status = Generate.
 */

const Airtable = require("airtable");
const fetch = require("node-fetch");
const http = require("http");

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "app7381NQaLvJhj2Y";
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblZLPqHrhyAIGHW9";
const MODELS_TABLE = process.env.AIRTABLE_MODELS_TABLE || "Models";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-image";
const POLL_MS = Number(process.env.POLL_MS || 15000);
const OUTPUT_FIELD = "Output 1";
const PORT = process.env.PORT || 3000;

if (!AIRTABLE_API_KEY) console.error("MISSING AIRTABLE_API_KEY");
if (!GEMINI_API_KEY) console.error("MISSING GEMINI_API_KEY");

const airtable = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);
const jobsTable = airtable(TABLE_ID);
const modelsTable = airtable(MODELS_TABLE);

let busy = false;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("carousel generator running\n");
  })
  .listen(PORT, () => console.log("http listening on", PORT));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function downloadBase64(url) {
  const res = await fetch(url, { timeout: 30000 });
  if (!res.ok) throw new Error("download failed " + res.status);
  const buf = await res.buffer();
  return { data: buf.toString("base64"), bytes: buf.length };
}

function imagePart(mime, data) {
  return { inline_data: { mime_type: mime || "image/jpeg", data } };
}

function extractImage(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      return {
        data: inline.data,
        mime: inline.mimeType || inline.mime_type || "image/png",
      };
    }
  }
  return null;
}

async function generateFromRefs(modelRefs, sceneRef, prompt, index, total) {
  const parts = [];

  for (const att of modelRefs.slice(0, 2)) {
    const { data, bytes } = await downloadBase64(att.url);
    log("  model ref", att.filename || "unnamed", bytes, "bytes");
    parts.push(imagePart(att.type, data));
  }

  if (sceneRef) {
    const { data, bytes } = await downloadBase64(sceneRef.url);
    log("  scene ref", sceneRef.filename || "unnamed", bytes, "bytes");
    parts.push(imagePart(sceneRef.type, data));
  }

  parts.push({
    text: [
      "You are an expert image editor.",
      "Recreate the scene / pose from the last reference photo.",
      "The person must look like the person in the first reference photos (same face, hair, skin).",
      "Photorealistic. High quality.",
      `This is image ${index} of ${total}.`,
      prompt || "",
    ].join(" "),
  });

  log("  calling Gemini", MODEL);
  const started = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 120000,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    }
  );

  const json = await res.json();
  log("  Gemini", res.status, ((Date.now() - started) / 1000).toFixed(1) + "s");

  if (!res.ok) {
    throw new Error("Gemini " + res.status + " " + JSON.stringify(json).slice(0, 400));
  }

  const image = extractImage(json);
  if (!image) {
    throw new Error("Gemini returned no image: " + JSON.stringify(json).slice(0, 600));
  }
  return image;
}

async function uploadOutput1(recordId, base64, filename, contentType) {
  const body = JSON.stringify({
    contentType: contentType || "image/png",
    file: base64,
    filename: filename || "output.png",
  });

  const urls = [
    `https://api.airtable.com/v0/${BASE_ID}/${recordId}/${encodeURIComponent(OUTPUT_FIELD)}/uploadAttachment`,
    `https://content.airtable.com/v0/${BASE_ID}/${recordId}/${encodeURIComponent(OUTPUT_FIELD)}/uploadAttachment`,
  ];

  let lastErr = null;
  for (const url of urls) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + AIRTABLE_API_KEY,
        "Content-Type": "application/json",
      },
      body,
      timeout: 60000,
    });
    const text = await res.text();
    if (res.ok) {
      log("  uploaded to", OUTPUT_FIELD, "via", url.includes("content.") ? "content" : "api");
      return;
    }
    lastErr = res.status + " " + text.slice(0, 300);
    log("  upload failed", lastErr);
  }
  throw new Error("uploadAttachment failed: " + lastErr);
}

async function bumpFailed(record) {
  const current = Number(record.get("Failed generations") || 0);
  try {
    await jobsTable.update(record.id, {
      Status: "Failed",
      "Failed generations": current + 1,
    });
  } catch (e) {
    log("could not mark Failed", e.message);
  }
}

async function processRecord(record) {
  const id = record.id;
  log("===== START", id, "=====");

  await jobsTable.update(id, { Status: "Generating" });

  const modelLinked = record.get("Model") || [];
  if (!modelLinked.length) throw new Error("No Model selected");

  const modelRecord = await modelsTable.find(modelLinked[0]);
  const modelRefs = modelRecord.get("Reference image") || [];
  const inputRefs = record.get("Input References") || [];
  const prompt = record.get("Prompt") || "";

  log("model", modelRecord.get("Name") || modelLinked[0]);
  log("model refs", modelRefs.length, "input refs", inputRefs.length);

  if (!modelRefs.length && !inputRefs.length) {
    throw new Error("No reference images on Model or Input References");
  }

  try {
    await jobsTable.update(id, { [OUTPUT_FIELD]: [] });
  } catch (e) {
    log("could not clear Output 1 (ok if empty):", e.message);
  }

  const queue = inputRefs.length ? inputRefs : [null];
  const total = queue.length;

  for (let i = 0; i < queue.length; i++) {
    const scene = queue[i];
    log(`--- reference ${i + 1}/${total} ---`);
    const image = await generateFromRefs(modelRefs, scene, prompt, i + 1, total);
    await uploadOutput1(id, image.data, `output_1_${i + 1}.png`, image.mime);
    log(`✓ saved image ${i + 1}/${total} into ${OUTPUT_FIELD}`);
  }

  await jobsTable.update(id, { Status: "In Review" });
  log("===== DONE", id, "=====");
}

async function checkForJobs() {
  if (busy) {
    log("still working, skip poll");
    return;
  }
  busy = true;
  try {
    const records = await jobsTable
      .select({
        filterByFormula: '{Status} = "Generate"',
        maxRecords: 1,
      })
      .firstPage();

    if (!records.length) {
      const peek = await jobsTable.select({ maxRecords: 5 }).firstPage();
      const statuses = peek.map((r) => r.get("Status")).join(", ");
      log("no Generate jobs. current statuses:", statuses || "(none)");
      return;
    }

    const record = records[0];
    try {
      await processRecord(record);
    } catch (err) {
      log("JOB FAILED", record.id, err.message);
      if (err.stack) log(err.stack);
      await bumpFailed(record);
    }
  } catch (err) {
    log("poll error", err.message);
  } finally {
    busy = false;
  }
}

log("worker start");
log("base", BASE_ID, "table", TABLE_ID);
log("model", MODEL);
log("keys", {
  airtable: !!AIRTABLE_API_KEY,
  gemini: !!GEMINI_API_KEY,
});

setInterval(checkForJobs, POLL_MS);
checkForJobs();
