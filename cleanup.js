// Cleanup worker: deletes source rows from a "content source" base/table
// (e.g. Clip Farm's own Clip Farm table) once every row in Instagram
// Master's Ready to Post table that references them is done - so tables
// that grow unbounded once their content is fully posted don't balloon in
// row count forever.
//
// Ready to Post is shared across multiple content pipelines (Clip Farm,
// Transition, Kling, Videos, ...), each writing its own "<Pipeline> Row ID"
// link field back to its own source base. A source row can also produce
// several sibling copies (one per account) and each copy produces several
// posting rows (variants) - so there's no clean 1:1 or Batch-Key-based
// relationship. The only reliable join is: LINK_FIELD on a Ready to Post
// row equals a source row's own Airtable record id. This script is
// generic over which pipeline it cleans - point LINK_FIELD/CLEANUP_SOURCE_*
// at the right one and deploy one instance per pipeline.
//
// Safety: defaults to DRY_RUN=true (logs what it would delete, deletes
// nothing) and caps deletions per run (CLEANUP_MAX_DELETES_PER_RUN).
// Deletion via the Airtable API is permanent - there is no undo.

const Airtable = require("airtable");
const http = require("http");

// Instagram Master's Ready to Post table - reuses this repo's existing
// IG_MASTER_* naming (see distribute.js/promote.js).
const IG_MASTER_API_KEY = process.env.IG_MASTER_API_KEY;
const IG_MASTER_BASE_ID = process.env.IG_MASTER_BASE_ID;
const READY_TO_POST_TABLE = process.env.READY_TO_POST_TABLE || "Ready to Post";

// The field on a Ready to Post row that holds the source row's record id,
// and which Status values on that row count as "done with this content".
const CLEANUP_LINK_FIELD = process.env.CLEANUP_LINK_FIELD || "Clip Farm Row ID";
const CLEANUP_STATUS_FIELD = process.env.CLEANUP_STATUS_FIELD || "Status";
const CLEANUP_DONE_STATUSES = (process.env.CLEANUP_DONE_STATUSES || "Posted,Churned")
  .split(",").map((s) => s.trim()).filter(Boolean);

// The base/table actually being cleaned (e.g. Clip Farm's own base) -
// separate credentials since it's typically a different Airtable account/key.
const CLEANUP_SOURCE_API_KEY = process.env.CLEANUP_SOURCE_API_KEY;
const CLEANUP_SOURCE_BASE_ID = process.env.CLEANUP_SOURCE_BASE_ID;
const CLEANUP_SOURCE_TABLE = process.env.CLEANUP_SOURCE_TABLE;
const CLEANUP_PREVIEW_FIELD = process.env.CLEANUP_PREVIEW_FIELD || "";

const CLEANUP_DRY_RUN = process.env.CLEANUP_DRY_RUN !== "false";
const CLEANUP_MAX_DELETES_PER_RUN = Number(process.env.CLEANUP_MAX_DELETES_PER_RUN || 100);
const CLEANUP_POLL_MS = Number(process.env.CLEANUP_POLL_MS || 30 * 60 * 1000);
const PORT = process.env.CLEANUP_PORT || process.env.PORT || 3003;

if (!IG_MASTER_API_KEY || !IG_MASTER_BASE_ID) {
  throw new Error("IG_MASTER_API_KEY and IG_MASTER_BASE_ID are required");
}
if (!CLEANUP_SOURCE_API_KEY || !CLEANUP_SOURCE_BASE_ID || !CLEANUP_SOURCE_TABLE) {
  throw new Error("CLEANUP_SOURCE_API_KEY, CLEANUP_SOURCE_BASE_ID, and CLEANUP_SOURCE_TABLE are all required");
}

const readyTable = new Airtable({ apiKey: IG_MASTER_API_KEY }).base(IG_MASTER_BASE_ID)(READY_TO_POST_TABLE);
const sourceTable = new Airtable({ apiKey: CLEANUP_SOURCE_API_KEY }).base(CLEANUP_SOURCE_BASE_ID)(CLEANUP_SOURCE_TABLE);

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

