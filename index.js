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
     
