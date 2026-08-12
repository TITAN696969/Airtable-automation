const Airtable = require('airtable');
const fetch = require('node-fetch');

// ====================== CONFIG ======================
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;     // your pat... key
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;       // your AQ... key
const BASE_ID          = "app7381NQaLvJhj2Y";
const TABLE_ID         = "tblZLPqHrhyAIGHW9";               // Carousel Batches
const MODEL            = "gemini-3-pro-image";              // Nano Banana Pro
// ====================================================

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);

async function getBase64(url) {
  const res = await fetch(url);
  const buffer = await res.buffer();
  return buffer.toString('base64');
}

async function generateImage(modelRefs, prompt, slideNumber) {
  const parts = [];

  // Use first 2 model reference images max
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
        generationConfig: {
          responseModalities: ["IMAGE"]
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini error:", JSON.stringify(data));
    throw new Error("Gemini API failed");
  }

  let imagePart = null;
  for (let p of data.candidates?.[0]?.content?.parts || []) {
    if (p.inlineData || p.inline_data) {
      imagePart = p;
      break;
    }
  }

  if (!imagePart) {
    throw new Error("No image returned from Gemini");
  }

  const b64 = imagePart.inlineData?.data || imagePart.inline_data?.data;
  const mime = imagePart.inlineData?.mimeType || imagePart.inline_data?.mime_type || "image/png";

  return {
    url: `data:${mime};base64,${b64}`,
    filename: `output_${slideNumber}.png`
  };
}

async function processRecord(record) {
  const recordId = record.id;
  console.log(`Processing record ${recordId}`);

  // Set status to Generating
  await base(TABLE_ID).update(recordId, { "Status": "Generating" });

  const modelLinked = record.get("Model");
  if (!modelLinked || modelLinked.length === 0) {
    throw new Error("No Model selected");
  }

  // Get Model record
  const modelRecord = await base("Models").find(modelLinked[0]);
  const modelRefs = modelRecord.get("Reference image") || [];
  const prompt = record.get("Prompt") || "";

  // Generate 5 images one by one
  for (let i = 1; i <= 5; i++) {
    console.log(`→ Generating slide ${i}/5 for ${recordId}`);

    const image = await generateImage(modelRefs, prompt, i);

    const update = {};
    update[`Output ${i}`] = [image];

    await base(TABLE_ID).update(recordId, update);
    console.log(`✓ Slide ${i} saved`);
  }

  // Finished
  await base(TABLE_ID).update(recordId, {
    "Status": "In Review",
    "Slide": null
  });

  console.log(`✅ Record ${recordId} completed`);
}

async function checkForJobs() {
  try {
    const records = await base(TABLE_ID)
      .select({
        filterByFormula: `{Status} = "Generate"`,
        maxRecords: 3
      })
      .firstPage();

    for (const record of records) {
      try {
        await processRecord(record);
      } catch (err) {
        console.error("Error processing record:", err.message);
        await base(TABLE_ID).update(record.id, {
          "Status": "Failed"
        });
      }
    }
  } catch (err) {
    console.error("Error checking jobs:", err.message);
  }
}

// Start polling every 25 seconds
console.log("🚀 Carousel generator started...");
setInterval(checkForJobs, 25000);
checkForJobs(); // run once immediately
