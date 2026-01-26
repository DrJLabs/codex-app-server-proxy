import { readFile } from "node:fs/promises";
import path from "node:path";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "obsidian-copilot", "responses");
const REDACTED = "<redacted>";

const scrubRedactedToolChoice = (body) => {
  if (!body || typeof body !== "object") return;
  const toolChoice = body.tool_choice !== undefined ? body.tool_choice : body.toolChoice;
  if (typeof toolChoice !== "string") return;
  if (toolChoice.trim().toLowerCase() !== REDACTED) return;
  delete body.tool_choice;
  delete body.toolChoice;
};

export async function loadCopilotResponsesFixture(filename) {
  const fullPath = path.join(FIXTURE_ROOT, filename);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixtures live under repo root
  const raw = await readFile(fullPath, "utf8");
  const fixture = JSON.parse(raw);
  scrubRedactedToolChoice(fixture?.request?.body);
  return fixture;
}

export { FIXTURE_ROOT as COPILOT_RESPONSES_FIXTURE_ROOT };
