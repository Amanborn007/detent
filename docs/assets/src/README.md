# Diagram sources

The README images are generated, not hand-edited. `generate.py` holds the geometry for both diagrams and writes a light and a dark HTML page for each. The two export scripts turn those pages into the committed `.svg` and `.png` files one folder up.

```sh
python3 docs/assets/src/generate.py docs/assets/src
python3 docs/assets/src/export_svg.py docs/assets/src/*.html
python3 docs/assets/src/export_png.py docs/assets/src/*.html   # needs Playwright: pip install playwright && playwright install chromium
```

Edit `generate.py`, run all three, and commit the HTML, SVG and PNG together so they stay in step.
