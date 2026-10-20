#!/usr/bin/env python3
"""Generate Detent README diagrams (light + dark) as diagram-design HTML files."""
import pathlib
import sys
from string import Template

OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

SANS = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

SKINS = {
    "light": dict(paper="#ffffff", node="#ffffff", ink="#14202b", muted="#4a5568", soft="#8a8a8a",
                  accent="#c8501a", tint="#f4ded0", link="#2e5aa8",
                  inkrgb="20,32,43", mutedrgb="74,85,104", accentrgb="200,80,26"),
    "dark": dict(paper="#2d3142", node="#393e53", ink="#f5f5f5", muted="#bfc0c0", soft="#8e98ac",
                 accent="#e06a35", tint="rgba(224,106,53,0.12)", link="#6a95d8",
                 inkrgb="245,245,245", mutedrgb="191,192,192", accentrgb="224,106,53"),
}

KIND = {
    "focal":    dict(fill="$tint", stroke="$accent", tag="$accent", dash=""),
    "backend":  dict(fill="$node", stroke="$ink", tag="$ink", dash=""),
    "store":    dict(fill="rgba($inkrgb,0.05)", stroke="$muted", tag="$muted", dash=""),
    "external": dict(fill="rgba($inkrgb,0.03)", stroke="rgba($inkrgb,0.30)", tag="$soft", dash=""),
    "input":    dict(fill="rgba($mutedrgb,0.10)", stroke="$soft", tag="$soft", dash=""),
    "optional": dict(fill="rgba($inkrgb,0.02)", stroke="rgba($inkrgb,0.35)", tag="$soft",
                     dash=' stroke-dasharray="4,3"'),
}


def tag_w(text):
    return max(20, ((len(text) * 5 + 10 + 3) // 4) * 4)


def node(x, y, w, h, kind, tag, name, sub):
    k = KIND[kind]
    cx = x + w // 2
    tw = tag_w(tag)
    out = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="$paper"/>',
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{k["fill"]}" '
        f'stroke="{k["stroke"]}" stroke-width="1"{k["dash"]}/>',
        f'<rect x="{x + 8}" y="{y + 6}" width="{tw}" height="12" rx="2" fill="none" '
        f'stroke="{k["tag"]}" stroke-opacity="0.45" stroke-width="0.8"/>',
        f'<text x="{x + 8 + tw // 2}" y="{y + 15}" fill="{k["tag"]}" font-size="7" font-family="{MONO}" '
        f'text-anchor="middle" letter-spacing="0.08em">{tag}</text>',
        f'<text x="{cx}" y="{y + 36}" fill="$ink" font-size="12" font-weight="600" font-family="{SANS}" '
        f'text-anchor="middle">{name}</text>',
    ]
    if sub:
        out.append(f'<text x="{cx}" y="{y + 52}" fill="$muted" font-size="9" font-family="{MONO}" '
                   f'text-anchor="middle">{sub}</text>')
    return out


def label(x, y, w, text, color="$soft"):
    return [
        f'<rect x="{x}" y="{y}" width="{w}" height="12" rx="2" fill="$paper"/>',
        f'<text x="{x + w // 2}" y="{y + 9}" fill="{color}" font-size="8" font-family="{MONO}" '
        f'text-anchor="middle" letter-spacing="0.08em">{text}</text>',
    ]


def zone(x, y, w, h, lx, lw, text):
    return [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="rgba($inkrgb,0.02)" '
        f'stroke="rgba($inkrgb,0.12)" stroke-width="0.8"/>',
        f'<rect x="{lx}" y="{y + 4}" width="{lw}" height="12" rx="2" fill="$paper"/>',
        f'<text x="{lx + lw // 2}" y="{y + 13}" fill="rgba($inkrgb,0.45)" font-size="7" font-family="{MONO}" '
        f'text-anchor="middle" letter-spacing="0.14em">{text}</text>',
    ]


def path(d, color, width, marker, dashed=False):
    dash = ' stroke-dasharray="4,3"' if dashed else ""
    return [f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}"{dash} '
            f'marker-end="url(#{marker})"/>']


def legend_item(x, y, kind, text):
    if kind in KIND:
        k = KIND[kind]
        swatch = (f'<rect x="{x}" y="{y}" width="16" height="12" rx="2" fill="{k["fill"]}" '
                  f'stroke="{k["stroke"]}" stroke-width="1"{k["dash"]}/>')
    elif kind == "gate":
        swatch = (f'<polygon points="{x + 8},{y - 1} {x + 15},{y + 6} {x + 8},{y + 13} {x + 1},{y + 6}" '
                  f'fill="$tint" stroke="$accent" stroke-width="1"/>')
    else:
        stroke, marker, extra = {
            "accent": ("$accent", "arrow-accent", ' stroke-width="1.4"'),
            "link": ("$link", "arrow-link", ' stroke-width="1.2"'),
            "dashed": ("$muted", "arrow", ' stroke-width="1" stroke-dasharray="4,3"'),
        }[kind]
        swatch = (f'<line x1="{x}" y1="{y + 6}" x2="{x + 24}" y2="{y + 6}" stroke="{stroke}"{extra} '
                  f'marker-end="url(#{marker})"/>')
    return [swatch, f'<text x="{x + 32}" y="{y + 10}" fill="$muted" font-size="9" font-family="{SANS}">{text}</text>']


