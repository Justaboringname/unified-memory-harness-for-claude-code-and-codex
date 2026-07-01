import { test } from "node:test";
import assert from "node:assert/strict";
import { dispWidth, wrapDisplay, padDisplay, renderPanel, renderSideBySide, stripAnsi } from "../src/cli/render.ts";

test("dispWidth: CJK counts 2 columns, latin 1", () => {
  assert.equal(dispWidth("abc"), 3);
  assert.equal(dispWidth("中文"), 4);
  assert.equal(dispWidth("N和NP"), 5);
  assert.equal(dispWidth("\x1b[1m中\x1b[0m"), 2, "ANSI stripped before measuring");
});

test("dispWidth: emoji count 2 columns, joiners/selectors 0", () => {
  assert.equal(dispWidth("👋"), 2);
  assert.equal(dispWidth("🔍"), 2);
  assert.equal(dispWidth("✅"), 2, "BMP emoji-presentation");
  assert.equal(dispWidth("⭐"), 2);
  assert.equal(dispWidth("👋🏻"), 2, "skin-tone modifier is zero-width");
  assert.equal(dispWidth("你好!👋"), 7, "2+2+1+2");
  assert.equal(dispWidth("⏱"), 1, "text-presentation symbol stays narrow");
});

test("renderPanel rows stay aligned with emoji in the body", () => {
  const rows = renderPanel({ title: "T", body: "你好!👋 我可以帮你:\n- 🔍 理解代码 / 调查问题\n- ✅ 验证修复" }, 40);
  for (const r of rows) assert.equal(dispWidth(stripAnsi(r)), 40, `row "${stripAnsi(r)}"`);
});

test("wrapDisplay: respects display width for mixed CJK/latin", () => {
  const lines = wrapDisplay("计算机科学里的 NP 问题 complexity theory", 10);
  for (const l of lines) assert.ok(dispWidth(l) <= 10, `"${l}" is ${dispWidth(l)} cols`);
  assert.ok(lines.length >= 3);
});

test("wrapDisplay: preserves paragraph breaks", () => {
  const lines = wrapDisplay("第一段\n\n第二段", 20);
  assert.deepEqual(lines, ["第一段", "", "第二段"]);
});

test("padDisplay: pads and truncates to exact width", () => {
  assert.equal(dispWidth(padDisplay("中", 6)), 6);
  assert.equal(dispWidth(padDisplay("很长很长很长的标题啊", 8)), 8, "truncated to width");
});

test("renderPanel: every row is exactly the panel width", () => {
  const rows = renderPanel({ title: "Claude · sonnet · effort xhigh", body: "NP 是 nondeterministic polynomial 的缩写,表示可在多项式时间内验证。", footer: "⏱ 1.0s" }, 44);
  for (const r of rows) assert.equal(dispWidth(stripAnsi(r)), 44, `row "${stripAnsi(r)}"`);
});

test("renderSideBySide: wide terminal gives two aligned columns", () => {
  const out = renderSideBySide(
    { title: "Claude", body: "左边的回答内容" },
    { title: "Codex", body: "right side answer text" },
    120,
  );
  const rows = out.split("\n");
  assert.ok(rows.length >= 3);
  const w = dispWidth(stripAnsi(rows[0]!));
  for (const r of rows) assert.ok(Math.abs(dispWidth(stripAnsi(r)) - w) <= 1, "rows align");
});

test("renderSideBySide: narrow terminal stacks panels", () => {
  const out = renderSideBySide({ title: "A", body: "x" }, { title: "B", body: "y" }, 60);
  assert.ok(out.includes("\n\n"), "stacked with a blank line between panels");
});
