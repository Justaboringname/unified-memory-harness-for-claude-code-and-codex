#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// ============================================================================
// ccc — Claude Code + Codex, side by side.
//
//   ccc <question>     ask both CLIs in parallel, show answers in two columns
//   ccc                interactive prompt loop
//
// Both agents run with their OWN CLI default model (no --model / -m is passed):
// claude reads ~/.claude/settings.json, codex reads ~/.codex/config.toml.
// The adversarial council (cross-review + synthesis) is OFF by default; pass
// --council to run it. --mock runs offline (free) for layout testing.
// ============================================================================
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../util/config.ts";
import { ClaudeCliAdapter } from "../agents/claude-adapter.ts";
import { CodexCliAdapter } from "../agents/codex-adapter.ts";
import { MockAdapter, type AgentAdapter, type CompleteResult } from "../agents/adapter.ts";
import { renderSideBySide, ANSI, type Panel } from "./render.ts";
import { banner, readBoxedLine } from "./prompt-box.ts";
import { openDb } from "../db/db.ts";
import { nowIso } from "../util/time.ts";

const HELP = `ccc — ask Claude Code and Codex the same question, side by side

USAGE
  ccc <question>            one-shot: both CLIs answer in parallel (their default models)
  ccc                       interactive loop (empty line or "exit" to quit)

FLAGS
  --council                 also run cross-review + synthesis (costs more, slower)
  --mock                    offline mock adapters (free; for layout testing)
  --timeout <seconds>       per-agent timeout (default 300)
  --config <path>           config file (default: repo config.json chain)
  --help                    this help

Models: none are forced — claude uses its own default (settings.json), codex its
own default (config.toml). Set agents.<name>.model in config to override.`;

// ---- default model/effort discovery (for the panel titles) ----
interface CliDefaults { model: string; effort: string; }
function claudeDefaults(claudeHome: string): CliDefaults {
  try {
    const s = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf-8"));
    return { model: s.model ?? "default", effort: s.effortLevel ?? "default" };
  } catch { return { model: "default", effort: "default" }; }
}
function codexDefaults(): CliDefaults {
  try {
    const t = readFileSync(join(homedir(), ".codex", "config.toml"), "utf-8");
    const model = t.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? "default";
    const effort = t.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "default";
    return { model, effort };
  } catch { return { model: "default", effort: "default" }; }
}

// ---- spinner (stderr; stdout stays clean for the final panels) ----
function startSpinner(label: () => string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    process.stderr.write(`\r\x1b[2K${frames[i++ % frames.length]} ${label()}`);
  }, 100);
  return () => { clearInterval(t); process.stderr.write("\r\x1b[2K"); };
}

interface SideResult {
  ok: boolean;
  text: string;
  seconds: number;
  costUsd?: number;
  tokens?: number;
  actualModel?: string;
}

async function askOne(adapter: AgentAdapter, question: string, workdir: string, timeoutMs: number, done: () => void): Promise<SideResult> {
  const t0 = Date.now();
  try {
    const r: CompleteResult = await adapter.complete(question, { workdir, timeoutMs });
    done();
    // claude's json envelope may report the actual model used
    const raw: any = r.raw;
    const mu = raw && typeof raw === "object" ? raw.modelUsage : undefined;
    const actualModel = mu && typeof mu === "object" ? Object.keys(mu)[0] : undefined;
    return { ok: true, text: r.text.trim() || "(空回答)", seconds: (Date.now() - t0) / 1000, costUsd: r.cost?.usd, tokens: r.cost?.tokens, actualModel };
  } catch (e: any) {
    done();
    return { ok: false, text: `请求失败:${String(e?.message ?? e).slice(0, 500)}`, seconds: (Date.now() - t0) / 1000 };
  }
}

function footerOf(s: SideResult): string {
  const parts = [`⏱ ${s.seconds.toFixed(1)}s`];
  if (s.costUsd != null) parts.push(`$${s.costUsd.toFixed(3)}`);
  if (s.tokens != null) parts.push(`${(s.tokens / 1000).toFixed(1)}k tokens`);
  return parts.join(" · ");
}

