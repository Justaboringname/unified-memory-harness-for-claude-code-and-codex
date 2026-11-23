#!/usr/bin/env python3
"""README image kit: shared look for every repo's banner and figures.

Copy this whole file into <repo>/assets/build/gen.py, then add the repo's own
hero() (and any extra figure functions) at the bottom and list them in BUILDERS.
Each figure is ONE layout function fed a theme dict, so the dark and light
variants share geometry exactly and differ only in colour.

Run from the repo root:  python3 assets/build/gen.py
Writes assets/<name>-dark.svg and assets/<name>-light.svg.
Standard library only.
"""
import math
import os
import sys

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SANS = ('-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, '
        '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif')
MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

# Same palette as claude-code-model-routing. Do not add colours: two accents only
# (clay = the thing that matters / warm, sage = the supporting / healthy side).
THEMES = {
    "dark": dict(
        bg="#181818", panel="#212121", hair="#2f2f2f",
        text="#ecece8", muted="#9b9a94",
        clay="#d97757", sage="#9bb07c",
        grid="#2a2a2a", axis="#4b4a46", conn="#5a5955", dots="#3b3b39", node="#333332",
        band="#ecece8", band_op="0.055", band_label="#9b9a94",
    ),
    "light": dict(
        bg="#faf9f5", panel="#ffffff", hair="#e6e3d9",
        text="#1f1e1c", muted="#6f6d66",
        clay="#b3532f", sage="#5f7347",
        grid="#ebe8df", axis="#c4c0b4", conn="#c4bfb2", dots="#dcd8cd", node="#dedacf",
        band="#1f1e1c", band_op="0.045", band_label="#67655e",
    ),
}

# Hero geometry (keep identical across repos so the profile reads as one set)
HERO_W, HERO_H = 1280, 420
LEFT_X = 72                 # eyebrow / tagline x; title sits 4px left of it
TITLE_MAX_W = 560           # title must end before x = 632
RIGHT_X0, RIGHT_X1 = 660, 1216   # right-hand diagram lives in this band
DIAG_Y0, DIAG_Y1 = 56, 364


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def svg_open(w, h, title, desc=None):
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" role="img" aria-labelledby="t">',
        f'<title id="t">{esc(title)}</title>',
    ]
    if desc:
        out.append(f"<desc>{esc(desc)}</desc>")
    return out


def base_style(t, extra=""):
    return f"""<style>
.sans {{ font-family: {SANS}; }}
.mono {{ font-family: {MONO}; }}
.tx {{ fill: {t['text']}; }}
.mu {{ fill: {t['muted']}; }}
.clay {{ fill: {t['clay']}; }}
.sage {{ fill: {t['sage']}; }}
.eyebrow {{ font-size: 22px; letter-spacing: 4px; }}
.title {{ font-weight: 700; letter-spacing: -1.5px; }}
.tag {{ font-size: 28px; }}
.node {{ font-size: 24px; font-weight: 600; }}
.sub {{ font-size: 22px; }}
.cap {{ font-size: 22px; }}
.small {{ font-size: 20px; }}
.num {{ font-variant-numeric: tabular-nums; }}
{extra}</style>"""


def card(w, h, t):
    # 1px hairline border drawn on the half-pixel so it stays crisp.
    return (f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="20" '
            f'fill="{t["bg"]}" stroke="{t["hair"]}" stroke-width="1"/>')


def hero_left(eyebrow, title, taglines, title_size=76):
    """Left block of the hero: mono eyebrow, big wordmark, up to 3 tagline lines.

    eyebrow: short category in CAPS, e.g. "MACOS MENU-BAR APP" (<= ~24 chars)
    title:   the wordmark, usually the repo name or a shorter form of it
    taglines: 1-3 short lines (<= ~34 characters each at 28px)
    title_size: lower it (min 56) if the title would pass TITLE_MAX_W.
    """
    out = [f'<text class="mono eyebrow mu" x="{LEFT_X}" y="104">{esc(eyebrow)}</text>',
           f'<text class="sans title tx" x="{LEFT_X - 4}" y="190" '
           f'style="font-size:{title_size}px">{esc(title)}</text>']
    for i, line in enumerate(taglines[:3]):
        out.append(f'<text class="sans tag mu" x="{LEFT_X}" y="{250 + 40 * i}">{esc(line)}</text>')
    return out