def legend(y_line, items, step):
    out = [
        f'<line x1="32" y1="{y_line}" x2="960" y2="{y_line}" stroke="rgba($inkrgb,0.12)" stroke-width="0.8"/>',
        f'<text x="32" y="{y_line + 20}" fill="$muted" font-size="8" font-family="{MONO}" '
        f'letter-spacing="0.18em">LEGEND</text>',
    ]
    x = 32
    for k, t in items:
        out += legend_item(x, y_line + 32, k, t)
        x += ((32 + int(len(t) * 5.2) + 20 + 3) // 4) * 4
    return out


DEFS = [
    "<defs>",
    '<marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">'
    '<polygon points="0 0, 8 3, 0 6" fill="$muted"/></marker>',
    '<marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">'
    '<polygon points="0 0, 8 3, 0 6" fill="$accent"/></marker>',
    '<marker id="arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">'
    '<polygon points="0 0, 8 3, 0 6" fill="$link"/></marker>',
    "</defs>",
]


def architecture():
    W, H, TOP = 992, 432, 40
    s = [f'<rect width="{W}" height="{H}" fill="$paper"/>']
    s += zone(16, 56, 752, 296, 28, 88, "YOUR MACHINE")
    s += zone(784, 56, 192, 296, 844, 72, "EXTERNAL")
    s += path("M 160,128 H 208", "$muted", "1.2", "arrow")
    s += path("M 352,128 H 400", "$muted", "1.2", "arrow")
    s += path("M 560,128 H 608", "$muted", "1.2", "arrow")
    s += path("M 752,128 H 800", "$link", "1.2", "arrow-link")
    s += path("M 752,144 H 768 Q 776,144 776,152 V 256 Q 776,264 784,264 H 800", "$link", "1.2", "arrow-link")
    s += path("M 480,160 V 256", "$muted", "1.2", "arrow")
    s += path("M 400,144 H 388 Q 380,144 380,152 V 264 Q 380,272 372,272 H 160", "$muted", "1.2", "arrow")
    s += path("M 96,160 V 256", "$accent", "1.4", "arrow-accent")
    s += path("M 160,304 H 400", "$muted", "1.2", "arrow")
    s += path("M 752,296 H 800", "$link", "1.2", "arrow-link")
    s += path("M 640,256 V 216 Q 640,208 632,208 H 488 A 8 8 0 0 0 472,208 H 388 "
              "A 8 8 0 0 0 372,208 H 312 Q 304,208 304,200 V 160", "$muted", "1", "arrow", dashed=True)
    s += label(172, 108, 24, "ASK")
    s += label(360, 108, 32, "RUNS")
    s += label(564, 108, 40, "CALLS")
    s += label(488, 176, 44, "WRITES")
    s += label(236, 252, 60, "GATE PAGE")
    s += label(104, 200, 52, "APPROVE", "$accent")
    s += label(252, 284, 48, "ANSWER")
    s += label(756, 276, 40, "READS", "$link")
    s += label(556, 188, 40, "INBOX")
    s += node(32, 96, 128, 64, "input", "YOU", "You", "terminal · browser")
    s += node(208, 96, 144, 64, "backend", "CC", "Claude Code session", "skills · hooks")
    s += node(400, 96, 160, 64, "focal", "CORE", "Detent engine", "stages · gates")
    s += node(608, 96, 144, 64, "backend", "CFG", "Providers", "pack · stack.yaml")
    s += node(800, 96, 160, 64, "external", "MCP", "Tracker &amp; chat", "Jira · Slack · Gmail")
    s += node(32, 256, 128, 64, "backend", "UI", "Curator page", "127.0.0.1 only")
    s += node(400, 256, 160, 64, "store", "FILES", "Run state", ".sdlc/&lt;run-id&gt;/")
    s += node(608, 256, 144, 64, "optional", "BOT", "Sentinel", "PR comment watcher")
    s += node(800, 256, 160, 64, "external", "GH", "GitHub", "PRs · review bots")
    s += legend(372, [("focal", "Engine"), ("backend", "Component"), ("store", "Plain files"),
                      ("external", "External service"), ("optional", "Background watcher"),
                      ("accent", "Your approval"), ("link", "Network call"), ("dashed", "Async inbox")], 120)
    return W, H, TOP, s


def pipeline():
    W, H, TOP = 992, 296, 64
    s = [f'<rect width="{W}" height="{H}" fill="$paper"/>']
    stages = [("01", "Intake", "brief.md"), ("02", "Research", "research.md"), ("03", "Plan", "plan.md"),
              ("04", "Implement", "commits"), ("05", "Recheck", "recheck.md"), ("06", "Ship", "draft PR"),
              ("07", "Respond", "fix · reply")]
    xs = [32, 152, 272, 448, 568, 688, 864]
    for a, b in [(128, 152), (248, 272), (368, 392), (424, 448), (544, 568), (664, 688), (784, 808), (840, 864)]:
        s += path(f"M {a},120 H {b}", "$muted", "1.2", "arrow")
    s += path("M 888,152 V 196 Q 888,204 896,204 H 928 Q 936,204 936,196 V 152", "$muted", "1", "arrow", dashed=True)
    s += label(872, 212, 80, "SENTINEL SCAN")
    for cx, eyebrow, sub in [(408, "PLAN GATE", "you approve"), (824, "SHIP GATE", "push · draft PR")]:
        pts = f"{cx},104 {cx + 16},120 {cx},136 {cx - 16},120"
        s += [
            f'<polygon points="{pts}" fill="$paper"/>',
            f'<polygon points="{pts}" fill="$tint" stroke="$accent" stroke-width="1.2"/>',
            f'<text x="{cx}" y="124" fill="$accent" font-size="8" font-weight="600" font-family="{MONO}" '
            f'text-anchor="middle">YOU</text>',
            f'<text x="{cx}" y="176" fill="$accent" font-size="8" font-family="{MONO}" text-anchor="middle" '
            f'letter-spacing="0.12em">{eyebrow}</text>',
            f'<text x="{cx}" y="192" fill="$muted" font-size="9" font-family="{MONO}" '
            f'text-anchor="middle">{sub}</text>',
        ]
    for (num, name, sub), x in zip(stages, xs):
        s += node(x, 88, 96, 64, "backend", num, name, sub)
    s += legend(236, [("backend", "Stage · artifact it writes"), ("gate", "Stops for your approval"),
                      ("dashed", "Repeats on each push until clean")], 200)
    return W, H, TOP, s


FONTS = ("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1"
         "&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap")

CSS = " ".join([
    "*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }",
    "body { font-family: 'Geist', system-ui, sans-serif; background: $paper; color: $ink;",
    "min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 3rem 2rem; }",
    ".frame { max-width: 1040px; width: 100%; }",
    ".eyebrow { font-family: 'Geist Mono', ui-monospace, monospace; font-size: 0.66rem; font-weight: 500;",
    "letter-spacing: 0.18em; text-transform: uppercase; color: $muted; margin-bottom: 0.5rem; }",
    "h1 { font-family: 'Instrument Serif', serif; font-size: 2rem; font-weight: 400; letter-spacing: -0.02em;",
    "line-height: 1.15; color: $ink; margin-bottom: 1.5rem; }",
    "svg { width: 100%; min-width: 900px; display: block; }",
])


def page(slug, eyebrow, title, desc, W, H, TOP, body):
    lines = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        f"<title>{title}</title>",
        f'<link href="{FONTS}" rel="stylesheet">',
        f"<style>{CSS}</style>",
        "</head>",
        "<body>",
        '<div class="frame">',
        f'<p class="eyebrow">{eyebrow}</p>',
        f"<h1>{title}</h1>",
        f'<svg viewBox="0 {TOP} {W} {H - TOP}" xmlns="http://www.w3.org/2000/svg" role="img" '
        f'aria-labelledby="{slug}-title {slug}-desc">',
        f'<title id="{slug}-title">{title}</title>',
        f'<desc id="{slug}-desc">{desc}</desc>',
        *DEFS,
        *body,
        "</svg>",
        "</div>",
        "</body>",
        "</html>",
        "",
    ]
    return "\n".join(lines)


DIAGRAMS = {
    "detent-architecture": (architecture, "Architecture · Detent", "How Detent fits together",
                            "Architecture diagram showing a Claude Code session whose skills and hooks drive the "
                            "Detent engine, which keeps run state in plain files, renders gates to a local curator "
                            "page for your approval, and reaches your tracker and GitHub through configured "
                            "providers, while sentinel reads PR bot comments into the session's inbox."),
    "detent-pipeline": (pipeline, "Stage pipeline · Detent", "From ticket to draft PR",
                        "Pipeline diagram showing the seven Detent stages from intake to respond, each with the "
                        "artifact it writes, with your approval required at the plan gate and at the ship gate "
                        "before the push, and a sentinel scan loop that repeats respond on each push."),
}

for slug, (fn, eyebrow, title, desc) in DIAGRAMS.items():
    W, H, TOP, body = fn()
    for skin, tokens in SKINS.items():
        sslug = slug if skin == "light" else f"{slug}-dark"
        html = Template(page(sslug, eyebrow, title, desc, W, H, TOP, body)).substitute(tokens)
        (OUT / f"{sslug}.html").write_text(html)
        print("wrote", OUT / f"{sslug}.html")
