# carousel-generator

Three independent Node workers that turn Gemini-generated image carousels into
scheduled Instagram posts, tracked end-to-end in Airtable:

```
index.js          promote.js                 distribute.js
(generate)   -->   (promote to IG Master) --> (allocate to accounts)
  |                       |                          |
  v                       v                          v
Jobs table          Carousel Distribution      Carousel Distribution
(this base)         "Unassigned" rows          rows assigned to an
                     created per Style          IG Account + scheduled
                     folder                      date
```

Each script runs standalone (its own poll loop + tiny HTTP healthcheck
server) and can be deployed/restarted independently.

## Pipeline

### 1. `index.js` — generation worker
Polls the Jobs table (this repo's own Airtable base) for pending carousel
jobs, calls Gemini to generate/reroll images, applies one of five color
"looks", and optionally uploads the result to Google Drive (folder link is
written back to the job's `Drive Folder` field). A reroll of an existing
carousel is linked back to its source via `Reroll Of` so it's treated as a
sibling variant, not a new carousel.

Run: `npm start`

### 2. `promote.js` — promotion bridge
Watches this base's Jobs table for carousels that are `Done` **and**
manually checked `Creative Approved`. For each one, creates one `Unassigned`
row per Style folder in the **IG Master** base's `Carousel Distribution`
table — the actual distributable units. Marks the job `Promoted` so it's
never promoted twice.

Run: `npm run promote`

### 3. `distribute.js` — allocation worker
Reads `Unassigned` rows from `Carousel Distribution` (IG Master base) and
assigns each to an eligible IG account:

- Eligible accounts have `Status` = `Warming` or `Active`, a linked `Model`,
  and no restriction keyword (`banned`/`disabled`/`action blocked`/
  `restricted`) in `Restriction Status`.
- **Warming** accounts get 0 posts/day until `WARMUP_POSTS_FROM_DAY` days
  into warm-up, then `WARMUP_DAILY_POSTS`/day. **Active** accounts get a flat
  `ACTIVE_DAILY_POSTS`/day. This cap is shared with the reels pipeline
  (`Ready to Post` table) — both content types draw from the same daily
  budget per account.
- **`Batch Key`** (e.g. `"<Model>:Carousel 2"`) is the tracking key: it's
  identical across a carousel and all its reroll siblings, so allocation
  logic (and `/status`) can dedup them as one piece of content per account
  and see which accounts already have content vs. which still need it.
- Writes `IG Account`, `Assigned Poster`, `Scheduled For`, and sets
  `Status` to `Scheduled`.

Run: `npm run distribute`. `GET /status` on its HTTP port reports, per
Model, how many eligible accounts exist vs. how many have never received
any carousel content yet.

### 4. `cleanup.js` — source-row cleanup worker
Deletes rows from a content-source base/table (e.g. Clip Farm's own `Clip
Farm` table) once every row that references them in IG Master's `Ready to
Post` table is done — so source tables that keep growing after their
content has already gone out don't balloon forever.

This is a cross-base join, not a simple status check, because:
- One source row can produce several sibling copies (one per IG account),
  and each copy produces several posting rows (variants) in `Ready to
  Post` — so there's no clean 1:1 or Batch-Key-based relationship, and
  older rows may not even have a Batch Key.
- The only reliable link is a per-pipeline field on the `Ready to Post`
  row (e.g. `Clip Farm Row ID`, `Kling Row ID`, `Transition Row ID`) that
  stores the source row's own Airtable record id.

So for every source row, this script looks up every `Ready to Post` row
whose `CLEANUP_LINK_FIELD` equals that source row's id, and only deletes
it once **all** of those linked rows have a `Status` in
`CLEANUP_DONE_STATUSES` (default `Posted,Churned`). A source row with zero
linked rows yet (not distributed/tracked) is left alone. Deploy one
instance per pipeline — `CLEANUP_LINK_FIELD` and `CLEANUP_SOURCE_*` vary
per pipeline, everything else is shared.

- **Defaults to dry-run** (`CLEANUP_DRY_RUN=true`): logs which record IDs
  it would delete (plus `CLEANUP_PREVIEW_FIELD`, if set) without deleting
  anything. Only set `CLEANUP_DRY_RUN=false` after confirming a dry run
  matched the right rows — deletion via the Airtable API is permanent.
- `CLEANUP_MAX_DELETES_PER_RUN` (default 100) caps how many rows one run
  can delete, so a misconfiguration can't wipe an entire table in one shot.
- `GET /status` reports the dry-run flag and the last run's matched/deleted
  counts. `GET /run-now` triggers an out-of-cycle run.

Run: `npm run cleanup`

## Tracking a weekly batch → model → account

This is the built-in answer to "which account did this week's batch go
to": every distributable unit is a row in **Carousel Distribution** (IG
Master base), and its lifecycle is fully visible in that one table:

| Field | Meaning |
|---|---|
| `Model` | which model/persona the batch was generated for |
| `Batch Key` | groups a carousel + its reroll duplicates as one logical batch |
| `Style` | which of the 5 look variants (1-5) |
| `IG Account` | which account it was assigned to (blank = `Unassigned`) |
| `Assigned Poster` | which human poster is responsible |
| `Scheduled For` / `Posted At` | when it's due / when it actually went out |
| `Status` | `Unassigned` → `Scheduled` → `Posted` (or `Failed`) |
| `IG Post URL` | the live post, once posted |

Filtering this table by `Batch Key` shows every account a given week's
batch was duplicated out to; filtering by `IG Account` shows everything
(carousels + `Ready to Post` reels) scheduled for one account.

Note: populating `Carousel Distribution` with fresh `Unassigned` rows from
newly *generated* (not yet approved) jobs is `promote.js`'s job, gated on
manual `Creative Approved` review — there's no auto-promotion without that
human check.

## Setup

```
npm install
cp .env.example .env   # fill in real values, never commit this file
```

Required Airtable tables/fields are documented as comments at the top of
`distribute.js` and `promote.js` — none of these scripts create tables or
fields, only records, so create them by hand first.

### Google Drive auth (optional, for `index.js` / `promote.js`)
Pick one:
- **Service account** — set `GOOGLE_SERVICE_ACCOUNT_JSON` (base64-encoded
  key JSON) and add the service account's `client_email` to a Shared Drive
  folder (Content Manager+). Fully headless.
- **OAuth as yourself** — run `node scripts/drive-oauth-setup.js` once
  locally to mint a refresh token, then set `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`. Uploads use
  your personal Drive quota.

If neither is configured, Drive uploads are simply skipped.

See `.env.example` for every environment variable each script reads.
