import { describe, expect, it } from "vitest";
import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

describe("obsidian tool-call replay script", () => {
  it("exists and is executable", () => {
    const scriptPath = path.resolve(process.cwd(), "scripts/obsidian-tool-call-replay.sh");
    expect(() => accessSync(scriptPath, constants.X_OK)).not.toThrow();
  });

  it("prints payload JSON in dry-run mode", () => {
    const scriptPath = path.resolve(process.cwd(), "scripts/obsidian-tool-call-replay.sh");
    const output = execFileSync(scriptPath, [], {
      env: {
        ...process.env,
        PROXY_API_KEY: "test",
        OBSIDIAN_REPLAY_DRY_RUN: "1",
        OBSIDIAN_REPLAY_QUERY: "Test Query",
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(output);
    expect(payload).toEqual(
      expect.objectContaining({
        model: expect.any(String),
        input: expect.any(Array),
        tools: expect.any(Array),
      })
    );
  });
});
