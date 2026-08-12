const Airtable = require('airtable');
const fetch = require('node-fetch');
const http = require('http');

// ====================== CONFIG ======================
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const BASE_ID          = "app7381NQaLvJhj2Y";
const TABLE_ID         = "tblZLPqHrhyAIGHW9";
const MODEL            = "gemini-3.1-flash-image";
// ====================================================

console.log("Script starting...");
console.log("Airtable key present:", !!AIRTABLE_API_KEY);
console.log("Gemini key present:", !!GEMINI_API_KEY);

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Carousel generator is running');
}).listen(PORT, () => {
  console.log("HTTP server running on port", PORT);
});

async function getBase64(url) {
  const res = await fetch(url);
  const buffer = await res.buffer();
  return buffer.toString('base64');
}

async function processRecord(record) {
  const recordId = record.id;
  console.log("\n=== Found job:", recordId, "===");

  try {
    await base(TABLE_ID).update(recordId, { "Status": "Generating" });
    console.log("Status set to Generating");

    const modelLinked = record.get("Model");
    if (!modelLinked || modelLinked.length === 0) {
      throw new Error("No Model selected");
    }

    const modelRecord = await base("Models").find(modelLinked[0]);
    const modelRefs = modelRecord.get("Reference image") || [];
    console.log("Model reference images found:", modelRefs.length);

    if (modelRefs.length === 0) {
      throw new Error("Model has no reference images");
    }

    const prompt = record.get("Prompt") || "";
    console.log("Prompt:", prompt.substring(0, 50));

    // Use only the first reference image
    const att = modelRefs[0];
    console.log("Downloading reference image...");
    const b64 = await getBase64(att.url);
    console.log("Image downloaded, size:", b64.length);

    const parts = [
      {
        inline_data: {
          mime_type: att.type || "image/jpeg",
          data: b64
        }
      },
      {
        text: `Create a high-quality photorealistic image of the person in the reference photo. ${prompt}`
      }
    ];

    console.log("Calling Gemini...");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["IMAGE"] }
        })
      }
    );

    const data = await response.json();
    console.log("Gemini status:", response.status);

    if (!response.ok) {
      console.error(JSON.stringify(data));
      throw new Error("Gemini API error");
    }

    let imagePart = null;
    for (let p of (data.candidates?.[0]?.content?.parts || [])) {
      if (p.inlineData || p.inline_data) {
        imagePart = p;
        break;
      }
    }

    if (!imagePart) {
      console.error(JSON.stringify(data));
      throw new Error("No image in response");
    }

    const imgB64 = imagePart.inlineData?.data || imagePart.inline_data?.data;
    const mime = imagePart.inlineData?.mimeType || imagePart.inline_data?.mime_type || "image/png";

    console.log("Saving image to Output 1...");
    await base(TABLE_ID).update(recordId, {
      "Output 1": [{
        url: `data:${mime};base64,${imgB64}`,
        filename: "output_1.png"
      }],
      "Status": "In Review"
    });

    console.log("✅ SUCCESS - Image saved and Status set to In Review");

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    try {
      await base(TABLE_ID).update(recordId, { "Status": "Failed" });
    } catch (e) {}
  }
}

async function checkForJobs() {
  console.log("Checking for jobs...");
  try {
    const records = await base(TABLE_ID)
      .select({
        filterByFormula: `{Status} = "Generate"`,
        maxRecords: 1
      })
      .firstPage();

    console.log("Records found:", records.length);

    for (const record of records) {
      await processRecord(record);
    }
  } catch (err) {
    console.error("Check error:", err.message);
  }
}

console.log("🚀 Generator ready");
setInterval(checkForJobs, 20000);
checkForJobs();
