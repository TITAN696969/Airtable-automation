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

async function getBuf(url) {
  const r = await fetch(url, { timeout: 30000 });
  if (!r.ok) throw new Error("download " + r.status);
  return r.buffer();
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
  if (!r.ok) throw new Error("upload " + field + " " + r.status + " " + txt.slice(0, 200));
  log("  uploaded", field, filename);
}

async function clear(recordId, field) {
  try { await jobs.update(recordId, { [field]: [] }); } catch (e) { log("clear", field, e.message); }
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
  return img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function styleRecord(record) {
  const id = record.id;
  log("START style", id);
  await jobs.update(id, { Status: "Generating" });

  const src = record.get("Output 1") || [];
  if (!src.length) throw new Error("Output 1 is empty");
  log("source photos", src.length);

  const bufs = [];
  for (const att of src) {
    const b = await getBuf(att.url);
    bufs.push(b);
    log("  loaded", att.filename || "img", b.length);
  }

  for (const n of [2, 3, 4, 5]) {
    const look = LOOKS[n];
    const field = "Output " + n;
    log("look", n, look.name);
    await clear(id, field);
    for (let i = 0; i < bufs.length; i++) {
      try {
        const out = await styleOne(bufs[i], look);
        await upload(id, field, out.toString("base64"), "output_" + n + "_" + look.name + "_" + (i + 1) + ".jpg");
      } catch (e) {
        log("skip", field, i + 1, e.message);
      }
    }
    log("ok", field);
  }

  await jobs.update(id, { Status: "In Review" });
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
      const peek = await jobs.select({ maxRecords: 5 }).firstPage();
      log("idle", peek.map((r) => r.get("Status")).join(","));
      return;
    }
    try {
      await styleRecord(found[0]);
    } catch (e) {
      log("FAIL", found[0].id, e.message);
      try { await jobs.update(found[0].id, { Status: "Failed" }); } catch (x) {}
    }
  } catch (e) {
    log("poll", e.message);
  } finally {
    busy = false;
  }
}

log("styler start", BASE_ID, TABLE_ID, { at: !!AIRTABLE_API_KEY });
setInterval(poll, POLL_MS);
poll();
