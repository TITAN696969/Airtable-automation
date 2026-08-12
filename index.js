const Airtable = require('airtable');
const fetch = require('node-fetch');
const http = require('http');

// ====================== CONFIG ======================
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const BASE_ID          = "app7381NQaLvJhj2Y";
const TABLE_ID         = "tblZLPqHrhyAIGHW9";
const MODEL            = "gemini-3-pro-image";
// ====================================================

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);

// Tiny server so Render is happy (free web service)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Carousel generator is running');
}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

async function getBase64(url) {
  const res = await fetch(url);
  const buffer = await res.buffer();
  return buffer.toString('base64');
}

async function generateImage(modelRefs, prompt, slideNumber) {
  const parts = [];

  for (let att of modelRefs.slice(0, 2)) {
    parts.push({
      inline_data: {
        mime_type: att.type || "image/jpeg",
        data: await getBase64(att.url)
      }
    });
  }

  parts.push({
    text: `Create a high-quality photorealistic image of the exact person shown in the reference photos. This is carousel slide ${slideNumber} of 5. Vary the pose and camera angle. ${prompt}`
  });

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
  if (!response.ok) {
    console.error(JSON.stringify(data));
    throw new Error("Gemini API failed");
  }

  let imagePart = null;
  for (let p of data.candidates?.[0]?.content?.parts || []) {
    if (p.inlineData || p.inline_data) {
      imagePart = p;
      break;
    }
  }

  if (!imagePart) throw new Error("No image returned");

  const b64 = imagePart.inlineData?.data || imagePart.inline_data?.data;
  const mime = imagePart.inlineData?.mimeType || imagePart.inline_data?.mime_type || "image/png";

  return {
    url: `data:${mime};base64,${b64}`,
    filename: `output_${slideNumber}.png`
  };
}

async function processRecord(record) {
  const recordId = record.id;
  console.log(`Processing ${recordId}`);

  await base(TABLE_ID).update(recordId, { "Status": "Generating" });

  const modelLinked = record.get("Model");
  if (!modelLinked || modelLinked.length === 0) throw new Error("No Model");

  const modelRecord = await base("Models").find(modelLinked[0]);
  const modelRefs = modelRecord.get("Reference image") || [];
  const prompt = record.get("Prompt") || "";

  for (let i = 1; i <= 5; i++) {
    console.log(`Generating slide ${i}/5`);
    const image = await generateImage(modelRefs, prompt, i);
    await base(TABLE_ID).update(recordId, { [`Output ${i}`]: [image] });
    console.log(`Slide ${i} saved`);
  }

  await base(TABLE_ID).update(recordId, {
    "Status": "In Review",
    "Slide": null
  });

  console.log(`✅ Finished ${recordId}`);
}

async function checkForJobs() {
  try {
    const records = await base(TABLE_ID)
      .select({ filterByFormula: `{Status} = "Generate"`, maxRecords: 2 })
      .firstPage();

    for (const record of records) {
      try {
        await processRecord(record);
      } catch (err) {
        console.error(err.message);
        await base(TABLE_ID).update(record.id, { "Status": "Failed" });
      }
    }
  } catch (err) {
    console.error("Check error:", err.message);
  }
}

console.log("🚀 Carousel generator started");
setInterval(checkForJobs, 25000);
checkForJobs();
