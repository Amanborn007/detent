import pathlib
import re
import sys

FONT_IMPORT = ("<style>@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1"
               "&amp;family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500;600&amp;display=swap');"
               "</style>")

for src in sys.argv[1:]:
    src_path = pathlib.Path(src).resolve()
    html = src_path.read_text()
    match = re.search(r"<svg\b.*?</svg>", html, re.S)
    if not match:
        raise SystemExit(f"no <svg> block in {src_path}")
    svg = match.group(0)
    if "<defs>" not in svg:
        raise SystemExit(f"no <defs> block in {src_path}")
    svg = svg.replace("<defs>", "<defs>\n" + FONT_IMPORT, 1)
    out = src_path.parent.parent / (src_path.stem + ".svg")
    out.write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + svg + "\n")
    print("wrote", out)
