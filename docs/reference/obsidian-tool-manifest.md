# Obsidian tool manifest (captured)


This document captures the full Obsidian tool manifest as sent by the client. The proxy currently blocks this from reaching the backend.

## Source
- Capture: `test-results/responses-copilot/raw-unredacted/responses-2026-01-27t12-00-51-530z-3d624710-7869-41af-a60a-c7a1bc58a74e-stream.json`
- Request path: `/v1/responses` (stream)

## Manifest
```json
[
  {
    "function": {
      "description": "Search for notes in the vault based on query, salient terms, and optional time range",
      "name": "localSearch",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "_preExpandedQuery": {
            "additionalProperties": false,
            "description": "Internal: pre-expanded query data injected by the system to avoid double expansion",
            "properties": {
              "expandedQueries": {
                "items": {
                  "type": "string"
                },
                "type": "array"
              },
              "expandedTerms": {
                "items": {
                  "type": "string"
                },
                "type": "array"
              },
              "originalQuery": {
                "type": "string"
              },
              "recallTerms": {
                "items": {
                  "type": "string"
                },
                "type": "array"
              },
              "salientTerms": {
                "items": {
                  "type": "string"
                },
                "type": "array"
              }
            },
            "required": [
              "originalQuery",
              "salientTerms",
              "expandedQueries",
              "expandedTerms",
              "recallTerms"
            ],
            "type": "object"
          },
          "query": {
            "description": "The search query to find relevant notes",
            "minLength": 1,
            "type": "string"
          },
          "salientTerms": {
            "description": "Keywords extracted from the user's query for BM25 full-text search. Must be from original query.",
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "timeRange": {
            "additionalProperties": false,
            "description": "Optional time range filter. Use epoch milliseconds from getTimeRangeMs result.",
            "properties": {
              "endTime": {
                "description": "End time as epoch milliseconds",
                "type": "number"
              },
              "startTime": {
                "description": "Start time as epoch milliseconds",
                "type": "number"
              }
            },
            "required": [
              "startTime",
              "endTime"
            ],
            "type": "object"
          }
        },
        "required": [
          "query",
          "salientTerms"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Search the INTERNET (NOT vault notes) when user explicitly asks for web/online information",
      "name": "webSearch",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "chatHistory": {
            "description": "Previous conversation turns for context (usually empty array)",
            "items": {
              "additionalProperties": false,
              "properties": {
                "content": {
                  "type": "string"
                },
                "role": {
                  "enum": [
                    "user",
                    "assistant"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "role",
                "content"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "query": {
            "description": "The search query to search the internet",
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "query",
          "chatHistory"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Get the current time in local timezone or at a specified UTC offset. Returns epoch time, ISO string, and formatted strings.",
      "name": "getCurrentTime",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "timezoneOffset": {
            "description": "Optional UTC offset. IMPORTANT: Must be a numeric offset, NOT a timezone name.\n\nEXAMPLES OF CORRECT USAGE:\n- \"what time is it\" \u2192 No parameter (uses local time)\n- \"what time is it in Tokyo\" \u2192 timezoneOffset: \"+9\"\n- \"what time is it in Beijing\" \u2192 timezoneOffset: \"+8\"\n- \"what time is it in New York\" \u2192 timezoneOffset: \"-5\" (or \"-4\" during DST)\n- \"what time is it in Mumbai\" \u2192 timezoneOffset: \"+5:30\"\n\nSUPPORTED FORMATS:\n- Simple: \"+8\", \"-5\", \"+5:30\"\n- With prefix: \"UTC+8\", \"GMT-5\", \"UTC+5:30\"\n\nCOMMON TIMEZONE OFFSETS:\n- Tokyo: UTC+9\n- Beijing/Singapore: UTC+8\n- Mumbai: UTC+5:30\n- Dubai: UTC+4\n- London: UTC+0 (UTC+1 during BST)\n- New York: UTC-5 (UTC-4 during DST)\n- Los Angeles: UTC-8 (UTC-7 during DST)",
            "type": "string"
          }
        },
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Convert a Unix timestamp (in seconds or milliseconds) to detailed time information",
      "name": "getTimeInfoByEpoch",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "epoch": {
            "description": "Unix timestamp in seconds or milliseconds",
            "type": "number"
          }
        },
        "required": [
          "epoch"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Convert natural language time expressions to date ranges for use with localSearch",
      "name": "getTimeRangeMs",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "timeExpression": {
            "description": "Natural language time expression to convert to a date range.\n\nCOMMON EXPRESSIONS:\n- Relative past: \"yesterday\", \"last week\", \"last month\", \"last year\"\n- Relative ranges: \"this week\", \"this month\", \"this year\"\n- Specific dates: \"July 1\", \"July 1 2023\", \"2023-07-01\"\n- Date ranges: \"from July 1 to July 15\", \"between May and June\"\n- Time periods: \"last 7 days\", \"past 30 days\", \"previous 3 months\"\n\nIMPORTANT: This tool is typically used as the first step before localSearch when searching notes by time.\n\nEXAMPLE WORKFLOW:\n1. User: \"what did I do last week\"\n2. First call getTimeRangeMs with timeExpression: \"last week\"\n3. Then use the returned time range with localSearch",
            "type": "string"
          }
        },
        "required": [
          "timeExpression"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Convert a specific time from one timezone to another using UTC offsets",
      "name": "convertTimeBetweenTimezones",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "fromOffset": {
            "description": "Source UTC offset. Must be numeric, not timezone name.\nExamples: \"-8\" for PT, \"+0\" for London, \"+8\" for Beijing",
            "type": "string"
          },
          "time": {
            "description": "Time to convert. Supports various formats:\n- 12-hour: \"6pm\", \"3:30 PM\", \"11:45 am\"\n- 24-hour: \"18:00\", \"15:30\", \"23:45\"\n- Relative: \"noon\", \"midnight\"",
            "type": "string"
          },
          "toOffset": {
            "description": "Target UTC offset. Must be numeric, not timezone name.\nExamples: \"+9\" for Tokyo, \"-5\" for NY, \"+5:30\" for Mumbai\n\nEXAMPLE USAGE:\n- \"what time is 6pm PT in Tokyo\" \u2192 time: \"6pm\", fromOffset: \"-8\", toOffset: \"+9\"\n- \"convert 3:30 PM EST to London time\" \u2192 time: \"3:30 PM\", fromOffset: \"-5\", toOffset: \"+0\"\n- \"what is 9am Beijing time in New York\" \u2192 time: \"9am\", fromOffset: \"+8\", toOffset: \"-5\"",
            "type": "string"
          }
        },
        "required": [
          "time",
          "fromOffset",
          "toOffset"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Read a single note in search v3 sized chunks. Use only when you already know the exact note path and need its contents.",
      "name": "readNote",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "chunkIndex": {
            "description": "0-based chunk index to read. Omit to read the first chunk.",
            "minimum": 0,
            "type": "integer"
          },
          "notePath": {
            "description": "Full path to the note (relative to the vault root) that needs to be read, such as 'Projects/plan.md'.",
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "notePath"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Request to write content to a file at the specified path and show the changes in a Change Preview UI.\n\n      # Steps to find the the target path\n      1. Extract the target file information from user message and find out the file path from the context.\n      2. If target file is not specified, use the active note as the target file.\n      3. If still failed to find the target file or the file path, ask the user to specify the target file.\n      ",
      "name": "writeToFile",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "confirmation": {
            "default": true,
            "description": "(Optional) Whether to ask for change confirmation with preview UI before writing changes. Default: true. Set to false to skip preview and apply changes immediately.",
            "type": "boolean"
          },
          "content": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "additionalProperties": true,
                "properties": {},
                "type": "object"
              }
            ],
            "description": "(Required) The content to write to the file. Can be either a string or an object.\n          ALWAYS provide the COMPLETE intended content of the file, without any truncation or omissions. \n          You MUST include ALL parts of the file, even if they haven't been modified.\n\n          # For string content\n          * Use when writing text files like .md, .txt, etc.\n          \n          # For object content  \n          * Use when writing structured data files like .json, .canvas, etc.\n          * The object will be automatically converted to JSON string format\n          \n          # Canvas JSON Format (JSON Canvas spec 1.0)\n          Required node fields: id, type, x, y, width, height\n          Node types: \"text\" (needs text), \"file\" (needs file), \"link\" (needs url), \"group\" (optional label)\n          Optional node fields: color (hex #FF0000 or preset \"1\"-\"6\"), subpath (file nodes, starts with #)\n          Required edge fields: id, fromNode, toNode\n          Optional edge fields: fromSide/toSide (\"top\"/\"right\"/\"bottom\"/\"left\"), fromEnd/toEnd (\"none\"/\"arrow\"), color, label\n          All IDs must be unique. Edge nodes must reference existing node IDs.\n          \n          Example:\n          {\n            \"nodes\": [\n              {\"id\": \"1\", \"type\": \"text\", \"text\": \"Hello\", \"x\": 0, \"y\": 0, \"width\": 200, \"height\": 50},\n              {\"id\": \"2\", \"type\": \"file\", \"file\": \"note.md\", \"subpath\": \"#heading\", \"x\": 250, \"y\": 0, \"width\": 200, \"height\": 100, \"color\": \"2\"},\n              {\"id\": \"3\", \"type\": \"group\", \"label\": \"Group\", \"x\": 0, \"y\": 100, \"width\": 300, \"height\": 150}\n            ],\n            \"edges\": [\n              {\"id\": \"e1-2\", \"fromNode\": \"1\", \"toNode\": \"2\", \"fromSide\": \"right\", \"toSide\": \"left\", \"color\": \"3\", \"label\": \"links to\"}\n            ]\n          }"
          },
          "path": {
            "description": "(Required) The path to the file to write to. \n          The path must end with explicit file extension, such as .md or .canvas .\n          Prefer to create new files in existing folders or root folder unless the user's request specifies otherwise.\n          The path must be relative to the root of the vault.",
            "type": "string"
          }
        },
        "required": [
          "path",
          "content"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Request to replace sections of content in an existing file using SEARCH/REPLACE blocks that define exact changes to specific parts of the file. This tool should be used when you need to make targeted changes to specific parts of a LARGE file.",
      "name": "replaceInFile",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "diff": {
            "description": "(Required) One or more SEARCH/REPLACE blocks. Each block MUST follow this exact format with these exact markers:\n\n------- SEARCH\n[exact content to find, including all whitespace and indentation]\n=======\n[new content to replace with]\n+++++++ REPLACE\n\nWHEN TO USE THIS TOOL vs writeToFile:\n- Use replaceInFile for: small edits, fixing typos, updating specific sections, targeted changes\n- Use writeToFile for: creating new files, major rewrites, when you can't identify specific text to replace\n\nCRITICAL RULES:\n1. SEARCH content must match EXACTLY - every character, space, and line break\n2. Use the exact markers: \"------- SEARCH\", \"=======\", \"+++++++ REPLACE\"\n3. For multiple changes, include multiple SEARCH/REPLACE blocks in order\n4. Keep blocks concise - include only the lines being changed plus minimal context\n\nCOMMON MISTAKES TO AVOID:\n- Wrong: Using different markers like \"---- SEARCH\" or \"SEARCH -------\"\n- Wrong: Including too many unchanged lines\n- Wrong: Not matching whitespace/indentation exactly",
            "type": "string"
          },
          "path": {
            "description": "(Required) The path of the file to modify (relative to the root of the vault and include the file extension).",
            "type": "string"
          }
        },
        "required": [
          "path",
          "diff"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Get transcripts of YouTube videos when the user provides YouTube URLs",
      "name": "youtubeTranscription",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "_userMessageContent": {
            "description": "Internal: user message content injected by the system",
            "type": "string"
          }
        },
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Get the file tree as a nested structure of folders and files",
      "name": "getFileTree",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {},
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Get the list of tags in the vault with occurrence statistics.",
      "name": "getTagList",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "description": "Parameters for retrieving the tag list.",
        "properties": {
          "includeInline": {
            "description": "Include inline tags in addition to frontmatter tags. Defaults to true.",
            "type": "boolean"
          },
          "maxEntries": {
            "description": "Maximum number of tag entries to return, sorted by occurrences. Responses are capped at ~500KB.",
            "maximum": 5000,
            "minimum": 1,
            "type": "integer"
          }
        },
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  },
  {
    "function": {
      "description": "Update the user memory when the user explicitly asks to update the memory",
      "name": "updateMemory",
      "parameters": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "statement": {
            "description": "The user statement for explicitly updating saved memories",
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "statement"
        ],
        "type": "object"
      },
      "strict": null
    },
    "type": "function"
  }
]
```