# ---------------------------------------------------------------- primitives
def node(t, x, y, w, h, label, sub=None, dot="clay", rx=14):
    """Rounded panel with a coloured dot, a bold label and an optional muted sub-line.
    (x, y) is the top-left corner. Height 48 fits a label only; 100 fits label + sub."""
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
           f'fill="{t["panel"]}" stroke="{t["node"]}" stroke-width="1.5"/>']
    if sub is None:
        cy = y + h / 2
        if dot:
            out.append(f'<circle cx="{x + 22}" cy="{cy}" r="5" fill="{t[dot]}"/>')
        out.append(f'<text class="sans node tx" x="{x + (36 if dot else 20)}" y="{cy + 8}">{esc(label)}</text>')
    else:
        if dot:
            out.append(f'<circle cx="{x + 22}" cy="{y + 32}" r="5" fill="{t[dot]}"/>')
        out.append(f'<text class="sans node tx" x="{x + (36 if dot else 20)}" y="{y + 40}">{esc(label)}</text>')
        out.append(f'<text class="sans sub mu" x="{x + (36 if dot else 20)}" y="{y + 72}">{esc(sub)}</text>')
    return out


def curve(x1, y1, x2, y2, stem=22):
    """Horizontal S-curve connector path data from (x1,y1) to (x2,y2)."""
    s = x1 + stem
    c = (s + x2) / 2
    return f"M{x1} {y1} H{s} C{c} {y1} {c} {y2} {x2} {y2}"


def connectors(t, paths, width=2):
    out = [f'<g fill="none" stroke="{t["conn"]}" stroke-width="{width}" '
           'stroke-linecap="round" stroke-linejoin="round">']
    out += [f'<path d="{d}"/>' for d in paths]
    out.append("</g>")
    return out


def bar(t, x, y, w, h, frac, color="clay", track=True, rx=None):
    """Horizontal meter: a recessive track plus a filled part (0..1, may exceed 1)."""
    rx = h / 2 if rx is None else rx
    out = []
    if track:
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{t["grid"]}"/>')
    fw = max(h, w * frac)
    out.append(f'<rect x="{x}" y="{y}" width="{fw:.1f}" height="{h}" rx="{rx}" fill="{t[color]}"/>')
    return out


def arc_path(cx, cy, r, a0, a1):
    """SVG arc path, angles in degrees (0 = 3 o'clock, clockwise positive)."""
    x0, y0 = cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))
    x1, y1 = cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))
    large = 1 if abs(a1 - a0) > 180 else 0
    sweep = 1 if a1 > a0 else 0
    return f"M{x0:.1f} {y0:.1f} A{r} {r} 0 {large} {sweep} {x1:.1f} {y1:.1f}"


def monotone(xs, ys, step=0.25):
    """Fritsch-Carlson monotone cubic interpolation, sampled every `step`."""
    n = len(xs)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0] * (n - 2) + [d[-1]]
    for i in range(1, n - 1):
        m[i] = 0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = m[i + 1] = 0.0
            continue
        a, b = m[i] / d[i], m[i + 1] / d[i]
        h = a * a + b * b
        if h > 9:
            tau = 3 / math.sqrt(h)
            m[i], m[i + 1] = tau * a * d[i], tau * b * d[i]
    out = []
    for i in range(n - 1):
        x0, x1, y0, y1 = xs[i], xs[i + 1], ys[i], ys[i + 1]
        hh = x1 - x0
        k = max(1, int(round(hh / step)))
        for j in range(k):
            tt = j / k
            h00 = 2 * tt**3 - 3 * tt**2 + 1
            h10 = tt**3 - 2 * tt**2 + tt
            h01 = -2 * tt**3 + 3 * tt**2
            h11 = tt**3 - tt**2
            out.append((x0 + tt * hh, h00 * y0 + h10 * hh * m[i] + h01 * y1 + h11 * hh * m[i + 1]))
    out.append((xs[-1], ys[-1]))
    return out


def terminal(t, title, lines, markup=None, W=1280, bar_h=60, lh=35, size=23):
    """Terminal-window figure. `lines` are plain strings copied VERBATIM from the repo
    (README code blocks or real program output already in the repo, never invented).
    `markup(i, line)` may return inner markup for colouring a line (escape text with esc)."""
    first = bar_h + 56
    H = first + lh * (len(lines) - 1) + 46
    s = svg_open(W, H, f"Terminal: {title}. " + " / ".join(lines)[:600])
    s.append(base_style(t, f".term {{ font-size: {size}px; white-space: pre; }}\n"
                           ".wtitle { font-size: 22px; font-weight: 500; }\n"))
    s.append(f'<defs><clipPath id="win"><rect x="0.5" y="0.5" width="{W - 1}" '
             f'height="{H - 1}" rx="20"/></clipPath></defs>')
    s.append(card(W, H, t))
    s.append(f'<rect x="0" y="0" width="{W}" height="{bar_h}" fill="{t["panel"]}" clip-path="url(#win)"/>')
    s.append(f'<line x1="0" y1="{bar_h - 0.5}" x2="{W}" y2="{bar_h - 0.5}" stroke="{t["hair"]}" stroke-width="1"/>')
    s.append(f'<rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="20" fill="none" '
             f'stroke="{t["hair"]}" stroke-width="1"/>')
    for k in range(3):
        s.append(f'<circle cx="{38 + 26 * k}" cy="{bar_h / 2}" r="7" fill="{t["dots"]}"/>')
    s.append(f'<text class="sans wtitle mu" x="{W / 2}" y="{bar_h / 2 + 8}" text-anchor="middle">{esc(title)}</text>')
    for i, line in enumerate(lines):
        inner = markup(i, line) if markup else esc(line)
        if markup is None and line.startswith("$ "):
            inner = f'<tspan class="mu">$</tspan>{esc(line[1:])}'
        s.append(f'<text class="mono term tx" xml:space="preserve" x="48" y="{first + lh * i}">{inner}</text>')
    s.append("</svg>")
    return "\n".join(s) + "\n"