// Builds sourceRowId -> array of Status values for every Ready to Post row
// that links back to it via CLEANUP_LINK_FIELD.
async function buildLinkedStatusMap() {
  const rows = await readyTable.select({
    filterByFormula: "NOT({" + CLEANUP_LINK_FIELD + "}='')",
    fields: [CLEANUP_LINK_FIELD, CLEANUP_STATUS_FIELD],
    maxRecords: 200000
  }).all();

  const map = new Map();
  for (const r of rows) {
    const sourceId = r.get(CLEANUP_LINK_FIELD);
    if (!sourceId) continue;
    const status = r.get(CLEANUP_STATUS_FIELD) || "";
    if (!map.has(sourceId)) map.set(sourceId, []);
    map.get(sourceId).push(status);
  }
  return map;
}

async function findDeletableSourceRows() {
  const [sourceRows, statusMap] = await Promise.all([
    sourceTable.select({ maxRecords: 200000 }).all(),
    buildLinkedStatusMap()
  ]);

  const deletable = [];
  for (const row of sourceRows) {
    const statuses = statusMap.get(row.id);
    if (!statuses || !statuses.length) continue; // never distributed/tracked yet - leave it
    if (statuses.every((s) => CLEANUP_DONE_STATUSES.includes(s))) {
      deletable.push(row);
    }
  }
  return deletable;
}

async function deleteInBatches(ids) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    await withRetry(() => sourceTable.destroy(batch), { label: "delete batch " + (i / 10 + 1) });
    deleted += batch.length;
  }
  return deleted;
}

async function runCleanup() {
  const deletable = await findDeletableSourceRows();
  if (!deletable.length) {
    log("cleanup: nothing to delete (0 source rows fully " + CLEANUP_DONE_STATUSES.join("/") + ")");
    lastRun = { at: new Date().toISOString(), matched: 0, deleted: 0, dryRun: CLEANUP_DRY_RUN };
    return;
  }

  const capped = deletable.slice(0, CLEANUP_MAX_DELETES_PER_RUN);
  if (deletable.length > capped.length) {
    log("cleanup: " + deletable.length + " eligible, capping this run to " + capped.length + " (CLEANUP_MAX_DELETES_PER_RUN)");
  }

  if (CLEANUP_DRY_RUN) {
    for (const r of capped) {
      const preview = CLEANUP_PREVIEW_FIELD ? r.get(CLEANUP_PREVIEW_FIELD) : "";
      log("cleanup: [DRY RUN] would delete", r.id, preview);
    }
    log("cleanup: [DRY RUN] " + deletable.length + " row(s) eligible - set CLEANUP_DRY_RUN=false to actually delete");
    lastRun = { at: new Date().toISOString(), matched: deletable.length, deleted: 0, dryRun: true };
    return;
  }

  const deleted = await deleteInBatches(capped.map((r) => r.id));
  log("cleanup: deleted", deleted, "of", deletable.length, "eligible row(s)");
  lastRun = { at: new Date().toISOString(), matched: deletable.length, deleted, dryRun: false };
}

http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dryRun: CLEANUP_DRY_RUN, maxDeletesPerRun: CLEANUP_MAX_DELETES_PER_RUN, lastRun }, null, 2));
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

log("cleanup worker", {
  readyToPostBase: IG_MASTER_BASE_ID,
  sourceBase: CLEANUP_SOURCE_BASE_ID,
  sourceTable: CLEANUP_SOURCE_TABLE,
  linkField: CLEANUP_LINK_FIELD,
  doneStatuses: CLEANUP_DONE_STATUSES,
  dryRun: CLEANUP_DRY_RUN,
  maxDeletesPerRun: CLEANUP_MAX_DELETES_PER_RUN
});

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
