const Airtable = require("airtable");
const fetch = require("node-fetch");
const http = require("http");
const sharp = require("sharp");

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "app7381NQaLvJhj2Y";
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblZLPqHrhyAIGHW9";
const POLL_MS = Number(process.env.POLL_MS || 12000);
const PORT = process.env.PORT || 3000;

const LOOKS = {
  2: { name: "warm-sun", modulate: { brightness: 1.03, saturation: 1.07, hue: 5 }, linear: [1.05, 2], gamma: 1.02 },
  3: { name: "cool-clean", modulate: { brightness: 1.02, saturation: 0.93, hue: -7 }, linear: [1.06, 0], gamma: 0.98 },
  4: { name: "soft-matte", modulate: { brightness: 1.03, saturation: 0.94, hue: 2 }, linear: [0.86, 16], gamma: 1.05 },
  5: { name: "crisp-editorial", modulate: { brightness: 1.02, saturation: 1.05, hue: -1 }, linear: [1.1, -3], gamma: 0.97, sharpen: { sigma: 0.7 } }
};

const jobs = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID)(TABLE_ID);
let busy = false;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok\n");
}).listen(PORT, () => console.log("http", PORT));

const log = (...a) => console.log(new Date().toISOString(), ...a);

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function attachmentsIn(record, wanted) {
  const want = norm(wanted);
  for (const name of Object.keys(record.fields || {})) {
    if (norm(name) !== want) continue;
    const v = record.fields[name];
    if (Array.isArray(v) && v.length && v[0] && v[0].url) return { name, files: v };
  }
  return null;
}

function firstAttachmentField(record, names) {
  for (const n of names) {
    const hit = attachmentsIn(record, n);
    if (hit) return hit;
  }
  return null;
}

async function setField(id, fields) {
  try {
    await jobs.update(id, fields);
    return true;
  } catch (e) {
    log("update failed", JSON.stringify(fields), e.message);
    return false;
  }
}

async function note(id, text) {
  log("NOTE", text);
  await setField(id, { Notes: String(text).slice(0, 900) });
}

async function getBuf(url) {
  const r = await fetch(url, { timeout: 45000 });
  if (!r.ok) throw new Error("download " + r.status);
  const buf = await r.buffer();
  if (!buf || !buf.length) throw new Error("empty download");
  return buf;
}

async function upload(recordId, field, b64, filename) {
  const url = "https://content.airtable.com/v0/" + BASE_ID + "/" + recordId + "/" + encodeURIComponent(field) + "/uploadAttachment";
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + AIRTABLE_API_KEY, "Content-Type": "application/json" },
    timeout: 60000,
    body: JSON.stringify({ contentType: "image/jpeg", file: b64, filename })
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("upload " + field + " " + r.status + " " + txt.slice(0, 180));
  log("  uploaded", field, filename);
}

async function styleOne(buffer, look) {
  let img = sharp(buffer, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  if (Math.max(meta.width || 0, meta.height || 0) > 2048) {
    img = img.resize({ width: 2048, height: 2048, fit: "inside" });
  }
  if (look.modulate) img = img.modulate(look.modulate);
  if (look.linear) img = img.linear(look.linear[0], look.linear[1]);
  if (look.gamma) img = img.gamma(look.gamma);
  if (look.sharpen) img = img.sharpen(look.sharpen);
  return img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

async function styleRecord(record) {
  const id = record.id;
  log("START", id, "fields=", Object.keys(record.fields || {}));

  const fresh = await jobs.find(id);
  log("refetch fields=", Object.keys(fresh.fields || {}));
  for (const [k, v] of Object.entries(fresh.fields || {})) {
    if (Array.isArray(v) && v[0] && v[0].url) log("  att", k, v.length);
  }

  await setField(id, { Status: "Generating" });

  const src =
    firstAttachmentField(fresh, ["Output 1", "Output1", "output 1"]) ||
    firstAttachmentField(fresh, ["Input References", "InputReferences", "Reference image"]);

  if (!src) {
    throw new Error("No photos found. Put images in Output 1 then set Generate again. Fields: " + Object.keys(fresh.fields || {}).join(", "));
  }

  log("using", src.name, "count", src.files.length);
  await note(id, "Styling " + src.files.length + " photo(s) from " + src.name);

  const bufs = [];
  for (const att of src.files) {
    try {
      const b = await getBuf(att.url);
      bufs.push(b);
      log("  loaded", att.filename || "img", b.length);
    } catch (e) {
      log("  skip load", e.message);
    }
  }
  if (!bufs.length) throw new Error("Could not download any source photos");

  let saved = 0;
  for (const n of [2, 3, 4, 5]) {
    const look = LOOKS[n];
    const field = "Output " + n;
    log("look", n, look.name);
    await setField(id, { [field]: [] });
    for (let i = 0; i < bufs.length; i++) {
      try {
        const out = await styleOne(bufs[i], look);
        await upload(id, field, out.toString("base64"), "output_" + n + "_" + look.name + "_" + (i + 1) + ".jpg");
        saved += 1;
      } catch (e) {
        log("skip", field, i + 1, e.message);
      }
    }
    log("ok", field);
  }

  if (!saved) throw new Error("Styled 0 images — upload failed");
  await setField(id, { Status: "In Review" });
  await note(id, "Done. Styled " + saved + " images into Output 2-5.");
  log("DONE", id, "saved", saved);
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const found = await jobs.select({
      filterByFormula: 'OR({Status}="Generate",{Status}="Style")',
      maxRecords: 3
    }).firstPage();

    if (!found.length) {
      const peek = await jobs.select({ maxRecords: 8 }).firstPage();
      log("idle", peek.map((r) => r.id.slice(-6) + "=" + r.get("Status")).join(" | "));
      return;
    }

    for (const rec of found) {
      try {
        await styleRecord(rec);
      } catch (e) {
        log("FAIL", rec.id, e.message);
        if (e.stack) log(e.stack);
        await note(rec.id, "FAILED: " + e.message);
        await setField(rec.id, { Status: "Failed" });
      }
    }
  } catch (e) {
    log("poll", e.message);
    if (e.stack) log(e.stack);
  } finally {
    busy = false;
  }
}

log("styler start", { base: BASE_ID, table: TABLE_ID, key: !!AIRTABLE_API_KEY });
setInterval(poll, POLL_MS);
poll();
