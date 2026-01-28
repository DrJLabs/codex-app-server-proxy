import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSchemaBundle } from "../../scripts/jsonrpc/export-json-schema.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const SCHEMA_PATH = resolve(PROJECT_ROOT, "docs", "reference", "app-server-protocol.schema.json");

describe("jsonrpc schema bundle", () => {
  it("matches generated bundle", async () => {
    const generated = await generateSchemaBundle();
    const onDiskRaw = await readFile(SCHEMA_PATH, "utf8");
    const onDisk = JSON.parse(onDiskRaw);

    expect(onDisk.cliVersion).toBe(generated.cliVersion);
    expect(onDisk.definitions).toEqual(generated.definitions);
  });
});
