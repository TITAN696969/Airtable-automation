const Airtable = require('airtable');
const http = require('http');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = "app7381NQaLvJhj2Y";
const TABLE_ID = "tblZLPqHrhyAIGHW9";

console.log("=== DEBUG MODE ===");
console.log("Airtable key present:", !!AIRTABLE_API_KEY);

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(BASE_ID);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Debug mode running');
}).listen(PORT, () => console.log("Server running on port", PORT));

async function debug() {
  try {
    console.log("Trying to read the table...");

    const records = await base(TABLE_ID)
      .select({ maxRecords: 10 })
      .firstPage();

    console.log("Total records found:", records.length);

    records.forEach((record, i) => {
      console.log(`\nRecord ${i + 1}:`);
      console.log("  ID:", record.id);
      console.log("  Status value:", JSON.stringify(record.get("Status")));
      console.log("  All fields:", Object.keys(record.fields));
    });

  } catch (err) {
    console.error("ERROR reading table:");
    console.error(err.message);
  }
}

debug();
setInterval(debug, 30000);
