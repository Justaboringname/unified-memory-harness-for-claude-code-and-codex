import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, CompleteOpts, CompleteResult, StreamUpdate } from "./adapter.ts";
import { run, runStream, binaryAvailable } from "./spawn.ts";

/**
 * Codex CLI headless adapter.
 *   codex exec --json [--model] [-C <workdir>] [--skip-git-repo-check]
 *              [--output-schema <file>] --output-last-message <file> -
 * Prompt on stdin ("-"). Final structured message read from --output-last-message.
 * Sandbox defaults to read-only for analysis; builder mode passes -s workspace-write.
 *
 * NOTE: requires an authenticated `codex` CLI; real runs may incur cost. Prefer
 * the mock adapter until the user authorises real runs.
 */
// GPT-5.5 API list price (USD per 1M tokens, verified 2026-07). Codex on a
// ChatGPT plan bills in credits, not dollars — this powers an "≈$" estimate.
const PRICE = { input: 5.0, cachedInput: 0.5, output: 30.0 };

/** Estimated cost from a codex usage event (API list-price equivalent). */
function estimateUsd(u: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number }): number {
  const cached = u.cached_input_tokens ?? 0;
  const fresh = Math.max(0, (u.input_tokens ?? 0) - cached);
  const out = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  return (fresh * PRICE.input + cached * PRICE.cachedInput + out * PRICE.output) / 1e6;
}