// ---- non-fatal audit recording ----
function record(cfg: Config, question: string, claude: SideResult, codex: SideResult, cTitle: string, xTitle: string): void {
  try {
    const db = openDb(cfg.dbPath);
    const ts = nowIso();
    const task = Number(db.db.prepare(
      `INSERT INTO tasks(title, question, mode, status, phase, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run(question.slice(0, 80), question, "qa", "done", "done", ts, ts).lastInsertRowid);
    for (const [agent, res, title] of [["claude", claude, cTitle], ["codex", codex, xTitle]] as const) {
      const art = Number(db.db.prepare(`INSERT INTO artifacts(task_id, kind, body, created_at) VALUES (?,?,?,?)`)
        .run(task, "analysis", res.text, ts).lastInsertRowid);
      db.db.prepare(
        `INSERT INTO agent_runs(task_id, agent, role, phase, status, model, adapter, started_at, ended_at, duration_ms, cost_json, output_ref, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(task, agent, "analyst", "qa", res.ok ? "done" : "failed", title, agent, ts, ts, Math.round(res.seconds * 1000),
        JSON.stringify({ usd: res.costUsd, tokens: res.tokens }), art, res.ok ? null : res.text.slice(0, 200));
    }
    db.audit({ actor: "user", action: "ccc.qa", entityType: "task", entityId: task });
    db.close();
  } catch { /* recording must never break the UX */ }
}

async function runOnce(question: string, cfg: Config, opts: { mock: boolean; council: boolean; timeoutMs: number }): Promise<void> {
  const cd = claudeDefaults(cfg.claudeHome);
  const xd = codexDefaults();
  const claude: AgentAdapter = opts.mock ? new MockAdapter("claude") : new ClaudeCliAdapter(cfg.agents.claude.model);
  const codex: AgentAdapter = opts.mock ? new MockAdapter("codex") : new CodexCliAdapter(cfg.agents.codex.model);
  const cModel = cfg.agents.claude.model ?? cd.model;
  const xModel = cfg.agents.codex.model ?? xd.model;
  const cTitle = opts.mock ? "Claude · mock" : `Claude · ${cModel} · effort ${cd.effort}`;
  const xTitle = opts.mock ? "Codex · mock" : `Codex · ${xModel} · effort ${xd.effort}`;

  // both agents answer from an empty scratch dir so codex doesn't wander a repo
  const scratch = mkdtempSync(join(tmpdir(), "ccc-"));
  let cDone = false, xDone = false;
  const t0 = Date.now();
  const stop = startSpinner(() => {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    return `${cDone ? "✓ Claude" : "… Claude"}  ${xDone ? "✓ Codex" : "… Codex"}  ${el}s`;
  });
  const [cRes, xRes] = await Promise.all([
    askOne(claude, question, scratch, opts.timeoutMs, () => { cDone = true; }),
    askOne(codex, question, scratch, opts.timeoutMs, () => { xDone = true; }),
  ]);
  stop();
  rmSync(scratch, { recursive: true, force: true });

  const left: Panel = {
    title: cRes.actualModel ? `Claude · ${cRes.actualModel} · effort ${cd.effort}` : cTitle,
    titleColor: ANSI.orange,
    body: cRes.ok ? cRes.text : `${ANSI.red}✗${ANSI.reset} ${cRes.text}`,
    footer: footerOf(cRes),
  };
  const right: Panel = {
    title: xTitle,
    titleColor: ANSI.cyan,
    body: xRes.ok ? xRes.text : `${ANSI.red}✗${ANSI.reset} ${xRes.text}`,
    footer: footerOf(xRes),
  };
  console.log();
  console.log(renderSideBySide(left, right, process.stdout.columns ?? 120));
  console.log();
  record(cfg, question, cRes, xRes, left.title, right.title);

  if (opts.council) {
    console.log(`${ANSI.dim}── council(交叉互审 + 综合)──${ANSI.reset}`);
    const { runCouncil } = await import("../orchestrator/council.ts");
    const db = openDb(cfg.dbPath);
    try {
      const res = await runCouncil(db, claude, codex, { question });
      console.log(`${ANSI.bold}Claude→Codex${ANSI.reset} ${res.claudeReviewOfCodex.verdict}: ${res.claudeReviewOfCodex.disagreements.join("; ") || "无异议"}`);
      console.log(`${ANSI.bold}Codex→Claude${ANSI.reset} ${res.codexReviewOfClaude.verdict}: ${res.codexReviewOfClaude.disagreements.join("; ") || "无异议"}`);
      console.log(`\n${ANSI.bold}综合${ANSI.reset}\n${res.synthesis.finalAnswer}`);
    } finally { db.close(); }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = { mock: false, council: false, timeoutMs: 300000, config: undefined as string | undefined };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") { console.log(HELP); return; }
    else if (a === "--mock") flags.mock = true;
    else if (a === "--council") flags.council = true;
    else if (a === "--timeout") flags.timeoutMs = parseInt(argv[++i] ?? "300", 10) * 1000;
    else if (a === "--config") flags.config = argv[++i];
    else positional.push(a);
  }
  const cfg = loadConfig(flags.config);
  const question = positional.join(" ").trim();

  if (question) {
    await runOnce(question, cfg, flags);
    return;
  }
  // interactive TUI loop — Claude-Code-style banner + bordered input box
  const cd = claudeDefaults(cfg.claudeHome);
  const xd = codexDefaults();
  const sub = flags.mock
    ? "mock 模式(离线免费)"
    : `Claude ${cfg.agents.claude.model ?? cd.model} ‖ Codex ${cfg.agents.codex.model ?? xd.model}${flags.council ? " · council 开" : ""}`;
  console.log();
  console.log(banner(sub, process.stdout.columns ?? 100));
  console.log();
  for (;;) {
    const q = await readBoxedLine("问点什么", "例如:计算机的 N 和 NP 是什么意思?");
    if (q === null) break;
    await runOnce(q, cfg, flags);
  }
  console.log(`${ANSI.dim}再见 👋${ANSI.reset}`);
}

main().catch((e) => { console.error(`ccc error: ${e?.stack ?? e}`); process.exit(1); });
