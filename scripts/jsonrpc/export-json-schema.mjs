#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as TJS from "typescript-json-schema";
import { CODEX_CLI_VERSION } from "../../src/lib/json-rpc/schema.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const TSCONFIG_PATH = resolve(PROJECT_ROOT, "tsconfig.schema.json");
const OUTPUT_DIR = resolve(PROJECT_ROOT, "docs", "reference");
const OUTPUT_PATH = resolve(OUTPUT_DIR, "app-server-protocol.schema.json");

const settings = {
  required: true,
  noExtraProps: false,
  topRef: false,
};

const typeNames = [
  "InitializeParams",
  "ThreadStartParams",
  "TurnStartParams",
  "AgentMessageDeltaParams",
  "AgentMessageParams",
  "TokenCountParams",
  "RequestTimeoutParams",
  "JsonRpcErrorResponse",
  "JsonRpcSuccessResponse",
];

const mergeDefinitions = (target, source = {}) => {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      // The schema generator controls these keys; suppress security lint for dynamic assignment.
      // eslint-disable-next-line security/detect-object-injection
      target[key] = value;
    }
  }
};

export function buildSchemaGenerator() {
  const program = TJS.programFromConfig(TSCONFIG_PATH);
  const generator = TJS.buildGenerator(program, settings);
  if (!generator) {
    throw new Error("Failed to create JSON schema generator");
  }
  return generator;
}

export function buildSchemaBundle(generator) {
  const definitions = {};
  for (const name of typeNames) {
    const schema = generator.getSchemaForSymbol(name);
    if (!schema) {
      throw new Error(`Unable to generate schema for ${name}`);
    }
    const { definitions: nested, ...rest } = schema;
    // Schema type names are controlled locally; suppress dynamic key warning.
    // eslint-disable-next-line security/detect-object-injection
    definitions[name] = rest;
    mergeDefinitions(definitions, nested);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Codex App Server JSON-RPC Schema Bundle",
    cliVersion: CODEX_CLI_VERSION,
    definitions,
  };
}

export async function generateSchemaBundle() {
  const generator = buildSchemaGenerator();
  return buildSchemaBundle(generator);
}

export async function writeSchemaBundle() {
  const bundle = await generateSchemaBundle();
  await mkdir(OUTPUT_DIR, { recursive: true });
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  let existing = null;
  try {
    existing = await readFile(OUTPUT_PATH, "utf8");
  } catch {}
  if (existing === serialized) {
    console.log("Schema bundle unchanged");
  } else {
    await writeFile(OUTPUT_PATH, serialized, "utf8");
    console.log(`Wrote schema bundle to ${OUTPUT_PATH}`);
  }
  return { bundle, serialized, outputPath: OUTPUT_PATH };
}

if (process.argv[1] === __filename) {
  await writeSchemaBundle();
}
