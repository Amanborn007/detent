// Regression net for engine/curator/scripts/artifact-check.py.
//
// The check is the thing that stops a non-compliant artifact being opened, and every fault in it so
// far was found by running it over real files rather than by reading it. Each case below is one of
// those faults, pinned to a committed fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(here, "..", "scripts", "artifact-check.py");
const FIXTURES = path.join(here, "fixtures");

function run(...names) {
  const result = spawnSync("python3", [CHECK, ...names.map((n) => path.join(FIXTURES, n))], {
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `could not run python3: ${result.error?.message}`);
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// Only the lines that fail; the dark-mode note is a warning and does not gate anything.
const failures = (out) =>
  out.split("\n").filter((line) => line.trim() && !line.startsWith("warning:") && !line.startsWith("OK,"));

test("a compliant artifact passes", () => {
  const { code, out } = run("passes-clean.html");
  assert.equal(code, 0, out);
});

test("the former false positives stay silent", () => {
  // A class name containing a badge word, a numbering column, one share in prose, two percentage
  // cells, two tables with prose between them, a hatch option, a decorative chevron, rel=canonical.
  const { code, out } = run("fp-cases.html");
  assert.equal(code, 0, out);
});

test("remote fetches in attributes fail, protocol-relative included", () => {
  const { code, out } = run("remote-fetch.html");
  assert.equal(code, 1);
  assert.equal(failures(out).length, 3, out);
  assert.match(out, /<script>/);
  assert.match(out, /<img>/);
});

test("remote fetches from CSS fail", () => {
  const { code, out } = run("remote-css.html");
  assert.equal(code, 1);
  assert.equal(failures(out).length, 2, out);
  assert.match(out, /from CSS/);
});

test("a rel is exempt only when every one of its tokens is non-fetching", () => {
  const { code, out } = run("rel-tokens.html");
  assert.equal(code, 1);
  // alternate+stylesheet, preconnect, dns-prefetch fail. canonical and author+license do not.
  // Three is under the per-check cap, so their absence is real and not truncation.
  const lines = failures(out);
  assert.equal(lines.length, 3, out);
  for (const inert of [18, 19]) {
    assert.ok(!out.includes(`rel-tokens.html:${inert} `), `line ${inert} should be exempt:\n${out}`);
  }
});

test("hardcoded paint inside an SVG fails", () => {
  const { code, out } = run("hardcoded-paint.html");
  assert.equal(code, 1);
  assert.match(out, /paints an SVG/);
  // Hex, rgba(), oklch() and a named colour all count, so it is an allow-list and not a block list.
  assert.match(out, /5 more like it/);
});

test("a section owing a drawing fails, and the skeleton's placeholder does not count as one", () => {
  const { code, out } = run("diagram-owed.html");
  assert.equal(code, 1);
  // Both flow sections are reported even though the page contains an SVG, because that SVG carries
  // data-placeholder and because a drawing cannot cover a section it does not sit in.
  assert.equal(failures(out).length, 2, out);
  assert.match(out, /Mechanism — the write path/);
  assert.match(out, /Architecture — the read path/);
});

test("status classes and an embedded Mermaid render fail", () => {
  const { code, out } = run("badges-and-mermaid.html");
  assert.equal(code, 1);
  // ok, no and pill are badges. no-print and col-no are not, so the count is 3 and not 5.
  assert.match(out, /uses the status class "ok", and 2 more like it/);
  assert.match(out, /embeds Mermaid/);
});

test("a drawing under a subsection satisfies its parent section's obligation", () => {
  // Sections end at the next heading of the same or shallower level, so an h2 that owes a drawing
  // is satisfied by one beneath its own h3. Stopping at the next heading of any level failed this.
  const { code, out } = run("nested-section-diagram.html");
  assert.equal(code, 0, out);
});

test("percentages wrapped in markup still count as figures, and only once", () => {
  const { code, out } = run("percent-in-markup.html");
  assert.equal(code, 1);
  assert.match(out, /the figures under "Region share"/);
  // Attributed to the innermost section holding the cells: now that a section contains its
  // subsections, counting per span reported the same missing chart once per level above it.
  assert.equal(failures(out).length, 1, out);
});

test("a remote srcset candidate and currentColor over a literal both fail", () => {
  const { code, out } = run("srcset-and-currentcolor.html");
  assert.equal(code, 1);
  // Only the second srcset candidate is remote, so checking the attribute's start missed it.
  assert.match(out, /fetches <img>/);
  // currentColor is only as tokenised as the color it inherits.
  assert.match(out, /paints an SVG with "#ffffff"/);
});

test("one drawing cannot discharge both a parent and a child obligation", () => {
  const { code, out } = run("one-drawing-two-obligations.html");
  assert.equal(code, 1);
  // The drawing sits in the h3, so it settles the ranking and leaves the h2's flow owed.
  assert.equal(failures(out).length, 1, out);
  assert.match(out, /Architecture — the request path/);
  assert.doesNotMatch(out, /the ranking in/);
});

test("paint from a page-level rule fails, and a url written about in prose does not", () => {
  const { code, out } = run("css-paint-and-prose-url.html");
  assert.equal(code, 1);
  // `svg .node { fill:#fff }` never appears inside the <svg> element and paints it anyway.
  assert.match(out, /paints an SVG with "#ffffff", and 1 more like it/);
  // url(https://…) inside <pre><code> and in prose fetches nothing, so it must not be reported.
  assert.doesNotMatch(out, /from CSS/);
});

test("a video poster is a fetch, and the guide marker alone exempts nothing", () => {
  const { code, out } = run("poster-and-fake-guide.html");
  assert.equal(code, 1);
  assert.match(out, /fetches <video>/);
  // The marker is editable document content, so the exemption also needs the guide's own filename.
  assert.match(out, /uses the status class "ok"/);
  assert.match(out, /prefers-color-scheme/);
});

test("the real guide artifact keeps its exemption", () => {
  // The other half of the rule above: scoping the marker to a filename must not take the exemption
  // away from the file it exists for.
  const { code, out } = run("detent-guide-v9.html");
  assert.equal(code, 0, out);
});

test("options under their own heading owe a comparison drawing", () => {
  // The section's own heading counts, not only its ancestors': comparing on body_start excluded the
  // span itself, so three options under "Approaches" stopped owing a quadrant.
  const { code, out } = run("options-need-a-quadrant.html");
  assert.equal(code, 1);
  assert.match(out, /the comparison of 3 options/);
});

test("a remote base fails, and a diagram rule that never names svg fails", () => {
  const { code, out } = run("base-and-class-paint.html");
  assert.equal(code, 1);
  // <base> fetches nothing itself; it makes every relative URL on the page remote.
  assert.match(out, /sets a remote <base>/);
  // `.node { fill:#fff }` paints the diagram without the word svg anywhere in the selector.
  assert.match(out, /paints an SVG with "#ffffff", and 1 more like it/);
  // And a rule for prose, whose class no SVG uses, is not diagram paint.
  assert.doesNotMatch(out, /#333333/);
});

test("image-set fetches, and a stylesheet color behind currentColor is paint", () => {
  const { code, out } = run("image-set-and-css-currentcolor.html");
  assert.equal(code, 1);
  // image-set() takes a bare quoted URL, so there is no url() for the old pattern to find.
  assert.match(out, /image-set candidate/);
  // fill="currentColor" is allow-listed; the literal it inherits is the real paint.
  assert.match(out, /paints an SVG with "#ffffff"/);
});

test("a selector that merely looks like a diagram hook is not diagram paint", () => {
  // .node-description, .node-caption and .svg-preview all contain a hook as a substring and none of
  // them touches the SVG. This check blocks curator open, so a false positive refuses a valid page.
  const { code, out } = run("hook-lookalike-selectors.html");
  assert.equal(code, 0, out);
});

test("rel inerts only a link, and a meta refresh and a later image-set candidate both fetch", () => {
  const { code, out } = run("rel-on-img-meta-imageset.html");
  assert.equal(code, 1);
  // rel is decoration on an img, so rel="canonical" there exempted a real fetch.
  assert.match(out, /fetches <img>/);
  // A refresh redirect is not a resource fetch, so it passed every attribute check.
  assert.match(out, /meta refresh/);
  // The remote candidate is second in the list, as with srcset.
  assert.match(out, /image-set candidate/);
  // Exactly three: an all-local image-set and a genuine <link rel="canonical"> stay silent.
  assert.equal(failures(out).length, 3, out);
});

test("a remote paint url fails, and so does an element rule with no class", () => {
  const { code, out } = run("paint-url-and-element-rules.html");
  assert.equal(code, 1);
  // No attribute check reads fill or stroke, so allow-listing every url() let a fetch through both
  // gates. Only a local fragment is inert.
  assert.match(out, /url\(https:\/\/cdn\.example\.com\/x\.svg#gradient\)/);
  // `rect { fill:#fff }` names neither svg nor a class and paints every rect in the diagram.
  assert.match(out, /and 1 more like it/);
  // And `.text-muted`, a prose class that merely starts with an element name, is not diagram paint.
  assert.doesNotMatch(out, /#333333/);
});

test("a commented or scripted example is not a fetch", () => {
  // An artifact documenting the rule has to be able to show what the rule forbids. The browser
  // parses neither an HTML comment nor script text as markup, and refusing these blocks a valid
  // artifact now that the check gates curator open.
  const { code, out } = run("commented-example.html");
  assert.equal(code, 0, out);
});

test("a script with a remote src is still a fetch", () => {
  // The other half: only a script's CONTENTS are inert, never its opening tag.
  const { code, out } = run("remote-fetch.html");
  assert.equal(code, 1);
  assert.match(out, /fetches <script>/);
});

test("a commented SVG neither fails the page nor discharges an obligation", () => {
  const { code, out } = run("commented-svg-example.html");
  assert.equal(code, 1);
  // The section still owes a drawing: a commented example is not one.
  assert.match(out, /Mechanism — the write path/);
  // And the literal and the badge class inside that comment are not reported.
  assert.equal(failures(out).length, 1, out);
});

test("a color rule is paint only for the diagram that reads currentColor", () => {
  // Two diagrams, one reading currentColor. A document-wide flag made the other diagram's colour
  // rule count as inherited paint and refused a valid artifact. The second SVG's <title> also
  // contains the word currentColor, so this pins that prose is not a paint position either.
  const { code, out } = run("two-diagrams-one-currentcolor.html");
  assert.equal(code, 0, out);
});

test("an unquoted srcset fetches, and an SVG in no declared state fails", () => {
  const { code, out } = run("unquoted-srcset-and-bare-svg.html");
  assert.equal(code, 1);
  // HTML allows a single unquoted candidate; only the quoted form was parsed.
  assert.match(out, /fetches <img>/);
  // Carrying neither attribute was treated as decoration, but decoration says so with aria-hidden.
  assert.match(out, /missing both a <title> and role="img"/);
});

test("a Mermaid fence inside a code block is an example, not a render", () => {
  const { code, out } = run("mermaid-in-a-code-block.html");
  assert.equal(code, 0, out);
});

test("a real Mermaid render is still caught", () => {
  // The other half: markup that activates Mermaid counts wherever it sits.
  const { code, out } = run("badges-and-mermaid.html");
  assert.equal(code, 1);
  assert.match(out, /embeds Mermaid/);
});

test("data-* attributes and commented CSS are not fetches, and data-class is not a badge", () => {
  // \b matched the tail of data-src, data-href and data-poster, and `class=` matched inside
  // data-class. None of them fetches or styles anything, and reporting them refuses a valid page.
  const { code, out } = run("inert-attributes-and-comments.html");
  assert.equal(code, 0, out);
});

test("SVG metadata is not paint, a quoted fragment is local, and data-* is not Mermaid", () => {
  // data-fill, data-class and data-id all sat inside patterns bounded only by \b, and
  // fill="url('#grad')" captured just `url(` and was rejected though it is valid offline SVG.
  const { code, out } = run("inert-svg-attributes.html");
  assert.equal(code, 0, out);
});

test("an unquoted style attribute fetches, and data-style does not", () => {
  const { code, out } = run("unquoted-style-fetch.html");
  assert.equal(code, 1);
  assert.match(out, /from CSS/);
  assert.equal(failures(out).length, 1, out);
});

test("HTML-shaped text inside CSS is not markup", () => {
  // An SVG in a CSS comment and class="ok" in a content string: the markup checks no longer read
  // the stylesheet, so neither is an inaccessible diagram nor a status pill.
  const { code, out } = run("html-shaped-css.html");
  assert.equal(code, 0, out);
});

test("the dark-mode warning still reads the stylesheet", () => {
  // The other half of that split: no-h1 reads markup, prefers-color-scheme is CSS. Blanking the
  // stylesheet for every check would have warned on every artifact.
  const clean = run("passes-clean.html");
  assert.doesNotMatch(clean.out, /prefers-color-scheme/, clean.out);
  const missing = run("no-dark-mode.html");
  assert.match(missing.out, /prefers-color-scheme/);
  assert.equal(missing.code, 0, "a missing dark-mode block warns and does not gate");
});

test("a var pointing at a fixed literal is paint, and encoded urls and feImage fetch", () => {
  const { code, out } = run("var-encoded-feimage.html");
  assert.equal(code, 1);
  // A custom property the dark-mode block never redefines holds one literal in both themes, which
  // is exactly what the token rule exists to stop.
  assert.match(out, /var\(--node-fill\) \(#ffffff\)/);
  // The browser decodes character references before fetching, so no literal https:// appears.
  assert.match(out, /fetches <img>/);
  // feImage loads an external image for a filter.
  assert.match(out, /fetches <feimage>/);
});

test("the theme's own tokens are not read as fixed literals", () => {
  // The other half of that rule: tokens ARE defined as literals, and what makes them tokens is that
  // the dark-mode block redefines them. theme.html would fail if that were not distinguished.
  const result = spawnSync("python3", [CHECK, path.join(here, "..", "theme.html")],
    { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a decorative or placeholder child does not exempt the whole drawing", () => {
  const { code, out } = run("decorative-child-marker.html");
  assert.equal(code, 1);
  // The markers describe the drawing, so searching the whole block let one child hide a visible
  // diagram from the budget and from the accessibility check.
  assert.match(out, /Mechanism — the write path/);
  assert.match(out, /missing both a <title> and role="img"/);
});

test("encoded URLs in CSS, base and meta refresh are all fetches", () => {
  // The browser decodes character references before fetching, so none of these contains a literal
  // https:// — the same gap that was fixed for resource attributes, in the three other scans.
  const { code, out } = run("encoded-css-base-refresh.html");
  assert.equal(code, 1);
  assert.match(out, /remote <base>/);
  assert.match(out, /meta refresh/);
  assert.match(out, /through an encoded URL/);
});

test("an unquoted class is still a badge, and a var fallback is still a literal", () => {
  const { code, out } = run("unquoted-class-and-fallback.html");
  assert.equal(code, 1);
  // HTML permits class=ok, which renders and styles the same and bypassed the ban.
  assert.match(out, /uses the status class "ok", and 1 more like it/);
  // An undeclared property renders its fallback, so this is the hardcoded colour.
  assert.match(out, /var\(--missing, #ffffff\) \(#ffffff\)/);
  // An image-set whose every candidate is local is not a fetch, even on a page with entities.
  assert.doesNotMatch(out, /encoded URL/);
});

test("universal and attribute selectors paint the diagram, and an unquoted rel is still inert", () => {
  const { code, out } = run("selector-forms-and-unquoted.html");
  assert.equal(code, 1);
  // *[role="img"] and `.diagram > *` reach an SVG without naming it or any of its hooks.
  assert.match(out, /paints an SVG with "#ffffff", and 1 more like it/);
  // <link rel=canonical href=…> fetches nothing, and only the quoted form was exempt.
  assert.doesNotMatch(out, /fetches <link>/);
});

test("a rule that reaches no diagram, and quoted examples of the bans, all pass", () => {
  // `.unused-icon { fill:#fff }` paints nothing on this page. Treating every fill declaration as
  // diagram paint caught it, and a mandatory gate that refuses valid work gets switched off.
  // Prose and <code> showing class="ok", class="mermaid" and id="mermaid-1" activate nothing.
  const { code, out } = run("quoted-examples-and-unused-rule.html");
  assert.equal(code, 0, out);
});

test("a before-and-after heading with no drawing warns and does not gate", () => {
  // blocks.md marks the Delta map's drawing recommended, with an explicit exception for a delta
  // that is a single named piece. Gating it enforced a rule the library does not state.
  const { code, out } = run("delta-heading-warns.html");
  assert.equal(code, 0, out);
  assert.match(out, /warning: .*the before-and-after in "Current state"/);
});

test("the required obligations still gate", () => {
  // The other half: flow, figures and comparison are required, so they fail rather than warn.
  for (const fixture of ["diagram-owed.html", "percent-in-markup.html",
                         "options-need-a-quadrant.html"]) {
    const { code, out } = run(fixture);
    assert.equal(code, 1, `${fixture}:\n${out}`);
  }
});

test("a CSS escape and entity-encoded class values are resolved before matching", () => {
  const { code, out } = run("escaped-css-and-entities.html");
  assert.equal(code, 1);
  // url(https\3a //cdn/x.png) has no "://" until the CSS escape is applied.
  assert.match(out, /encoded URL/);
  // class="&#111;k" reaches the browser as class "ok", and "&#109;ermaid" as "mermaid".
  assert.match(out, /uses the status class "ok"/);
  assert.match(out, /embeds Mermaid/);
});

test("an unreadable file is reported rather than passed over", () => {
  const { code, out } = run("no-such-fixture.html");
  assert.equal(code, 1);
  assert.match(out, /cannot be read/);
});
