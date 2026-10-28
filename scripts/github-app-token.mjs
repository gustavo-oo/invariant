#!/usr/bin/env node
/**
 * Mint a short-lived GitHub App installation token using only Node built-ins.
 *
 * The private key is read locally and never written anywhere. The token is
 * printed to stdout and expires after about one hour; mint a new one for each
 * clean session.
 *
 * Usage:
 *   node scripts/github-app-token.mjs \
 *     --app-id 123456 \
 *     --installation-id 789012 \
 *     --repositories invariant \
 *     --private-key ~/.config/invariant/app.pem
 *
 * Environment fallbacks:
 *   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_REPOSITORIES,
 *   GITHUB_APP_PRIVATE_KEY_PATH
 *
 * `--repositories` scopes the installation token to those repository names.
 * Without it the token covers every repository selected for the installation.
 * The App private key remains installation-wide; use separate Apps if that
 * cross-repository blast radius is not acceptable.
 *
 * `--jwt-only` prints the signed JWT and makes no network call; use it to test
 * the private key and the clock without contacting GitHub.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const usage = `usage: node scripts/github-app-token.mjs [options]

  --app-id <id>             GitHub App id (or GITHUB_APP_ID)
  --installation-id <id>    installation id (or GITHUB_APP_INSTALLATION_ID)
  --repositories <names>    comma-separated repo names to scope the token
                            (or GITHUB_APP_REPOSITORIES)
  --private-key <path>      App private key PEM (or GITHUB_APP_PRIVATE_KEY_PATH)
  --jwt-only                print the signed JWT; do not call GitHub
  -h, --help                show this help
`;

const opts = {
  appId: process.env.GITHUB_APP_ID,
  installationId: process.env.GITHUB_APP_INSTALLATION_ID,
  repositories: process.env.GITHUB_APP_REPOSITORIES,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
  jwtOnly: false,
};

for (let i = 0; i < process.argv.length - 2; i += 1) {
  const arg = process.argv[i + 2];
  switch (arg) {
    case "--app-id":
      opts.appId = process.argv[i + 3];
      i += 1;
      break;
    case "--installation-id":
      opts.installationId = process.argv[i + 3];
      i += 1;
      break;
    case "--repositories":
      opts.repositories = process.argv[i + 3];
      i += 1;
      break;
    case "--private-key":
      opts.privateKey = process.argv[i + 3];
      i += 1;
      break;
    case "--jwt-only":
      opts.jwtOnly = true;
      break;
    case "-h":
    case "--help":
      process.stdout.write(usage);
      process.exit(0);
      break;
    default:
      process.stderr.write(`github-app-token: unknown argument: ${arg}\n\n${usage}`);
      process.exit(2);
  }
}

if (!opts.appId || !opts.privateKey) {
  process.stderr.write(`github-app-token: --app-id and --private-key are required\n\n${usage}`);
  process.exit(2);
}
if (!opts.jwtOnly && !opts.installationId) {
  process.stderr.write(`github-app-token: --installation-id is required unless --jwt-only is used\n\n${usage}`);
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(
  JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(opts.appId) }),
).toString("base64url");

let signature;
try {
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  signature = signer.sign(readFileSync(opts.privateKey, "utf8"), "base64url");
} catch (error) {
  process.stderr.write(`github-app-token: cannot sign with ${opts.privateKey}: ${error.message}\n`);
  process.exit(2);
}

const jwt = `${header}.${payload}.${signature}`;
if (opts.jwtOnly) {
  process.stdout.write(`${jwt}\n`);
  process.exit(0);
}

const repositories = (opts.repositories ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

let response;
try {
  response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(opts.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(repositories.length > 0 ? { repositories } : {}),
    },
  );
} catch (error) {
  process.stderr.write(`github-app-token: request failed: ${error.message}\n`);
  process.exit(1);
}

if (!response.ok) {
  process.stderr.write(`github-app-token: GitHub returned ${response.status}: ${await response.text()}\n`);
  process.exit(1);
}

const body = await response.json();
if (typeof body.token !== "string" || body.token.length === 0) {
  process.stderr.write("github-app-token: GitHub response did not contain a token\n");
  process.exit(1);
}

process.stdout.write(`${body.token}\n`);
