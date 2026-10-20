import pathlib
import sys

from playwright.sync_api import sync_playwright

scale = 2
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(device_scale_factor=scale)
    for src in sys.argv[1:]:
        src_path = pathlib.Path(src).resolve()
        out = src_path.parent.parent / (src_path.stem + ".png")
        page.goto(f"file://{src_path}")
        page.wait_for_load_state("networkidle")
        page.evaluate("document.fonts.ready")
        page.locator("svg").first.screenshot(path=str(out), omit_background=True)
        print("wrote", out)
    browser.close()
