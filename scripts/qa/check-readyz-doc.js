#!/usr/bin/env node
/**
 * Fails if the readiness probe documentation is missing expected snippets.
 */
import fs from "node:fs";
import path from "node:path";

const docPath = path.join(process.cwd(), "docs", "troubleshooting.md");
const requiredPatterns = [/\/readyz/, /\/healthz/];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

let content = "";
try {
  content = fs.readFileSync(docPath, "utf8");
} catch (err) {
  die(`Missing runbook: ${docPath} (${err.message})`);
}

const missing = requiredPatterns.filter((re) => !re.test(content));
if (missing.length) {
  die(
    `Probe doc check failed: missing required patterns in ${docPath}: ${missing
      .map((re) => re.toString())
      .join(", ")}`
  );
}

console.log(`Probe doc check passed for ${docPath}`);
