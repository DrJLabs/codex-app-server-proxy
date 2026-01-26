import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const DOC_PATH = new URL("../../../docs/configuration.md", import.meta.url);
const ENV_EXAMPLE_PATH = new URL("../../../.env.example", import.meta.url);
const ENV_DEV_EXAMPLE_PATH = new URL("../../../.env.dev.example", import.meta.url);

describe("documentation alignment for PROXY_USE_APP_SERVER", () => {
  it("keeps docs table and sample env defaults in sync", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const doc = readFileSync(DOC_PATH, "utf8");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const envExampleLines = readFileSync(ENV_EXAMPLE_PATH, "utf8").split(/\r?\n/);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const envDevExampleLines = readFileSync(ENV_DEV_EXAMPLE_PATH, "utf8").split(/\r?\n/);

    const match = doc.match(
      /\|\s*`PROXY_USE_APP_SERVER`\s*\|\s*`(true|false)`\s*\|/i
    );
    expect(match).not.toBeNull();
    const defaultValue = match?.[1];
    expect(defaultValue).toBe("true");

    const expectedLine = `PROXY_USE_APP_SERVER=${defaultValue}`;
    expect(envExampleLines).toContain(expectedLine);
    expect(envDevExampleLines).toContain(expectedLine);
  });
});
