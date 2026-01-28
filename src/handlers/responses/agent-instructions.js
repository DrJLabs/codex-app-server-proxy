import fs from "fs";
import path from "path";
import { config as CFG } from "../../config/index.js";

let cached = null;
let loaded = false;

const readFileIfExists = (filePath) => {
  try {
    if (!filePath) return "";
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(filePath)) return "";
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const text = fs.readFileSync(filePath, "utf8");
    return text ? text.trim() : "";
  } catch {
    return "";
  }
};

export const loadObsidianAgentInstructions = () => {
  if (loaded) return cached || "";
  loaded = true;
  const home = CFG.CODEX_HOME;
  const candidates = [path.join(home, "AGENTS.md"), path.join(home, "AGENTS.xml.backup")];
  for (const candidate of candidates) {
    const text = readFileIfExists(candidate);
    if (text) {
      cached = text;
      break;
    }
  }
  return cached || "";
};
