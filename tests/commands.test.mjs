import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const companion = new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url);

function makeFakeClaude(scriptBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
  fs.chmodSync(bin, 0o755);
  return { dir, bin };
}

function makeFakeClaudeExpectingMaxTurns(expected) {
  return makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--max-turns");
  if (args[index + 1] !== ${JSON.stringify(String(expected))}) {
    console.error("expected --max-turns ${expected}, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
}

test("setup writes a capabilities manifest and degrades background when lifecycle is unavailable", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log("logged in"); process.exit(0); }
if (args[0] === "logs") process.exit(2);
if (args[0] === "stop") process.exit(2);
if (args[0] === "attach") process.exit(2);
if (args[0] === "agents") process.exit(2);
if (args.includes("-p")) { console.log("{}"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "setup", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.ready, true);
  assert.equal(payload.capabilities.print, true);
  assert.equal(payload.capabilities.background, false);
});

test("review returns validated JSON and stores result", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  console.log(JSON.stringify({findings:[{severity:"MAJOR",title:"Gap",fact:"No test",recommendation:"Add test"}]}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = {
    ...process.env,
    PATH: `${fake.dir}:${process.env.PATH}`,
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: "thread-a"
  };
  const stdout = execFileSync(process.execPath, [companion.pathname, "review", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.result.findings[0].severity, "MAJOR");

  const result = execFileSync(process.execPath, [companion.pathname, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(result).job.id, payload.jobId);
});

test("background advise stores Claude session id and cancel calls claude stop", () => {
  const stopLog = path.join(os.tmpdir(), `fake-stop-${Date.now()}.log`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") { console.log("latest output"); process.exit(0); }
if (args[0] === "stop") { fs.writeFileSync(${JSON.stringify(stopLog)}, args[1]); console.log("stopped " + args[1]); process.exit(0); }
if (args[0] === "agents") { console.log("11 active agents"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion.pathname, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");

  const cancel = execFileSync(process.execPath, [companion.pathname, "cancel", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(cancel).status, "cancelled");
  assert.equal(fs.readFileSync(stopLog, "utf8"), "bg123");

  const result = execFileSync(process.execPath, [companion.pathname, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.job.status, "cancelled");
  assert.equal(stored.result, "latest output");
  assert.equal(stored.job.lastMeaningfulOutput, "latest output");
});

test("review defaults to a single Claude turn", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--max-turns");
  if (args[index + 1] !== "1") {
    console.error("expected --max-turns 1, got " + args[index + 1]);
    process.exit(2);
  }
  console.log(JSON.stringify({findings:[]}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "review", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
});

test("monitor polls Claude logs and active agent state", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") { console.log("\\u001b7\\u001b[31mprogress: still working\\u001b[39m\\u001b8"); process.exit(0); }
if (args[0] === "agents") { console.log("bg123 running"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(process.execPath, [companion.pathname, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const job = JSON.parse(launched);
  const watched = execFileSync(
    process.execPath,
    [companion.pathname, "monitor", job.jobId, "--interval-ms", "1", "--max-checks", "2", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const snapshots = watched.trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].active, true);
  assert.equal(snapshots[0].logs.output, "progress: still working");

  const result = execFileSync(process.execPath, [companion.pathname, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.result, "progress: still working");
  assert.equal(stored.job.lastMonitorSnapshot.summary.lastMeaningfulLine, "progress: still working");
});

test("monitor summarizes meaningful progress and stale repeated logs", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") {
  console.log("Claude Code");
  console.log("✻ Thinking with xhigh effort");
  console.log("❯");
  console.log("progress: compiling tests");
  console.log("Zigzagging…");
  process.exit(0);
}
if (args[0] === "agents") { console.log("bg123 running"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(process.execPath, [companion.pathname, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const job = JSON.parse(launched);
  const watched = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "monitor",
      job.jobId,
      "--interval-ms",
      "1",
      "--max-checks",
      "2",
      "--stale-after-ms",
      "0",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const snapshots = watched.trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(snapshots[0].summary.state, "active");
  assert.equal(snapshots[0].summary.lastMeaningfulLine, "progress: compiling tests");
  assert.equal(snapshots[0].summary.stale, false);
  assert.equal(snapshots[0].summary.suggestedAction, "Wait or keep monitoring.");
  assert.equal(snapshots[1].summary.stale, true);
  assert.match(snapshots[1].summary.suggestedAction, /stalled/i);

  const human = execFileSync(
    process.execPath,
    [companion.pathname, "monitor", job.jobId, "--interval-ms", "1", "--max-checks", "1"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.match(human, /Last meaningful output: progress: compiling tests/);
  assert.doesNotMatch(human, /Thinking with xhigh effort/);
});

test("monitor treats cooked Claude background logs as completed and extracts the answer", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") {
  console.log("Claude Codev2.1.132");
  console.log("Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.");
  console.log("at refresh (internal:util/colors:18:31)");
  console.log("at loadAssertionError (node:assert:28:96)");
  console.log("▝▜█████▛▘Opus 4.7 with xhigh effort");
  console.log("▘▘ ▝▝  ~/Documents/GitHub/claude-plugin-codex");
  console.log("❯ Return exactly PASS.");
  console.log("✳Hyperspacing…");
  console.log("Honking…2");
  console.log("Whisking…2");
  console.log("⏺PASS");
  console.log("✻Cogitated for 6s");
  console.log("❯");
  process.exit(0);
}
if (args[0] === "agents") { console.log("11 active agents"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(process.execPath, [companion.pathname, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const job = JSON.parse(launched);
  const watched = execFileSync(process.execPath, [companion.pathname, "monitor", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const snapshot = JSON.parse(watched.trim());

  assert.equal(snapshot.active, false);
  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.summary.state, "inactive");
  assert.equal(snapshot.summary.lastMeaningfulLine, "PASS");

  const result = execFileSync(process.execPath, [companion.pathname, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.job.status, "completed");
  assert.equal(stored.result, "PASS");
});

test("foreground advise defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "advise", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground do defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "do", "inspect local code", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground rescue defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "rescue", "diagnose the failure", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground task max-turn override takes precedence over the default", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(5);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(
    process.execPath,
    [companion.pathname, "do", "--max-turns", "5", "inspect local code", "--json"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground task max-turn failure includes rerun hint", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  console.error("Claude hit max turns before producing a result.");
  process.exit(1);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "do", "inspect local code", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "failed");
  assert.match(payload.output, /Claude hit the max-turn limit/);
  assert.match(payload.output, /--max-turns <higher>/);
});

test("foreground advise defaults to xhigh effort", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--effort");
  if (args[index + 1] !== "xhigh") {
    console.error("expected --effort xhigh, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "advise", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("background advise defaults to xhigh effort", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  const index = args.indexOf("--effort");
  if (args[index + 1] !== "xhigh") {
    console.error("expected --effort xhigh, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("backgrounded · bg123 (idle - send a prompt to start)");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "advise", "--background", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");
});

test("background advise refuses project MCP config unless explicitly allowed", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.error("background should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  fs.writeFileSync(path.join(stateRoot, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  const result = spawnSync(process.execPath, [companion.pathname, "advise", "--background", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.mcp\.json/);
  assert.match(result.stderr, /--allow-mcp/);
});

test("background advise refuses MCP config above a nested worktree", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.error("background should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "claude-parent-mcp-"));
  const child = path.join(parent, ".worktrees", "task");
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  fs.writeFileSync(path.join(child, ".git"), "gitdir: ../.git/worktrees/task\n", "utf8");
  const result = spawnSync(process.execPath, [companion.pathname, "advise", "--background", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: parent },
    cwd: child,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.mcp\\.json`));
  assert.match(result.stderr, /--allow-mcp/);
});

test("background advise allows project MCP only with explicit opt-in", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  if (args.includes("--mcp-config") || args.includes("--strict-mcp-config")) {
    console.error("expected explicit MCP opt-in to avoid empty strict config");
    process.exit(2);
  }
  console.log("backgrounded · bg123 (idle - send a prompt to start)");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  fs.writeFileSync(path.join(stateRoot, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  const stdout = execFileSync(
    process.execPath,
    [companion.pathname, "advise", "--background", "--allow-mcp", "check architecture", "--json"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");
});

test("read-only do defaults to local read-only tools without WebFetch", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const tools = args[args.indexOf("--tools") + 1];
  if (tools !== "Read,Glob,Grep") {
    console.error("expected local read-only tools, got " + tools);
    process.exit(2);
  }
  console.log("done");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "do", "inspect local code", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "done");
});

test("foreground advise falls back to background on timeout", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.log("backgrounded · bg123 (idle - send a prompt to start)");
  process.exit(0);
}
if (args.includes("-p")) {
  setTimeout(() => {}, 5000);
} else {
  console.error("unsupported"); process.exit(2);
}
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(
    process.execPath,
    [companion.pathname, "advise", "--timeout-ms", "50", "check architecture", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");
  assert.match(payload.output, /Foreground Claude timed out/);

  const status = execFileSync(process.execPath, [companion.pathname, "status", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(status).job.fallbackReason, "foreground-timeout");
});

test("foreground advise can disable timeout background fallback", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  setTimeout(() => {}, 5000);
} else {
  console.error("unsupported"); process.exit(2);
}
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(
    process.execPath,
    [companion.pathname, "advise", "--timeout-ms", "50", "--no-background-fallback", "slow"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out/);
});

test("foreground advise prints human output by default", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) { console.log("human answer"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion.pathname, "advise", "check architecture"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.equal(stdout, "human answer\n");
});

test("rescue runs as a managed task and preserves explicit write mode", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("default")) {
    console.error("expected write-capable default permission mode");
    process.exit(2);
  }
  console.log("rescued");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion.pathname, "rescue", "--write", "fix the failing test", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^rescue-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "rescued");

  const result = execFileSync(process.execPath, [companion.pathname, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(result).job.write, true);
});

test("rescue is read-only unless --write is explicit", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("plan")) {
    console.error("expected plan permission mode");
    process.exit(2);
  }
  console.log("diagnosis only");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion.pathname, "rescue", "diagnose the failure", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^rescue-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "diagnosis only");
});

test("do runs a prepared Claude task and preserves explicit write mode", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("default")) {
    console.error("expected write-capable default permission mode");
    process.exit(2);
  }
  if (!args.includes("--model") || args[args.indexOf("--model") + 1] !== "sonnet") {
    console.error("expected explicit sonnet model");
    process.exit(2);
  }
  console.log("done");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(
    process.execPath,
    [companion.pathname, "do", "--write", "--model", "sonnet", "implement the prepared task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^do-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "done");
});

test("foreground timeout fails the job without hanging", () => {
  const fake = makeFakeClaude(`
setTimeout(() => {}, 5000);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(process.execPath, [companion.pathname, "advise", "--timeout-ms", "50", "--no-background-fallback", "slow"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out/);
});

test("do write task passes explicit permission options as exact argv values", () => {
  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shared-dirs-"));
  const firstDir = path.join(sharedRoot, "one dir");
  const secondDir = path.join(sharedRoot, "second");
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const mode = args[args.indexOf("--permission-mode") + 1];
  if (mode !== "acceptEdits") {
    console.error("expected --permission-mode acceptEdits, got " + mode);
    process.exit(2);
  }
  const dirs = args.filter((value, index) => args[index - 1] === "--add-dir");
  if (dirs.length !== 2 || dirs[0] !== ${JSON.stringify(firstDir)} || dirs[1] !== ${JSON.stringify(secondDir)}) {
    console.error("expected two separate --add-dir values, got " + JSON.stringify(dirs));
    process.exit(2);
  }
  const allowed = args.filter((value, index) => args[index - 1] === "--allowed-tools");
  if (allowed.length !== 1 || allowed[0] !== "Bash(npm test)") {
    console.error("expected --allowed-tools 'Bash(npm test)' as one argv value, got " + JSON.stringify(allowed));
    process.exit(2);
  }
  const disallowed = args.filter((value, index) => args[index - 1] === "--disallowed-tools");
  if (disallowed.length !== 1 || disallowed[0] !== "WebSearch") {
    console.error("unexpected --disallowed-tools " + JSON.stringify(disallowed));
    process.exit(2);
  }
  if (args.includes("--model")) {
    console.error("must not force a model");
    process.exit(2);
  }
  if (!args.includes("--mcp-config") || !args.includes("--strict-mcp-config") || !args.includes("--no-chrome")) {
    console.error("missing MCP isolation flags");
    process.exit(2);
  }
  console.log("done");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "do",
      "--write",
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      firstDir,
      "--add-dir",
      secondDir,
      "--allowed-tools",
      "Bash(npm test)",
      "--disallowed-tools",
      "WebSearch",
      "run the prepared task",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.permissionConfig.mode, "acceptEdits");

  const result = execFileSync(process.execPath, [companion.pathname, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.deepEqual(JSON.parse(result).job.permissionConfig, {
    mode: "acceptEdits",
    addDirs: [firstDir, secondDir],
    allowedTools: ["Bash(npm test)"],
    disallowedTools: ["WebSearch"]
  });
});

test("permission options without --write fail clearly", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p") || args[0] === "--bg") {
  console.error("should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const doResult = spawnSync(
    process.execPath,
    [companion.pathname, "do", "--allowed-tools", "Bash(npm test)", "run the task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(doResult.status, 0);
  assert.match(doResult.stderr, /--write/);

  const rescueResult = spawnSync(
    process.execPath,
    [companion.pathname, "rescue", "--add-dir", "/tmp", "diagnose", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(rescueResult.status, 0);
  assert.match(rescueResult.stderr, /--write/);
});

test("permission-mode validation rejects bypassPermissions and unsupported values", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p") || args[0] === "--bg") {
  console.error("should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };

  const bypass = spawnSync(
    process.execPath,
    [companion.pathname, "do", "--write", "--permission-mode", "bypassPermissions", "task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(bypass.status, 0);
  assert.match(bypass.stderr, /bypassPermissions/);

  const unsupported = spawnSync(
    process.execPath,
    [companion.pathname, "do", "--write", "--permission-mode", "auto", "task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /default, acceptEdits, dontAsk/);
});

test("mixed-case permission modes normalize to canonical values", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const mode = args[args.indexOf("--permission-mode") + 1];
  if (mode !== "acceptEdits") {
    console.error("expected canonical acceptEdits, got " + mode);
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(
    process.execPath,
    [companion.pathname, "do", "--write", "--permission-mode", "AcceptEdits", "task", "--json"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  assert.equal(JSON.parse(stdout).status, "completed");
});

test("unknown and repeated flags fail clearly", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p") || args[0] === "--bg") {
  console.error("should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };

  const unknown = spawnSync(
    process.execPath,
    [companion.pathname, "do", "--bogus-flag", "value", "task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown option/);

  const repeated = spawnSync(
    process.execPath,
    [
      companion.pathname,
      "do",
      "--write",
      "--permission-mode",
      "default",
      "--permission-mode",
      "acceptEdits",
      "task",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /once/);
});

test("review rejects permission options as read-only", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  console.error("review should not gain permissions");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(
    process.execPath,
    [companion.pathname, "review", "--allowed-tools", "Bash(git diff)", "--json"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /read-only/);
});

test("timeout fallback carries the same permission options into background", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  const mode = args[args.indexOf("--permission-mode") + 1];
  if (mode !== "acceptEdits") {
    console.error("expected --permission-mode acceptEdits in background, got " + mode);
    process.exit(2);
  }
  const allowed = args.filter((value, index) => args[index - 1] === "--allowed-tools");
  if (allowed.length !== 1 || allowed[0] !== "Bash(npm test)") {
    console.error("expected --allowed-tools in background, got " + JSON.stringify(allowed));
    process.exit(2);
  }
  console.log("backgrounded · bg123 (idle - send a prompt to start)");
  process.exit(0);
}
if (args.includes("-p")) {
  setTimeout(() => {}, 5000);
} else {
  console.error("unsupported"); process.exit(2);
}
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "do",
      "--write",
      "--permission-mode",
      "acceptEdits",
      "--allowed-tools",
      "Bash(npm test)",
      "--timeout-ms",
      "50",
      "run the task",
      "--json"
    ],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");
  assert.equal(payload.permissionConfig.mode, "acceptEdits");
});

test("explicit resume reuses the persisted permission config", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg777 (idle - send a prompt to start)"); process.exit(0); }
if (args.includes("-p")) {
  const resume = args[args.indexOf("--resume") + 1];
  if (resume !== "bg777") {
    console.error("expected --resume bg777, got " + resume);
    process.exit(2);
  }
  const mode = args[args.indexOf("--permission-mode") + 1];
  if (mode !== "acceptEdits") {
    console.error("expected persisted --permission-mode acceptEdits, got " + mode);
    process.exit(2);
  }
  const allowed = args.filter((value, index) => args[index - 1] === "--allowed-tools");
  if (allowed.length !== 1 || allowed[0] !== "Bash(npm test)") {
    console.error("expected persisted --allowed-tools, got " + JSON.stringify(allowed));
    process.exit(2);
  }
  console.log("resumed");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "do",
      "--background",
      "--write",
      "--permission-mode",
      "acceptEdits",
      "--allowed-tools",
      "Bash(npm test)",
      "run the task",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const job = JSON.parse(launched);
  assert.equal(job.claudeSessionId, "bg777");
  assert.equal(job.permissionConfig.mode, "acceptEdits");

  const stdout = execFileSync(
    process.execPath,
    [companion.pathname, "rescue", "--write", "--resume", "--job-id", job.jobId, "continue the task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);
  assert.equal(payload.status, "completed");
  assert.equal(payload.permissionConfig.mode, "acceptEdits");
});

test("resume with new explicit permission options replaces the persisted config", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg778 (idle - send a prompt to start)"); process.exit(0); }
if (args.includes("-p")) {
  const mode = args[args.indexOf("--permission-mode") + 1];
  if (mode !== "default") {
    console.error("expected explicit --permission-mode default, got " + mode);
    process.exit(2);
  }
  const allowed = args.filter((value, index) => args[index - 1] === "--allowed-tools");
  if (allowed.length !== 1 || allowed[0] !== "Bash(ls)") {
    console.error("expected explicit --allowed-tools 'Bash(ls)', got " + JSON.stringify(allowed));
    process.exit(2);
  }
  console.log("resumed");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "do",
      "--background",
      "--write",
      "--permission-mode",
      "acceptEdits",
      "--allowed-tools",
      "Bash(npm test)",
      "run the task",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const job = JSON.parse(launched);

  const stdout = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "rescue",
      "--write",
      "--resume",
      "--job-id",
      job.jobId,
      "--permission-mode",
      "default",
      "--allowed-tools",
      "Bash(ls)",
      "continue the task",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.permissionConfig.allowedTools, ["Bash(ls)"]);
});

test("monitor classifies visible approval prompts as awaiting_permission", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg409 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") {
  console.log("\\u001b[32m\\u2bfa\\u001b[39m Bash(npm test)");
  console.log("\\u001b[7m\\u001b[1mDo you want to proceed?\\u001b[27m\\u001b[22m");
  console.log("\\u276f 1. Yes");
  console.log("  2. Yes, and don't ask again for this command");
  console.log("  3. No, and tell Claude what to do differently (esc)");
  process.exit(0);
}
if (args[0] === "agents") { console.log("bg409 running"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "do",
      "--background",
      "--write",
      "--permission-mode",
      "acceptEdits",
      "--allowed-tools",
      "Bash(npm test)",
      "run the tests",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const job = JSON.parse(launched);
  const watched = execFileSync(
    process.execPath,
    [companion.pathname, "monitor", job.jobId, "--max-checks", "1", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const snapshot = JSON.parse(watched.trim());

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.summary.state, "awaiting_permission");
  assert.equal(snapshot.summary.awaitingPermission, true);
  assert.equal(snapshot.summary.permissionPrompt, "Do you want to proceed?");
  assert.match(snapshot.summary.pendingAction, /Do you want to proceed\?/);
  assert.match(snapshot.summary.nextAction, /never auto-approves/);
  assert.equal(snapshot.permissionConfig.mode, "acceptEdits");

  const human = execFileSync(
    process.execPath,
    [companion.pathname, "monitor", job.jobId, "--max-checks", "1"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.match(human, /Do you want to proceed\?/);
  assert.match(human, /Next action/);

  const result = execFileSync(process.execPath, [companion.pathname, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.job.status, "running");
});

test("monitor classifies worktree isolation rejection as needs_isolation", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg505 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") {
  console.log("\\u2bfa Write(.claude/settings.json)");
  console.log("\\u23bf Error: file edits in the shared checkout are rejected until you isolate.");
  console.log("  Set worktree.bgIsolation=none in the project .claude/settings.json, or use EnterWorktree.");
  process.exit(0);
}
if (args[0] === "agents") { console.log("bg505 running"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(
    process.execPath,
    [companion.pathname, "do", "--background", "--write", "update the config", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const job = JSON.parse(launched);
  const watched = execFileSync(
    process.execPath,
    [companion.pathname, "monitor", job.jobId, "--max-checks", "1", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const snapshot = JSON.parse(watched.trim());

  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.summary.state, "needs_isolation");
  assert.equal(snapshot.summary.blocked, true);
  assert.notEqual(snapshot.summary.state, "active");
  assert.match(snapshot.summary.pendingAction, /isolation/i);
  assert.match(snapshot.summary.nextAction, /--cwd/);

  const result = execFileSync(process.execPath, [companion.pathname, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(result).job.status, "running");
});

test("status and result surface the stored permission config", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg606 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") { console.log("working"); process.exit(0); }
if (args[0] === "agents") { console.log("bg606 running"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(
    process.execPath,
    [
      companion.pathname,
      "do",
      "--background",
      "--write",
      "--permission-mode",
      "dontAsk",
      "--allowed-tools",
      "Bash(npm test)",
      "run the task",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const job = JSON.parse(launched);

  const expectedConfig = {
    mode: "dontAsk",
    addDirs: [],
    allowedTools: ["Bash(npm test)"],
    disallowedTools: []
  };
  const status = execFileSync(process.execPath, [companion.pathname, "status", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.deepEqual(JSON.parse(status).job.permissionConfig, expectedConfig);

  const result = execFileSync(process.execPath, [companion.pathname, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.deepEqual(JSON.parse(result).job.permissionConfig, expectedConfig);
});

test("explicit shared working directory runs Claude in the authorized cwd", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) { console.log("cwd:" + process.cwd()); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "shared-cwd-"));
  const stdout = execFileSync(
    process.execPath,
    [companion.pathname, "do", "--cwd", target, "inspect the code", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.equal(JSON.parse(stdout).output, `cwd:${target}`);

  const relative = spawnSync(
    process.execPath,
    [companion.pathname, "do", "--cwd", "relative/path", "inspect", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /absolute/);

  const missing = spawnSync(
    process.execPath,
    [companion.pathname, "do", "--cwd", "/nonexistent/shared/dir", "inspect", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /existing directory/);
});