# ------------------------------------------------------------------ writer
def write_all(builders):
    """builders: {"hero": fn(t) -> svg string, ...}. Writes <name>-{dark,light}.svg."""
    for name, fn in builders.items():
        for mode, t in THEMES.items():
            path = os.path.join(OUT, f"{name}-{mode}.svg")
            with open(path, "w", encoding="utf-8") as f:
                f.write(fn(t))
            print("wrote", os.path.relpath(path))


# ============================================================================
# unified-memory figures
# ============================================================================
def curve_in(x1, y1, x2, y2, stem=22):
    """Mirror of curve(): S-curve first, then a horizontal stem into (x2, y2)."""
    e = x2 - stem
    c = (x1 + e) / 2
    return f"M{x1} {y1} C{c} {y1} {c} {y2} {e} {y2} H{x2}"


HERO_TITLE = ("unified-memory: Claude exports, CLAUDE.md files and Claude Code sessions are indexed "
              "into one local SQLite store with FTS5 search, served over a Memory MCP server to "
              "Claude and Codex, which review each other. Agents may only propose memories.")


def hero(t):
    W, H = HERO_W, HERO_H
    s = svg_open(W, H, HERO_TITLE)
    s.append(base_style(t))
    s.append(card(W, H, t))
    s += hero_left("CLAUDE CODE & CODEX", "unified-memory",
                   ["Local-first memory over MCP.", "Claude and Codex, side by side.",
                    "One writer per workspace."])
    cy = 210
    sx = 668                         # source dot centre
    src_ys = [cy - 78, cy, cy + 78]
    src_end = 816
    dx, dw, dh = 858, 170, 100
    ax, aw, ah = 1096, 132, 48
    ag_ys = [cy - 70, cy + 70]
    paths = [curve_in(src_end, y, dx, cy, stem=12) for y in src_ys]
    paths += [curve(dx + dw, cy, ax, y, stem=16) for y in ag_ys]
    s += connectors(t, paths)
    # review link between the two agents
    rx = 1130
    s.append(f'<line x1="{rx}" y1="{ag_ys[0] + ah / 2}" x2="{rx}" y2="{ag_ys[1] - ah / 2}" '
             f'stroke="{t["sage"]}" stroke-width="2" stroke-dasharray="3 6" stroke-linecap="round"/>')
    for y, lab in zip(src_ys, ["export", "CLAUDE.md", "sessions"]):
        s.append(f'<circle cx="{sx}" cy="{y}" r="5" fill="{t["sage"]}"/>')
        s.append(f'<text class="mono cap mu" x="{sx + 14}" y="{y + 7}">{lab}</text>')
    s += node(t, dx, cy - dh / 2, dw, dh, "SQLite", "FTS5 + MCP", dot="clay")
    s.append(f'<text class="mono cap clay" x="{dx + 2}" y="{cy + dh / 2 + 38}">propose-only</text>')
    for y, lab in zip(ag_ys, ["Claude", "Codex"]):
        s += node(t, ax, y - ah / 2, aw, ah, lab, dot="sage", rx=12)
    s.append(f'<text class="mono cap sage" x="{rx + 14}" y="{cy + 7}">review</text>')
    s.append("</svg>")
    return "\n".join(s) + "\n"


# --------------------------------------------------------------- council
COUNCIL_DESC = ("Council flow for one question. The orchestrator retrieves scoped memory, then Claude "
                "and Codex each write an independent analysis in parallel. Each then reviews the "
                "other's result. A synthesizer reconciles all four into a final answer and a list of "
                "proposed memories, which you confirm. Every phase is stored as a message in SQLite "
                "(task_packet, agent_result, peer_review, synthesis), so runs are audited and resumable.")


