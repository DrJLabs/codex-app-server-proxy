# Disable Codex Built-in Tools by Default Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Default-disable Codex `shell_tool` and `unified_exec` for all environments via app-server supervisor config overrides, with explicit opt-in env flags.

**Architecture:** Add proxy-level config flags (`PROXY_DISABLE_SHELL_TOOL`, `PROXY_DISABLE_UNIFIED_EXEC`) defaulting to `true`, and wire them into the app-server supervisor argument builder so the spawned Codex process receives `-c features.shell_tool=false` and `-c features.unified_exec=false` by default.

**Tech Stack:** Node.js (Express), Vitest, Docker Compose, Codex CLI app-server.

---

### Task 1: Add failing supervisor test for default-disable flags

**Files:**
- Modify: `tests/unit/worker-supervisor.test.js`

**Step 1: Write the failing test**

Add a new test that asserts the spawn args include the feature disables by default.

```js
  test("launch args disable shell_tool and unified_exec by default", () => {
    const args = spawnCodexSpy.mock.calls[0]?.[0] ?? [];
    expect(args).toContain('features.shell_tool="false"');
    expect(args).toContain('features.unified_exec="false"');
  });
```

If you decide to be explicit about the env defaults, add this to `beforeEach`:
```js
  process.env.PROXY_DISABLE_SHELL_TOOL = "true";
  process.env.PROXY_DISABLE_UNIFIED_EXEC = "true";
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/worker-supervisor.test.js`

Expected: FAIL because the args currently do not include `features.shell_tool="false"` or `features.unified_exec="false"`.

**Step 3: Write minimal implementation**

(Deferred to Task 2)

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/worker-supervisor.test.js`

Expected: PASS

**Step 5: Commit**

(Deferred to Task 3)

---

### Task 2: Wire config flags into supervisor args

**Files:**
- Modify: `src/config/index.js`
- Modify: `src/services/worker/supervisor.js`

**Step 1: Write minimal implementation**

Add config defaults in `src/config/index.js`:
```js
  PROXY_DISABLE_SHELL_TOOL: bool("PROXY_DISABLE_SHELL_TOOL", "true"),
  PROXY_DISABLE_UNIFIED_EXEC: bool("PROXY_DISABLE_UNIFIED_EXEC", "true"),
```

Update `buildSupervisorArgs()` in `src/services/worker/supervisor.js`:
```js
  if (CFG.PROXY_DISABLE_SHELL_TOOL) {
    pushConfig("features.shell_tool", quote("false"));
  }

  if (CFG.PROXY_DISABLE_UNIFIED_EXEC) {
    pushConfig("features.unified_exec", quote("false"));
  }
```

**Step 2: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/worker-supervisor.test.js`

Expected: PASS

---

### Task 3: Document new env flags

**Files:**
- Modify: `.env.example`
- Modify: `.env.dev.example`
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/README-root.md`

**Step 1: Update env examples**

Add entries with defaults:
```
PROXY_DISABLE_SHELL_TOOL=true
PROXY_DISABLE_UNIFIED_EXEC=true
```

**Step 2: Update config tables**

Add rows to the minimal configuration tables and the configuration doc.

**Step 3: Verify formatting**

Run: `npm run format:check`

Expected: PASS

---

### Task 4: Commit changes

**Files:**
- Stage: all modified files from Tasks 1–3

**Step 1: Commit**

```bash
git add tests/unit/worker-supervisor.test.js src/config/index.js src/services/worker/supervisor.js .env.example .env.dev.example README.md docs/configuration.md docs/README-root.md
```

```bash
git commit -m "feat: disable codex shell and unified exec by default"
```

---

## Verification Checklist
- [ ] `npm run test:unit -- tests/unit/worker-supervisor.test.js` passes
- [ ] Docs updated in `.env.example`, `.env.dev.example`, `README.md`, `docs/configuration.md`, `docs/README-root.md`