export class CodexCliAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly id = "codex";
  readonly displayName: string;
  private model?: string;
  private fast: boolean;
  constructor(model?: string, opts?: { fast?: boolean }) {
    this.model = model;
    this.fast = opts?.fast ?? false;
    this.displayName = `Codex CLI (${model ?? "default"}${this.fast ? ", fast" : ""})`;
  }

  /** Fast mode (official: service_tier=fast + features.fast_mode) — 1.5x speed, 2.5x credits on GPT-5.5. */
  private fastArgs(): string[] {
    return this.fast ? ["-c", 'service_tier="fast"', "--enable", "fast_mode"] : [];
  }

  async available() {
    const ok = await binaryAvailable("codex");
    return ok ? { ok: true } : { ok: false, reason: "`codex` CLI not found or not responding to --version" };
  }

  /**
   * Streaming completion over the `codex exec --json` event stream. Codex does
   * not emit per-token deltas — agent_message items land whole on
   * item.completed — so updates are coarse; command/tool activity is surfaced
   * as a live status instead.
   */
  async stream(prompt: string, opts: CompleteOpts, onUpdate: (u: StreamUpdate) => void): Promise<CompleteResult> {
    const tmp = mkdtempSync(join(tmpdir(), "umem-codex-"));
    try {
      const lastMsg = join(tmp, "last.txt");
      const model = opts.model ?? this.model;
      // `exec resume <id>` continues a prior thread; it does NOT accept -s/-m/-C
      // (sandbox, model, and cwd are pinned by the original session).
      const args = opts.resume
        ? ["exec", "resume", opts.resume, "--json", "--skip-git-repo-check", "--output-last-message", lastMsg, ...this.fastArgs()]
        : ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "--output-last-message", lastMsg, ...this.fastArgs()];
      if (!opts.resume) {
        if (model) args.push("-m", model);
        if (opts.workdir) args.push("-C", opts.workdir);
      }
      const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
      args.push("-");

      const parts: string[] = [];
      let live = ""; // in-flight partial of the current message (item.updated)
      let usage: any;
      let threadId: string | undefined;
      let turnError = "";
      const text = () => [...parts, live].filter(Boolean).join("\n\n");
      onUpdate({ text: "", status: "连接中…" });
      const r = await runStream("codex", args, {
        stdin: fullPrompt,
        cwd: opts.workdir,
        timeoutMs: opts.timeoutMs ?? 300000,
        onLine: (line) => {
          if (!line.startsWith("{")) return;
          let ev: any;
          try { ev = JSON.parse(line); } catch { return; }
          if (ev?.type === "thread.started" && ev.thread_id) threadId = ev.thread_id;
          const item = ev?.item;
          if (item?.type === "agent_message" && typeof item.text === "string") {
            if (ev.type === "item.completed") { parts.push(item.text); live = ""; onUpdate({ text: text() }); }
            else { live = item.text; onUpdate({ text: text() }); } // item.started/updated (defensive)
          } else if (item?.type === "command_execution") {
            if (ev.type === "item.started") onUpdate({ text: text(), status: "运行命令中…" });
            else if (ev.type === "item.completed") onUpdate({ text: text(), status: "思考中…" });
          } else if (item?.type === "reasoning") {
            onUpdate({ text: text(), status: "推理中…" });
          } else if (ev.type === "turn.failed" || ev.type === "error") {
            turnError = JSON.stringify(ev.error ?? ev).slice(0, 300);
          }
          const u = ev?.msg?.usage ?? ev?.usage ?? ev?.token_usage;
          if (u) usage = u;
        },
      });
      const fileText = existsSync(lastMsg) ? readFileSync(lastMsg, "utf-8").trim() : "";
      const finalText = fileText || text();
      if (!finalText) {
        throw new Error(`codex exited ${r.code}${r.timedOut ? " (timeout)" : ""}: ${turnError || r.stderr.slice(0, 400) || "(no diagnostic output)"}`);
      }
      const cost = usage
        ? { tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0), usd: estimateUsd(usage), estimated: true }
        : undefined;
      return { text: finalText, cost, adapter: this.id, model, sessionId: threadId ?? opts.resume, raw: { stderrTail: r.stderr.slice(-200), usage } };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<CompleteResult> {
    const tmp = mkdtempSync(join(tmpdir(), "umem-codex-"));
    try {
      const lastMsg = join(tmp, "last.txt");
      const sandbox = (opts as any).sandbox ?? "read-only";
      const args = ["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "--output-last-message", lastMsg, ...this.fastArgs()];
      const model = opts.model ?? this.model;
      if (model) args.push("-m", model);
      if (opts.workdir) args.push("-C", opts.workdir);
      if (opts.schema) {
        const sf = join(tmp, "schema.json");
        writeFileSync(sf, JSON.stringify(opts.schema));
        args.push("--output-schema", sf);
      }
      // Codex has no dedicated system-prompt flag in `exec`; prepend it to the prompt.
      const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
      args.push("-"); // read prompt from stdin
      const r = await run("codex", args, { stdin: fullPrompt, cwd: opts.workdir, timeoutMs: opts.timeoutMs ?? 300000 });
      // `codex --json` emits errors as stdout EVENTS, not stderr. On failure,
      // mine the event stream for an error/turn.failed so the message is useful.
      // Also recover the last agent_message text if --output-last-message wasn't written.
      let eventText = "";
      let eventErr = "";
      for (const line of r.stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const ev = JSON.parse(t);
          const item = ev?.item;
          if (item?.type === "agent_message" && typeof item.text === "string") eventText = item.text;
          if (/error|failed/i.test(String(ev?.type)) || ev?.error) eventErr = JSON.stringify(ev).slice(0, 300);
        } catch { /* ignore */ }
      }
      const fileText = existsSync(lastMsg) ? readFileSync(lastMsg, "utf-8").trim() : "";
      const text = fileText || eventText;
      if (r.code !== 0 && !text) {
        throw new Error(`codex exited ${r.code}${r.timedOut ? " (timeout)" : ""}: ${eventErr || r.stderr.slice(0, 400) || "(no diagnostic output)"}`);
      }
      let json: any;
      if (opts.schema && text) {
        try { json = JSON.parse(text); } catch { json = undefined; }
      }
      // best-effort token usage from the JSONL event stream
      let usage: any;
      for (const line of r.stdout.split("\n")) {
        const t2 = line.trim();
        if (!t2.startsWith("{")) continue;
        try {
          const ev = JSON.parse(t2);
          const u = ev?.msg?.usage ?? ev?.usage ?? ev?.token_usage;
          if (u) usage = u;
        } catch { /* ignore */ }
      }
      const cost = usage
        ? { tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0), usd: estimateUsd(usage), estimated: true }
        : undefined;
      return { text, json, cost, adapter: this.id, model, raw: { stderrTail: r.stderr.slice(-200), usage } };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
