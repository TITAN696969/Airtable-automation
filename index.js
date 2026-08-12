/**
 * Carousel generator worker
 *
 * Status = Generate
 *   1) AI: each Input Reference → Output 1 (Gemini, one by one)
 *   2) No AI: copy Output 1 into Output 2–5 with a different light/filter
 *
 * Status = Style
 *   skip AI, restyle existing Output 1 into Output 2–5
 *
 * Turn OFF the native Airtable automation or it will steal the job.
 */

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
  2: {
    name: "warm-sun",
    modulate: { brightness: 1.03, saturation: 1.07, hue: 5 },
    linear: [1.05, 2],
    gamma: 1.02,
  },
  3: {
    name: "cool-clean",
    modulate: { brightness: 1.02, saturation: 0.93, hue: -7 },
    linear: [1.06, 0],
    gamma: 0.98,
  },
  4: {
    name: "soft-matte",
    modulate: { brightness: 1.03, saturation: 0.94, hue: 2 },
    linear: [0.86, 16],
    gamma: 1.05,
  },
  5: {
    name: "crisp-editorial",
    modulate: { brightness: 1.02, saturation: 1.05, hue: -1 },
    linear: [1.10, -3],
    gamma: 0.97,
    sharpen: { sigma: 0.7 },
  },
};

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

async function downloadBuffer(url) {
  const res = await fetch(url, { timeout: 30000 });
  if (!res.ok) throw new Error("download failed " + res.status);
  return res.buffer();
}

async function downloadBase64(url) {
  const buf = await downloadBuffer(url);
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

async function uploadAttachment(recordId, fieldName, base64, filename, contentType) {
  const url =
    `https://content.airtable.com/v0/${BASE_ID}/${recordId}/` +
    `${encodeURIComponent(fieldName)}/uploadAttachment`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + AIRTABLE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contentType: contentType || "image/jpeg",
      file: base64,
      filename: filename || "output.jpg",
    }),
    timeout: 60000,
  });

  const text = await res.text();
  if (!res.ok) throw new Error("upload " + fieldName + " " + res.status + " " + text.slice(0, 300));
  log("  uploaded", fieldName, filename);
}

async function clearField(recordId, fieldName) {
  try {
    await jobsTable.update(recordId, { [fieldName]: [] });
  } catch (e) {
    log("clear", fieldName, e.message);
  }
}

async function applyLook(buffer, look) {
  let img = sharp(buffer, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  if (longest > 2048) img = img.resize({ width: 2048, height: 2048, fit: "inside" });

  if (look.modulate) img = img.modulate(look.modulate);
  if (look.linear) img = img.linear(look.linear[0], look.linear[1]);
  if (look.gamma) img = img.gamma(look.gamma);
  if (look.sharpen) img = img.sharpen(look.sharpen);

  return img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function styleOutputs(recordId) {
  const fresh = await jobsTable.find(recordId);
  const originals = fresh.get("Output 1") || [];
  if (!originals.length) throw new Error("Output 1 is empty — nothing to style");

  log("styling", originals.length, "photo(s) into Output 2–5");

  const buffers = [];
  for (const att of originals) {
    const buf = await downloadBuffer(att.url);
    buffers.push(buf);
    log("  loaded", att.filename || "Output 1 image", buf.length, "bytes");
  }

  for (const n of [2, 3, 4, 5]) {
    const look = LOOKS[n];
    const field = "Output " + n;
    await clearField(recordId, field);

    for (let i = 0; i < buffers.length; i++) {
      const styled = await applyLook(buffers[i], look);
      await uploadAttachment(
        recordId,
        field,
        styled.toString("base64"),
        `output_${n}_${look.name}_${i + 1}.jpg`,
        "image/jpeg"
      );
    }
    log("✓", field, look.name);
  }
}

async function generateOutput1(record) {
  const id = record.id;
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

  await clearField(id, "Output 1");

  const queue = inputRefs.length ? inputRefs : [null];
  const total = queue.length;

  for (let i = 0; i < queue.length; i++) {
    log(`--- AI reference ${i + 1}/${total} ---`);
    const image = await generateFromRefs(modelRefs, queue[i], prompt, i + 1, total);
    await uploadAttachment(id, "Output 1", image.data, `output_1_${i + 1}.png`, image.mime);
    log(`✓ Output 1 image ${i + 1}/${total}`);
  }
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

async function processRecord(record, mode) {
  const id = record.id;
  log("===== START", id, "mode=" + mode, "=====");
  await jobsTable.update(id, { Status: "Generating" });

  if (mode === "Generate") {
    await generateOutput1(record);
  }

  await styleOutputs(id);

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
        filterByFormula: 'OR({Status} = "Generate", {Status} = "Style")',
        maxRecords: 1,
      })
      .firstPage();

    if (!records.length) {
      const peek = await jobsTable.select({ maxRecords: 5 }).firstPage();
      const statuses = peek.map((r) => r.get("Status")).join(", ");
      log("no jobs. statuses:", statuses || "(none)");
      return;
    }

    const record = records[0];
    const mode = record.get("Status");
    try {
      await processRecord(record, mode);
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
log("keys", { airtable: !!AIRTABLE_API_KEY, gemini: !!GEMINI_API_KEY });

setInterval(checkForJobs, POLL_MS);
checkForJobs();
