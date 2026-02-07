import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "README.md");
const targetPath = path.join(repoRoot, "docs", "README-root.md");

const isExternalHref = (href) =>
  href.startsWith("http://") ||
  href.startsWith("https://") ||
  href.startsWith("mailto:") ||
  href.startsWith("#");

const rewriteHref = (href) => {
  if (typeof href !== "string" || href.length === 0) return href;
  if (isExternalHref(href)) return href;

  if (href.startsWith("docs/")) return href.slice("docs/".length);

  // The README lives at repo root; in docs/ we need to go up a directory.
  if (href === "CONTRIBUTING.md") return `../${href}`;
  if (href === "LICENSE" || href === "LICENSE.md") return `../${href}`;
  if (href.startsWith("external/")) return `../${href}`;

  return href;
};

const rewriteMarkdownLinks = (text) =>
  text.replace(/\]\(([^)\n]+)\)/g, (match, href) => `](${rewriteHref(href)})`);

const main = async () => {
  const readme = await fs.readFile(sourcePath, "utf8");
  const rewritten = rewriteMarkdownLinks(readme);
  const banner =
    `<!-- GENERATED: README-root\n` +
    `This file is generated from ../README.md.\n` +
    `Run: npm run docs:sync-readme-root\n` +
    `Generated at: ${new Date().toISOString()}\n` +
    `-->`;

  const output = `${banner}\n\n${rewritten.trimEnd()}\n`;

  let existing = null;
  try {
    existing = await fs.readFile(targetPath, "utf8");
  } catch {}

  if (existing === output) return;
  await fs.writeFile(targetPath, output, "utf8");
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