def council(t):
    W, H = 1280, 440
    s = svg_open(W, H, "Council flow: retrieve, independent analysis, cross-review, synthesis", COUNCIL_DESC)
    s.append(base_style(t, ".hdr { font-size: 20px; }\n.file { font-size: 20px; }\n.lane { font-size: 20px; }\n"
                           ".chip { font-size: 22px; }\n"))
    s.append(card(W, H, t))
    yA, yB, cy = 112, 252, 182          # Claude lane, Codex lane, centre
    nh = 100
    rx_, rw = 40, 196                   # retrieve
    ax_, aw = 296, 150                  # independent analysis
    vx_, vw = 526, 206                  # cross-review
    sx_, sw = 792, 184                  # synthesis
    cx_, cw, ch = 1036, 204, 48         # outputs
    out_ys = [cy - 50, cy + 50]
    lane_y, lane_h = 334, 48
    # flow connectors
    paths = [curve(rx_ + rw, cy, ax_, y, stem=16) for y in (yA, yB)]
    paths += [curve(ax_ + aw, yA, vx_, yB, stem=14), curve(ax_ + aw, yB, vx_, yA, stem=14)]
    paths += [curve_in(vx_ + vw, y, sx_, cy, stem=14) for y in (yA, yB)]
    paths += [curve(sx_ + sw, cy, cx_, y, stem=14) for y in out_ys]
    s += connectors(t, paths)
    # writes-to-SQLite drops
    drops = [(rx_ + rw / 2, cy + nh / 2), (ax_ + aw / 2, yB + nh / 2), (vx_ + vw / 2, yB + nh / 2),
             (sx_ + sw / 2, cy + nh / 2)]
    s.append(f'<g fill="none" stroke="{t["conn"]}" stroke-width="2" stroke-dasharray="4 6" stroke-linecap="round">')
    s += [f'<path d="M{x} {y0} V{lane_y}"/>' for x, y0 in drops]
    s.append("</g>")
    s.append(f'<rect x="28" y="{lane_y}" width="{sx_ + sw + 20 - 28}" height="{lane_h}" rx="12" '
             f'fill="{t["panel"]}" stroke="{t["node"]}" stroke-width="1.5"/>')
    for (x, _), lab in zip(drops, ["task_packet", "agent_result", "peer_review", "synthesis"]):
        s.append(f'<text class="mono file mu" x="{x}" y="{lane_y + lane_h / 2 + 7}" text-anchor="middle">{lab}</text>')
    # headers
    for x, lab in ((rx_ + rw / 2, "retrieve"), (ax_ + aw / 2, "independent"),
                   (vx_ + vw / 2, "cross-review"), (sx_ + sw / 2, "synthesis")):
        s.append(f'<text class="mono hdr mu" x="{x}" y="40" text-anchor="middle">{lab}</text>')
    # nodes
    s += node(t, rx_, cy - nh / 2, rw, nh, "Memory", "scoped search", dot="clay")
    s += node(t, ax_, yA - nh / 2, aw, nh, "Claude", "analysis", dot="sage")
    s += node(t, ax_, yB - nh / 2, aw, nh, "Codex", "analysis", dot="sage")
    s += node(t, vx_, yA - nh / 2, vw, nh, "Claude", "reviews Codex", dot="sage")
    s += node(t, vx_, yB - nh / 2, vw, nh, "Codex", "reviews Claude", dot="sage")
    s += node(t, sx_, cy - nh / 2, sw, nh, "Synthesis", "of all four", dot="muted")
    for y, lab in zip(out_ys, ["final answer", "memory proposals"]):
        s.append(f'<rect x="{cx_}" y="{y - ch / 2}" width="{cw}" height="{ch}" rx="12" fill="{t["panel"]}" '
                 f'stroke="{t["clay"] if lab.startswith("memory") else t["node"]}" stroke-width="1.5"/>')
        s.append(f'<text class="sans chip tx" x="{cx_ + cw / 2}" y="{y + 8}" text-anchor="middle">{lab}</text>')
    s.append(f'<text class="mono hdr clay" x="{cx_ + cw / 2}" y="{out_ys[1] + ch / 2 + 32}" '
             f'text-anchor="middle">you confirm</text>')
    s.append(f'<text class="sans lane mu" x="32" y="{lane_y + lane_h + 38}">'
             f'<tspan class="mono tx">SQLite</tspan>  every step is recorded for audit; '
             f'<tspan class="mono">--resume</tspan> reuses completed phases</text>')
    s.append("</svg>")
    return "\n".join(s) + "\n"


BUILDERS = {"hero": hero, "council": council}

if __name__ == "__main__":
    sys.exit(write_all(BUILDERS))
