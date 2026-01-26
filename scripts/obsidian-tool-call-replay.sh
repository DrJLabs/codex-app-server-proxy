#!/usr/bin/env bash
set -euo pipefail

URL="${OBSIDIAN_REPLAY_URL:-http://localhost:11435/v1/responses}"
API_KEY="${PROXY_API_KEY:-}"
MODEL="${OBSIDIAN_REPLAY_MODEL:-gpt-5.2}"
QUERY="${OBSIDIAN_REPLAY_QUERY:-Kingston, TN weather today}"
DRY_RUN="${OBSIDIAN_REPLAY_DRY_RUN:-}"

if [[ -z "${API_KEY}" ]]; then
  echo "PROXY_API_KEY is required" >&2
  exit 1
fi

payload=$(node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const model = process.env.OBSIDIAN_REPLAY_MODEL || "gpt-5.2";
const query = process.env.OBSIDIAN_REPLAY_QUERY || "Kingston, TN weather today";
const promptMode = (process.env.OBSIDIAN_REPLAY_PROMPT_MODE || "doc").toLowerCase();
const copilotRoot =
  process.env.OBSIDIAN_REPLAY_COPILOT_ROOT ||
  path.resolve(process.cwd(), "external", "obsidian-copilot");
const promptPath =
  process.env.OBSIDIAN_REPLAY_PROMPT_PATH ||
  path.resolve(
    process.cwd(),
    "docs",
    "responses-api",
    "obsidian-system-prompt-lur1PQG76dSpMd4FPZij2.md"
  );

const readFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const isEscaped = (text, index) => {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

const extractTemplateLiteralAt = (text, startIndex) => {
  if (!text) return "";
  const openIndex = text.indexOf("`", startIndex);
  if (openIndex === -1) return "";
  let result = "";
  for (let i = openIndex + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "`" && !isEscaped(text, i)) {
      return result.trim();
    }
    result += char;
  }
  return "";
};

const extractTemplateLiteral = (text, marker) => {
  if (!text) return "";
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return "";
  return extractTemplateLiteralAt(text, markerIndex);
};

const extractSectionById = (text, id) => {
  if (!text) return "";
  const idIndex = text.indexOf(`id: \"${id}\"`);
  if (idIndex === -1) return "";
  const contentIndex = text.indexOf("content:", idIndex);
  if (contentIndex === -1) return "";
  return extractTemplateLiteralAt(text, contentIndex);
};

const extractWebSearchInstructions = (text) => {
  if (!text) return "";
  const idIndex = text.indexOf('id: "webSearch"');
  if (idIndex === -1) return "";
  const instructionsIndex = text.indexOf("customPromptInstructions:", idIndex);
  if (instructionsIndex === -1) return "";
  return extractTemplateLiteralAt(text, instructionsIndex);
};

const extractGpt5Rules = (text) => {
  if (!text) return "";
  const ruleIndex = text.indexOf("gptSectionParts.push");
  if (ruleIndex === -1) return "";
  return extractTemplateLiteralAt(text, ruleIndex);
};

const extractPromptFromDoc = (text) => {
  if (!text) return "";
  const match = text.match(/(`{3,4})text/);
  if (!match) return "";
  const fence = match[1];
  const start = text.indexOf(match[0]);
  const lineEnd = text.indexOf("\n", start + match[0].length);
  if (lineEnd === -1) return "";
  const contentStart = lineEnd + 1;
  const closeIndex = text.indexOf(`\n${fence}`, contentStart);
  if (closeIndex === -1) return "";
  return text.slice(contentStart, closeIndex).trim();
};

const buildToolCallInstructions = () =>
  [
    "Tool calling instructions:",
    "Only emit tool calls using <tool_call>...</tool_call>.",
    "Format: <tool_call>{\\\"name\\\":\\\"TOOL_NAME\\\",\\\"arguments\\\":\\\"{...}\\\"}</tool_call>",
    "Inside <tool_call>...</tool_call>, output ONLY a JSON object with keys \\\"name\\\" and \\\"arguments\\\".",
    "Do not add any extra characters before or after the JSON (no trailing \\\">\\\", no code fences).",
    "Use exactly one opening <tool_call> and one closing </tool_call> tag.",
    "Output must be valid JSON. Do not add extra braces or trailing characters.",
    "Never repeat the closing tag.",
    "Example (exact): <tool_call>{\\\"name\\\":\\\"webSearch\\\",\\\"arguments\\\":\\\"{\\\\\\\"query\\\\\\\":\\\\\\\"example\\\\\\\",\\\\\\\"chatHistory\\\\\\\":[]}\\\"}</tool_call>",
    "The \\\"arguments\\\" field must be a JSON string.",
    "Available tools:",
    "- webSearch: {\\\"type\\\":\\\"object\\\",\\\"properties\\\":{\\\"query\\\":{\\\"type\\\":\\\"string\\\"},\\\"chatHistory\\\":{\\\"type\\\":\\\"array\\\"}},\\\"required\\\":[\\\"query\\\",\\\"chatHistory\\\"],\\\"additionalProperties\\\":false}",
  ].join("\\n");

const buildCopilotPrompt = () => {
  const constantsPath = path.join(copilotRoot, "src", "constants.ts");
  const modelAdapterPath = path.join(
    copilotRoot,
    "src",
    "LLMProviders",
    "chainRunner",
    "utils",
    "modelAdapter.ts"
  );
  const builtinToolsPath = path.join(copilotRoot, "src", "tools", "builtinTools.ts");

  const constantsText = readFile(constantsPath);
  const modelAdapterText = readFile(modelAdapterPath);
  const builtinToolsText = readFile(builtinToolsPath);

  const basePrompt = extractTemplateLiteral(constantsText, "export const DEFAULT_SYSTEM_PROMPT =");
  const agentIntro = extractSectionById(modelAdapterText, "autonomous-agent-intro");
  const toolGuidelines = extractSectionById(modelAdapterText, "tool-usage-guidelines");
  const generalGuidelines = extractSectionById(modelAdapterText, "general-guidelines");
  const toolSpecific = extractWebSearchInstructions(builtinToolsText);
  const gptRules =
    model.toLowerCase().includes("gpt-5") || model.toLowerCase().includes("gpt5")
      ? extractGpt5Rules(modelAdapterText)
      : "";

  if (!basePrompt || !agentIntro) {
    return "";
  }

  const toolDescriptions = `<webSearch>\n<description>Search the web for information</description>\n<parameters>\n<query>The search query</query>\n<chatHistory>Previous conversation turns</chatHistory>\n</parameters>\n</webSearch>`;

  const parts = [basePrompt, agentIntro];
  if (toolDescriptions) {
    parts.push(`Available tools:\n${toolDescriptions}`);
  }
  if (toolGuidelines) {
    parts.push(toolGuidelines);
  }
  if (toolSpecific) {
    parts.push(toolSpecific);
  }
  if (generalGuidelines) {
    parts.push(generalGuidelines);
  }
  if (gptRules) {
    parts.push(gptRules);
  }

  return parts.filter(Boolean).join("\\n\\n");
};

const buildDocPrompt = () => {
  const text = readFile(promptPath);
  if (!text) return "";
  const extracted = extractPromptFromDoc(text);
  if (extracted) return extracted;
  return text.trim();
};

const instructions =
  promptMode === "tool_call"
    ? buildToolCallInstructions()
    : promptMode === "copilot"
      ? buildCopilotPrompt() || buildToolCallInstructions()
      : buildDocPrompt() || buildCopilotPrompt() || buildToolCallInstructions();

const payload = {
  model,
  stream: true,
  input: [
    { type: "message", role: "developer", content: instructions },
    { type: "message", role: "user", content: `Find ${query}.` },
  ],
  tools: [
    {
      type: "function",
      name: "webSearch",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          chatHistory: { type: "array" },
        },
        required: ["query", "chatHistory"],
        additionalProperties: false,
      },
    },
  ],
};

process.stdout.write(JSON.stringify(payload));
NODE
)

if [[ -n "${DRY_RUN}" ]]; then
  echo "${payload}"
  exit 0
fi

curl -sS "${URL}" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "User-Agent: obsidian/1.9.7" \
  -H "x-proxy-debug: true" \
  -d "${payload}"
