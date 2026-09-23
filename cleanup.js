// Cleanup worker: deletes rows from an Airtable table once they're marked
// posted, so tables that grow forever (e.g. the Clip Farm base's per-clip
// table) don't balloon in row count. Fully separate base/table/field from
// this repo's own generator base and from IG Master - point it at whichever
// base+table is growing unbounded.
//
// Safety: defaults to DRY_RUN=true. In dry-run mode it logs exactly which
// records it *would* delete (id + a preview field) but deletes nothing.
// Only flip CLEANUP_DRY_RUN=false once you've checked a run's logs and are
// sure it's matching the right rows.
//
// Deletion is permanent - Airtable has no trash/undo via the API. There is
// no age/delay filter here: a row is deleted on the very next poll after
// its status field matches CLEANUP_POSTED_VALUE.

const Airtable = require("airtable");
const http = require("http");

const CLEANUP_API_KEY = process.env.CLEANUP_API_KEY;
const CLEANUP_BASE_ID = process.env.CLEANUP_BASE_ID;
const CLEANUP_TABLE = process.env.CLEANUP_TABLE;
const CLEANUP_STATUS_FIELD = process.env.CLEANUP_STATUS_FIELD || "Status";
const CLEANUP_POSTED_VALUE = process.env.CLEANUP_POSTED_VALUE || "Posted";
// A field to log alongside each record id so dry-run output is actually
// checkable against the base (e.g. a name/title/link column). Optional.
const CLEANUP_PREVIEW_FIELD = process.env.CLEANUP_PREVIEW_FIELD || "";
const CLEANUP_DRY_RUN = process.env.CLEANUP_DRY_RUN !== "false";

const CLEANUP_POLL_MS = Number(process.env.CLEANUP_POLL_MS || 30 * 60 * 1000);
const PORT = process.env.CLEANUP_PORT || process.env.PORT || 3003;

if (!CLEANUP_API_KEY || !CLEANUP_BASE_ID || !CLEANUP_TABLE) {
  throw new Error("CLEANUP_API_KEY, CLEANUP_BASE_ID, and CLEANUP_TABLE are all required");
}

const table = new Airtable({ apiKey: CLEANUP_API_KEY }).base(CLEANUP_BASE_ID)(CLEANUP_TABLE);

let busy = false;
let lastRun = null;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { attempts = 3, baseMs = 1000, label = "" } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      log("  retry", label, i + "/" + attempts, e.message);
      if (i < attempts) await sleep(baseMs * i);
    }
  }
  throw last;
}

function escapeFormulaString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findPostedRecords() {
  const safeField = CLEANUP_STATUS_FIELD;
  const safeValue = escapeFormulaString(CLEANUP_POSTED_VALUE);
  return table.select({
    filterByFormula: "{" + safeField + "}='" + safeValue + "'",
    maxRecords: 10000
  }).all();
}

// Airtable's delete endpoint accepts at most 10 record ids per call.
async function deleteInBatches(ids) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    await withRetry(() => table.destroy(batch), { label: "delete batch " + (i / 10 + 1) });
    deleted += batch.length;
  }
  return deleted;
}

async function runCleanup() {
  const records = await findPostedRecords();
  if (!records.length) {
    log("cleanup: nothing to delete (0 rows matched " + CLEANUP_STATUS_FIELD + "=" + CLEANUP_POSTED_VALUE + ")");
    lastRun = { at: new Date().toISOString(), matched: 0, deleted: 0, dryRun: CLEANUP_DRY_RUN };
    return;
  }

  if (CLEANUP_DRY_RUN) {
    for (const r of records) {
      const preview = CLEANUP_PREVIEW_FIELD ? r.get(CLEANUP_PREVIEW_FIELD) : "";
      log("cleanup: [DRY RUN] would delete", r.id, preview);
    }
    log("cleanup: [DRY RUN] " + records.length + " row(s) matched - set CLEANUP_DRY_RUN=false to actually delete");
    lastRun = { at: new Date().toISOString(), matched: records.length, deleted: 0, dryRun: true };
    return;
  }

  const deleted = await deleteInBatches(records.map((r) => r.id));
  log("cleanup: deleted", deleted, "row(s)");
  lastRun = { at: new Date().toISOString(), matched: records.length, deleted, dryRun: false };
}

http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dryRun: CLEANUP_DRY_RUN, lastRun }, null, 2));
    return;
  }
  if (req.url === "/run-now") {
    if (busy) {
      res.writeHead(409, { "Content-Type": "text/plain" });
      res.end("already running\n");
      return;
    }
    busy = true;
    runCleanup()
      .catch((e) => log("cleanup manual run failed", e.message))
      .finally(() => { busy = false; });
    res.writeHead(202, { "Content-Type": "text/plain" });
    res.end("cleanup triggered, check logs or /status\n");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok\n");
}).listen(PORT, () => console.log("http", PORT));

log("cleanup worker", { base: CLEANUP_BASE_ID, table: CLEANUP_TABLE, statusField: CLEANUP_STATUS_FIELD, postedValue: CLEANUP_POSTED_VALUE, dryRun: CLEANUP_DRY_RUN });

(async function loop() {
  for (;;) {
    if (!busy) {
      busy = true;
      try {
        await runCleanup();
      } catch (e) {
        log("cleanup run failed", e.message);
      } finally {
        busy = false;
      }
    }
    await sleep(CLEANUP_POLL_MS);
  }
})();
