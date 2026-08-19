// One-time local setup: exchanges a Google OAuth client for a long-lived refresh
// token this worker can use to upload to your Drive. Run this on your own laptop
// (not on the server) — it opens your real browser so you can click "Allow".
//
// Usage:
//   npm install --no-save @google-cloud/local-auth
//   node scripts/drive-oauth-setup.js /path/to/oauth-client.json
//
// The JSON must be a "Desktop app" OAuth client downloaded from Google Cloud
// Console (Credentials -> Create Credentials -> OAuth client ID -> Desktop app).
// Desktop app clients accept a loopback redirect on any port automatically, so
// no manual "Authorized redirect URI" setup is needed. A "Web application"
// client (the other common type) will NOT work here without extra config.

const fs = require("fs");
const path = require("path");

const SCOPES = ["https://www.googleapis.com/auth/drive"];

async function main() {
  const keyfilePath = process.argv[2];
  if (!keyfilePath) {
    console.error("Usage: node scripts/drive-oauth-setup.js <path-to-oauth-client.json>");
    process.exit(1);
  }

  const resolved = path.resolve(keyfilePath);
  const keys = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const key = keys.installed || keys.web;
  if (!key) {
    console.error('Unrecognized file — expected an "installed" (Desktop app) or "web" OAuth client JSON.');
    process.exit(1);
  }
  if (!keys.installed) {
    console.error(
      'This looks like a "Web application" OAuth client, not "Desktop app".\n' +
      "Create a new OAuth client in Cloud Console with type \"Desktop app\" and use that file instead — " +
      "it avoids having to manually register a redirect URI."
    );
    process.exit(1);
  }

  let authenticate;
  try {
    ({ authenticate } = require("@google-cloud/local-auth"));
  } catch (e) {
    console.error('Missing dependency. Run: npm install --no-save @google-cloud/local-auth');
    process.exit(1);
  }

  console.log("Opening your browser to authorize Drive access…");
  const client = await authenticate({ scopes: SCOPES, keyfilePath: resolved });

  const refreshToken = client.credentials.refresh_token;
  if (!refreshToken) {
    console.error(
      "No refresh_token was returned. This usually means you've authorized this app before.\n" +
      "Revoke it at https://myaccount.google.com/permissions and run this script again."
    );
    process.exit(1);
  }

  console.log("\nSuccess. Set these on your worker deployment (Render/Fly/etc env vars):\n");
  console.log("GOOGLE_OAUTH_CLIENT_ID=" + key.client_id);
  console.log("GOOGLE_OAUTH_CLIENT_SECRET=" + key.client_secret);
  console.log("GOOGLE_OAUTH_REFRESH_TOKEN=" + refreshToken);
  console.log("\nAlso set DRIVE_ROOT_FOLDER_ID to the folder ID you want outputs organized under.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
