#!/usr/bin/env python3
"""Check a curator artifact before it is opened.

Usage: artifact-check.py <file.html> [...]

Exits 0 when every file passes and 1 when any fails. Each problem prints one line naming the file,
the line it starts on, and what to change.

Scope: the artifact you are about to open. Run over the whole back catalogue and most files fail,
because the rules postdate them.
"""

import html
import os
import re
import sys

# The detent guide artifact carries its own dark panel theme and pill vocabulary, settled in
# docs/guide-artifact-template.md. Regenerating it must emit this marker or it fails on both.
GUIDE_MARKER = "<!-- artifact-check: guide -->"
GUIDE_EXEMPT = frozenset({"badge-class", "dark-mode"})
# The guide artifact's own name, per docs/guide-artifact-template.md. The exemption needs this too,
# so the marker cannot be pasted into any artifact to switch the two checks off.
GUIDE_FILE = re.compile(r"detent-guide-v\d+\.html$", re.I)

FAIL, WARN = "fail", "warn"
MAX_LINES_PER_CHECK = 5

TAG = re.compile(r"<[^>]+>")
WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*")
HEADING = re.compile(r"<h([1-6])\b[^>]*>(.*?)</h\1\s*>", re.I | re.S)
STACKED = re.compile(r"</table\s*>(.*?)<table\b", re.I | re.S)
SVG_BLOCK = re.compile(r"<svg\b.*?</svg\s*>", re.I | re.S)
# (?<![\w-]) so data-class="badge" is not read as a class: it names nothing the browser styles, and
# reporting it refuses a valid artifact.
# Quoted or not: HTML permits class=badge, which rendered normally and bypassed both the badge and
# the Mermaid ban.
CLASS_ATTR = re.compile(r"(?<![\w-])class\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\"'>\s]+))", re.I)
QUESTION = re.compile(r"data-plan-question", re.I)

# Exact class tokens only. Matching a hyphen segment flagged "no-print" and a "col-no" numbering
# column as status badges.
BADGE_TOKENS = frozenset({"ok", "no", "pill", "badge", "chip", "severity"})

# rel values that fetch nothing, so an external href on them breaks no offline rule. preconnect and
# dns-prefetch are NOT here: they open a connection and resolve a name, which is network the artifact
# is not allowed to need. The exemption needs EVERY token in the rel to be listed here, because
# rel="alternate stylesheet" really does fetch the stylesheet.
INERT_REL = frozenset({"canonical", "alternate", "author", "license"})

# Everything that is NOT a hardcoded colour. Allow-listing is the only way that holds: a block list
# of names missed lime, rebeccapurple, hsla(), hwb(), lab() and oklch().
PAINT_KEYWORDS = frozenset({"none", "transparent", "inherit", "initial", "unset", "revert",
                            "currentcolor", "context-fill", "context-stroke", "freeze"})
# (?<![\w-]) so data-fill="#fff" is metadata, not paint. The url(...) branch comes first because a
# quoted paint server — fill="url('#gradient')" — otherwise captured just `url(` and was rejected,
# though it is valid offline SVG.
PAINT = re.compile(r"(?<![\w-])(fill|stroke|stop-color|flood-color|lighting-color)\s*[=:]\s*"
                   r"[\"']?\s*((?:url|var)\([^)]*\)|[^\"';>\s]+)", re.I)
# `color:` on its own, never the -color suffixes above nor background-color.
COLOR_DECL = re.compile(r"(?<![-\w])color\s*:\s*([^;\"'}>]+)", re.I)

FETCHING_TAG = re.compile(r"<(link|script|img|iframe|video|audio|source|embed|object|image|use|"
                          r"track|input|feImage)\b[^>]*>", re.I)
# (?:https?:)? because a protocol-relative //cdn.example.com is still a network fetch.
REMOTE = r"(?:https?:)?//"
# url() and @import are not the only CSS that fetches: image-set() takes a bare quoted URL, so
# `background-image: image-set("https://cdn/a.png" 1x)` reached the network with no url() in sight.
CSS_FETCH = re.compile(r"(?:url\(\s*[\"']?|@import\s+[\"']?)" + REMOTE, re.I)
# image-set holds a candidate list like srcset, so the remote one can be second and still fetch on a
# high-density display. The whole call is captured and every candidate read.
IMAGE_SET = re.compile(r"(?:-webkit-)?image-set\(([^)]*)\)", re.I)
# CSS only lives in a <style> block or a style attribute. Scanning the whole document rejected an
# artifact that merely WROTE about url(https://…) in prose or inside <code>, which fetches nothing.
STYLE_BLOCK = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.I | re.S)
# Bounded, so data-style is metadata rather than active CSS, and the unquoted form is parsed too:
# <div style=background:url(https://…)> is valid HTML and was fetching while it passed.
STYLE_ATTR = re.compile(r"(?<![\w-])style\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\"'>\s]+))", re.I)
# selector { declarations }, so a rule painting svg from the page stylesheet can be found.
CSS_RULE = re.compile(r"([^{}@]+)\{([^{}]*)\}", re.S)
CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
CUSTOM_PROP = re.compile(r"(--[\w-]+)\s*:\s*([^;}\"']+)")
# SVG elements a page rule can paint by type alone, with no class and no svg in the selector.
SVG_ELEMENTS = ("rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "tspan",
                "marker", "stop")
# Regions the browser never parses as markup. A commented example such as
# <!-- <img src="https://…"> --> is not a fetch, and refusing it blocks a valid artifact.
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
# Only the CONTENTS of these, never the opening tag: <script src="https://…"> is a real fetch.
RAW_TEXT = re.compile(r"<(script|textarea)\b[^>]*>(.*?)</\1\s*>", re.I | re.S)

# The skeleton in theme.html ships an example diagram. Copying it must not hand the artifact a
# diagram it did not draw, so the placeholder says so and is never counted.
PLACEHOLDER = re.compile(r"data-placeholder\s*=\s*[\"']true", re.I)

# Markup that actually activates Mermaid, wherever it sits — <pre class="mermaid"> included.
MERMAID = re.compile(r"(?<![\w-])class\s*=\s*[\"']?[^\"'>]*\bmermaid\b"
                     r"|(?<![\w-])id\s*=\s*[\"']?mermaid-"
                     r"|(?<![\w-])aria-roledescription\s*=\s*[\"']?flowchart", re.I)
# The Markdown fence renders nothing in an HTML artifact, so it only counts outside a code block:
# an artifact showing ```mermaid inside <pre><code> is documenting the ban, not breaking it.
MERMAID_FENCE = re.compile(r"```mermaid", re.I)
CODE_REGION = re.compile(r"<(pre|code)\b[^>]*>(.*?)</\1\s*>", re.I | re.S)

# Headings whose subject is a flow. Kept broad on purpose: a missed flow heading is a page with no
# picture, which is the failure this file exists to catch.
FLOW_WORDS = ("walkthrough", "mechanism", "how it works", "how this works", "how one",
              "architecture", "request path", "request chain", "call path", "pipeline",
              "the flow", "data flow", "end to end", "end-to-end", "in order", "round trip",
              "lifecycle", "sequence")
DELTA_WORDS = ("delta", "what exists", "what already exists", "before and after", "as-is",
               "current state", "what changes")
RANK_WORDS = ("ranking", "ranked", "hierarchy", "ladder", "tiers", "precedence", "priority order")

# A percentage inside a table cell. Figures in prose are not detectable without flagging every
# number on the page, so the gate sees a table of shares and nothing looser. The cell is matched
# whole and its tags stripped, because <td><strong>45%</strong></td> is the same figure and reading
# only the cell's direct text missed it.
TABLE_CELL = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]\s*>", re.I | re.S)
PERCENT = re.compile(r"\d+(?:\.\d+)?\s*%")
# One share quoted inside a sentence is not a set of figures worth charting; three is.
PERCENT_CELLS_FOR_CHART = 3

# An option that is an escape hatch rather than a real alternative. Matched whole, never as a prefix
# or substring, so "No change to API; migrate storage" stays a real approach.
HATCH = frozenset({"other", "none", "dismiss", "snooze", "skip", "later", "cancel", "no change",
                   "do nothing", "not now", "no action", "defer", "park"})
COMPARISON_WORDS = ("approach", "option", "alternative", "path", "candidate", "recommend", "versus",
                    " vs ")


def line_of(text, offset):
    return text.count("\n", 0, offset) + 1


def one_or_many(subject, count, tail):
    """One line per file per check. Fifty separate lines for the same fault is noise."""
    if count == 1:
        return subject + tail
    return "%s, and %d more like it%s" % (subject, count - 1, tail)


def text_of(html):
    return " ".join(TAG.sub(" ", html).split())


def prose_words(fragment):
    """Words outside headings. A heading between two tables does not separate them."""
    without_headings = HEADING.sub(" ", fragment)
    return len(WORD.findall(TAG.sub(" ", without_headings)))


def root_tag(block):
    """The opening <svg> tag only.

    aria-hidden and data-placeholder describe the whole drawing, so they are only meaningful on the
    root. Searching the entire block let one decorative child hide a visible diagram from the budget
    and from the accessibility check.
    """
    match = re.match(r"<svg\b[^>]*>", block, re.I)
    return match.group(0) if match else block


def is_decorative(block):
    return bool(re.search(r"aria-hidden\s*=\s*[\"']true", root_tag(block), re.I))


def real_diagrams(text):
    """SVGs that are diagrams, not decoration.

    diagram-design requires role="img" AND a <title> on every real diagram, and aria-hidden on
    decorative marks. Accepting either one let a merely-titled decorative SVG satisfy the gate.
    """
    found = []
    for match in SVG_BLOCK.finditer(text):
        block = match.group(0)
        if is_decorative(block) or PLACEHOLDER.search(root_tag(block)):
            continue
        if re.search(r"<title\b", block, re.I) and re.search(r"role\s*=\s*[\"']img",
                                                             root_tag(block), re.I):
            found.append(match)
    return found


def check_svg_accessibility(text):
    """An SVG carrying one half of the contract is a diagram with a bug, not decoration.

    Reported on its own so the author sees "add role=img" rather than "the page is a diagram short".
    """
    problems = []
    for match in SVG_BLOCK.finditer(text):
        block = match.group(0)
        if is_decorative(block):
            continue
        has_title = bool(re.search(r"<title\b", block, re.I))
        has_role = bool(re.search(r"role\s*=\s*[\"']img", root_tag(block), re.I))
        if has_title and has_role:
            continue
        # Neither one was treated as decoration and skipped, but decoration says so with
        # aria-hidden. An SVG carrying neither is in no declared state at all.
        if has_title:
            missing = 'role="img"'
        elif has_role:
            missing = "a <title>"
        else:
            missing = 'both a <title> and role="img"'
        problems.append((FAIL, line_of(text, match.start()),
                         "has an SVG missing %s; a diagram needs both, and decoration needs "
                         'aria-hidden="true"' % missing))
    return problems[:3]


def fetches_remotely(tag):
    """Whether a tag names a remote resource in any of its resource-bearing attributes.

    srcset holds a comma-separated candidate list, so `local.png 1x, https://cdn/x.png 2x` fetches
    remotely on a 2x screen. Checking only whether the attribute STARTS with a remote URL read the
    first candidate and passed the rest.
    """
    # (?<![\w-]) because \b alone matched the tail of data-src, data-href and data-poster, none of
    # which fetches anything — and a remote value in one of those refused the artifact.
    for match in re.finditer(r"(?<![\w-])(href|src|xlink:href|data|poster)\s*=\s*[\"']?\s*"
                             r"([^\"'>\s]*)", tag, re.I):
        # The browser decodes character references before it fetches, so src="https&colon;//cdn/x"
        # is a network request that no literal https:// appears in.
        if re.match(REMOTE, html.unescape(match.group(2)), re.I):
            return True
    # Quoted or not: HTML allows a single unquoted candidate, and <img srcset=https://cdn/x.png>
    # fetched while passing.
    for match in re.finditer(r"\bsrcset\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\"'>\s]+))", tag, re.I):
        value = next(group for group in match.groups() if group is not None)
        for candidate in value.split(","):
            url = candidate.strip().split()[0] if candidate.strip() else ""
            if re.match(REMOTE, html.unescape(url), re.I):
                return True
    return False


def markup_only(text):
    """The document with the regions a browser never parses as markup blanked out.

    An artifact that WRITES an example — <!-- <img src="https://…"> --> — makes no request, and
    refusing it now blocks curator open. Offsets are preserved, so line numbers still hold.
    """
    spans = [(m.start(), m.end()) for m in HTML_COMMENT.finditer(text)]
    spans += [(m.start(2), m.end(2)) for m in RAW_TEXT.finditer(text)]
    return blank_spans(text, spans)


def image_set_candidates(css):
    for call in IMAGE_SET.finditer(css):
        for candidate in call.group(1).split(","):
            stripped = candidate.strip().strip("\"'")
            if stripped:
                yield call, stripped


CSS_ESCAPE = re.compile(r"\\(?:([0-9a-fA-F]{1,6})\s?|(.))", re.S)


def decode_css_escapes(css):
    """CSS lets any character be escaped, so url(https\\3a //cdn/x) is a fetch with no ':' in it."""
    def replace(match):
        if match.group(1):
            try:
                return chr(int(match.group(1), 16))
            except ValueError:
                return match.group(0)
        return match.group(2)
    return CSS_ESCAPE.sub(replace, css)


def css_reaches_network(css):
    """Whether this CSS actually names a remote resource.

    An image-set() with every candidate local is not a fetch: testing only that the function exists
    reported one as soon as any character reference appeared elsewhere in the same region.
    """
    if CSS_FETCH.search(css):
        return True
    return any(re.match(REMOTE, url, re.I) for _, url in image_set_candidates(css))


def check_external(text):
    """Any resource fetched over the network, not only <link> and <script>.

    An external <img>, <iframe>, <video>, SVG <image> or a CSS url() breaks offline rendering just
    as thoroughly, and all of them used to pass.
    """
    problems = []
    # <base href="https://…"> fetches nothing itself and makes every relative URL on the page
    # remote, so each of those tags passes its own check while the document still needs a network.
    for match in re.finditer(r"<base\b[^>]*>", text, re.I):
        if re.search(r"\bhref\s*=\s*[\"']?\s*" + REMOTE, html.unescape(match.group(0)), re.I):
            problems.append((FAIL, line_of(text, match.start()),
                             "sets a remote <base>, which makes every relative URL on the page a "
                             "network fetch; drop it, because an artifact has to render with no "
                             "network"))
    # A refresh redirect is not a resource fetch, so it passed every attribute check and navigated
    # the moment the artifact opened.
    for match in re.finditer(r"<meta\b[^>]*>", text, re.I):
        tag = match.group(0)
        if not re.search(r"\bhttp-equiv\s*=\s*[\"']?\s*refresh", tag, re.I):
            continue
        if re.search(r"\burl\s*=\s*[\"']?\s*" + REMOTE, html.unescape(tag), re.I):
            problems.append((FAIL, line_of(text, match.start()),
                             "redirects over http(s) with a meta refresh; drop it, because an "
                             "artifact has to render with no network"))
    for match in FETCHING_TAG.finditer(text):
        tag = match.group(0)
        if not fetches_remotely(tag):
            continue
        # Only <link> has an inerting rel. On anything else rel is decoration the browser ignores,
        # so <img rel="canonical" src="https://…"> fetched the image and skipped the check.
        if match.group(1).lower() == "link":
            # Quoted or not, so <link rel=canonical href=…> is exempt like its quoted equivalent.
            rel = re.search(r"(?<![\w-])rel\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\"'>\s]+))",
                            tag, re.I)
            if rel:
                value = next(group for group in rel.groups() if group is not None)
                tokens = set(value.lower().split())
                if tokens and tokens <= INERT_REL:
                    continue
        problems.append((FAIL, line_of(text, match.start()),
                         "fetches <%s> over http(s); inline it or drop it, because an artifact has "
                         "to render with no network" % match.group(1).lower()))
    # A commented-out rule fetches nothing, and the paint scan already ignores CSS comments; this one
    # did not, so /* avoid url(https://…) */ refused the artifact.
    css_text = blank_spans(text, css_comment_spans(text))
    for region in list(STYLE_BLOCK.finditer(css_text)) + list(STYLE_ATTR.finditer(css_text)):
        # STYLE_ATTR has one group per quoting form, so take whichever one matched.
        index = next(i for i, group in enumerate(region.groups(), start=1) if group is not None)
        css, offset = region.group(index), region.start(index)
        # The browser decodes character references first, so style="background:url(https&colon;//…)"
        # is a fetch. Decoding shifts offsets, so a hit found only after decoding is reported at the
        # region's own line rather than at a position inside the decoded copy.
        # Both layers the browser resolves before fetching: HTML character references, then CSS
        # escapes. url(https\3a //cdn/x.png) contains no "://" until the second one is applied.
        decoded = decode_css_escapes(html.unescape(css))
        if decoded != css and css_reaches_network(decoded) and not css_reaches_network(css):
            problems.append((FAIL, line_of(text, offset),
                             "fetches a resource from CSS over http(s) through an encoded URL; "
                             "inline it, because an artifact has to render with no network"))
        for match in CSS_FETCH.finditer(css):
            problems.append((FAIL, line_of(text, offset + match.start()),
                             "fetches a resource from CSS over http(s); inline it, because an "
                             "artifact has to render with no network"))
        for call in IMAGE_SET.finditer(css):
            for candidate in call.group(1).split(","):
                stripped = candidate.strip().strip("\"'")
                if re.match(REMOTE, stripped, re.I):
                    problems.append((FAIL, line_of(text, offset + call.start()),
                                     "fetches an image-set candidate over http(s); inline it, "
                                     "because an artifact has to render with no network"))
                    break
    return problems[:MAX_LINES_PER_CHECK]


def class_attributes(text):
    """Every class attribute on a real tag, with its absolute offset.

    A class attribute only exists inside a tag, so scanning the document reported prose and code
    samples that merely SHOW class="ok" — and an artifact documenting the ban has to be able to
    quote it. `<code>class="ok"</code>` is text between tags, not an attribute.
    """
    for tag in TAG.finditer(text):
        for match in CLASS_ATTR.finditer(tag.group(0)):
            yield tag.start() + match.start(), match


def check_badges(text):
    hits = []
    for offset, match in class_attributes(text):
        # class="&#111;k" reaches the browser as class "ok", so decode before matching tokens.
        value = html.unescape(next(group for group in match.groups() if group is not None))
        tokens = {token.lower() for token in value.split()}
        hit = tokens & BADGE_TOKENS
        if hit:
            hits.append((offset, sorted(hit)[0]))
    if not hits:
        return []
    return [(FAIL, line_of(text, hits[0][0]), one_or_many(
        'uses the status class "%s"' % hits[0][1], len(hits),
        "; say the state in the sentence instead"))]


def dark_mode_regions(css):
    """The spans of every @media block mentioning prefers-color-scheme, brace-matched.

    Needed because the tokens are DEFINED as literals — that is the point of them — and what makes a
    literal a token is that the dark-mode block redefines it.
    """
    regions = []
    for match in re.finditer(r"@media[^{]*prefers-color-scheme[^{]*\{", css, re.I):
        depth, index = 1, match.end()
        while index < len(css) and depth:
            if css[index] == "{":
                depth += 1
            elif css[index] == "}":
                depth -= 1
            index += 1
        regions.append((match.end(), index))
    return regions


def custom_properties(text):
    """Every custom property declared in the document, and which are redefined for dark mode."""
    declared, themed = {}, set()
    for style in STYLE_BLOCK.finditer(text):
        css = style.group(1)
        dark = dark_mode_regions(css)
        for match in CUSTOM_PROP.finditer(css):
            name = match.group(1).lower()
            declared.setdefault(name, match.group(2).strip().lower())
            if any(start <= match.start() < stop for start, stop in dark):
                themed.add(name)
    return declared, themed


def var_resolves_to_fixed_paint(value, declared, themed, depth=0):
    """Whether var(--x) is a hardcoded colour wearing a token's clothes.

    A custom property the dark-mode block never redefines holds one literal in both themes, so
    `--node-fill:#fff` with `fill:var(--node-fill)` is the hex literal the rule exists to stop.
    """
    if depth > 4:
        return None
    match = re.match(r"var\(\s*(--[\w-]+)\s*(?:,\s*(.+?)\s*)?\)\s*$", value)
    if not match:
        return None
    name, fallback = match.group(1).lower(), match.group(2)
    if name in themed:
        return None
    if name not in declared:
        # An undeclared property renders its fallback, so fill:var(--missing,#fff) is that literal.
        if fallback is None:
            return None
        if fallback.startswith("var("):
            return var_resolves_to_fixed_paint(fallback, declared, themed, depth + 1)
        return None if is_tokenised(fallback) else "%s (%s)" % (value, fallback)
    target = declared[name]
    if target.startswith("var("):
        return var_resolves_to_fixed_paint(target, declared, themed, depth + 1)
    return None if is_tokenised(target) else "%s (%s)" % (value, target)


def paints_with_currentcolor(svg):
    """Whether the SVG actually paints with currentColor, read from paint positions only.

    Searching the whole element for the word caught a <title> or <desc> that merely mentions it, so
    a diagram described in prose was treated as inheriting its colour.
    """
    return any(match.group(2).strip().strip("\"'").lower() == "currentcolor"
               for match in PAINT.finditer(svg))


def is_tokenised(value):
    # url() is only inert when it points at a fragment in this document. fill="url(#grad)" is a local
    # gradient; fill="url(https://cdn/x.svg#grad)" is a network fetch, and no attribute check reads
    # fill, so allow-listing every url() let it through both gates.
    if value.startswith("url("):
        return value[4:].lstrip("\"'").startswith("#")
    return value.startswith(("var(", "#{")) or value in PAINT_KEYWORDS


def blank_spans(text, spans):
    """Blank out regions, keeping length and newlines so every reported line number still holds."""
    chars = list(text)
    for start, stop in spans:
        for index in range(start, stop):
            if chars[index] != "\n":
                chars[index] = " "
    return "".join(chars)


def svg_selector_hooks(element_text):
    """The class and id names that appear inside an SVG, and which of them belong to a diagram that
    paints with currentColor.

    A diagram rule does not have to name svg — `.node { fill:#fff }` paints it just as hard — so
    requiring the word "svg" in the selector was a bypass. Matching on the hooks the artifact's own
    diagrams use keeps that precise without trying to implement a CSS selector engine.

    The second set is per-SVG on purpose: a document-wide flag meant one diagram using currentColor
    made every `color` rule targeting any OTHER diagram count as inherited paint, which refuses a
    valid multi-diagram artifact.
    """
    hooks, color_hooks, any_currentcolor = set(), set(), False
    for block in SVG_BLOCK.finditer(element_text):
        svg = block.group(0)
        mine = set()
        for attr, sigil in (("class", "."), ("id", "#")):
            # Bounded, so data-class="node" does not contribute a hook and make an unrelated
            # .node rule look like diagram paint. Quoted or not: <rect class=node> is valid HTML,
            # and reading only the quoted form left that rect unassociated with its stylesheet rule.
            for match in re.finditer(r"(?<![\w-])%s\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\"'>\s]+))"
                                     % attr, svg, re.I):
                value = next(group for group in match.groups() if group is not None)
                mine.update(sigil + token.lower() for token in value.split())
        hooks |= mine
        if paints_with_currentcolor(svg):
            any_currentcolor = True
            color_hooks |= mine
    return hooks, color_hooks, any_currentcolor


def selector_paints_svg(selector, hooks, has_svg):
    """Whether a rule's selector targets a diagram on this page.

    Matched on whole CSS identifiers. Substring matching made an SVG class `.node` claim
    `.node-description`, and `svg` claim `.svg-preview` — and because this check blocks
    `curator open`, a false positive here refuses a valid artifact.
    """
    if re.search(r"(?<![\w\-.#])svg(?![\w-])", selector, re.I):
        return True
    if any(re.search(re.escape(hook) + r"(?![\w-])", selector, re.I) for hook in hooks):
        return True
    if not has_svg:
        return False
    # The universal selector and an attribute selector both reach an SVG without naming it, so
    # `*[role="img"]` and `.diagram > *` paint the diagram. Recognising the forms is what keeps this
    # honest: dropping the selector test entirely also caught `.unused-icon { fill:#fff }`, a rule
    # that paints nothing, and a mandatory gate that refuses valid work gets switched off.
    if "*" in selector or "[" in selector:
        return True
    # A bare element selector needs neither the word svg nor a class: `rect { fill:#fff }` paints
    # every rect in the page's diagrams. Only as a type selector, so `.text-muted` is not one.
    return any(re.search(r"(?<![\w\-.#])" + name + r"(?![\w-])", selector, re.I)
               for name in SVG_ELEMENTS)


def css_comment_spans(text):
    spans = []
    for style in STYLE_BLOCK.finditer(text):
        spans.extend((c.start(), c.end())
                     for c in CSS_COMMENT.finditer(text, style.start(1), style.end(1)))
    return spans


def check_paint(text):
    """Hardcoded paint inside an SVG, in any of the forms that actually appear."""
    hits = []
    # An <svg> element never lives inside a <style> block, but the literal text can: a CSS comment
    # reading "never inside the <svg>" made SVG_BLOCK open there and swallow the stylesheet, so the
    # rules below were counted twice, once as attributes.
    element_text = blank_spans(text, [(m.start(1), m.end(1)) for m in STYLE_BLOCK.finditer(text)])
    # And a comment ahead of a rule is absorbed into the selector, so a comment merely mentioning
    # svg would make an unrelated rule look like diagram paint.
    css_text = blank_spans(text, css_comment_spans(text))
    # A var() is only a token if the dark-mode block redefines what it points at.
    declared, themed = custom_properties(css_text)
    for block in SVG_BLOCK.finditer(element_text):
        svg = block.group(0)
        for match in PAINT.finditer(svg):
            value = match.group(2).strip().lower()
            if is_tokenised(value):
                fixed = var_resolves_to_fixed_paint(value, declared, themed)
                if fixed:
                    hits.append((block.start() + match.start(), fixed))
                continue
            hits.append((block.start() + match.start(), value))
        # currentColor is only as tokenised as the `color` it inherits. A diagram painting with
        # currentColor under style="color:#fff" is a hex literal wearing a keyword.
        if paints_with_currentcolor(svg):
            for match in COLOR_DECL.finditer(svg):
                value = match.group(1).strip().lower().rstrip(";")
                if is_tokenised(value):
                    continue
                hits.append((block.start() + match.start(), value))

    # A rule in the page's own stylesheet paints the diagram just as hard: `svg .node { fill:#fff }`
    # never appears inside the <svg> element and used to pass.
    hooks, color_hooks, any_currentcolor = svg_selector_hooks(element_text)
    has_svg = bool(SVG_BLOCK.search(element_text))
    for style in STYLE_BLOCK.finditer(css_text):
        for rule in CSS_RULE.finditer(style.group(1)):
            selector = rule.group(1)
            patterns = []
            targets_svg = selector_paints_svg(selector, hooks, has_svg)
            if targets_svg:
                patterns.append(PAINT)
            # `color` is not SVG-only, so it needs the selector: it is paint only for a diagram that
            # actually reads currentColor, either through a hook of its own or through a rule
            # targeting svg or a bare element type.
            targets_specific = any(re.search(re.escape(hook) + r"(?![\w-])", selector, re.I)
                                   for hook in hooks)
            inherits_color = (any(re.search(re.escape(hook) + r"(?![\w-])", selector, re.I)
                                  for hook in color_hooks)
                              or (not targets_specific and any_currentcolor))
            if inherits_color and targets_svg:
                patterns.append(COLOR_DECL)
            for pattern in patterns:
                for match in pattern.finditer(rule.group(2)):
                    value = match.group(len(match.groups())).strip().lower().rstrip(";")
                    if is_tokenised(value):
                        fixed = var_resolves_to_fixed_paint(value, declared, themed)
                        if fixed:
                            hits.append((style.start(1) + rule.start(2) + match.start(), fixed))
                        continue
                    hits.append((style.start(1) + rule.start(2) + match.start(), value))
    if not hits:
        return []
    return [(FAIL, line_of(text, hits[0][0]), one_or_many(
        'paints an SVG with "%s"' % hits[0][1], len(hits),
        "; reference a token such as var(--ink) or var(--accent), or the diagram breaks in "
        "dark mode"))]


def check_mermaid(text):
    # Only on real tags: prose or a <code> sample showing class="mermaid" activates nothing, and an
    # artifact documenting the ban has to be able to quote it.
    offset = None
    for tag in TAG.finditer(text):
        found = MERMAID.search(tag.group(0))
        if found:
            offset = tag.start() + found.start()
            break
    if offset is None:
        # class="&#109;ermaid" reaches the browser as class "mermaid", so class values are read
        # decoded, through the attribute rather than the document, keeping the offset real.
        for attr_offset, attr in class_attributes(text):
            value = html.unescape(next(g for g in attr.groups() if g is not None))
            if "mermaid" in {token.lower() for token in value.split()}:
                offset = attr_offset
                break
    if offset is not None:
        return [(FAIL, line_of(text, offset),
                 "embeds Mermaid; diagrams go through the diagram-design skill so they carry the "
                 "theme tokens and an accessible title")]
    # The fence only renders outside a code block, so a documented example does not count.
    outside_code = blank_spans(text, [(m.start(2), m.end(2))
                                      for m in CODE_REGION.finditer(text)])
    match = MERMAID_FENCE.search(outside_code)
    if not match:
        return []
    return [(FAIL, line_of(text, match.start()),
             "embeds Mermaid; diagrams go through the diagram-design skill so they carry the "
             "theme tokens and an accessible title")]


def check_required(markup, styled, active):
    """`markup` has the stylesheet blanked; `styled` keeps it. The h1 is an element, the dark-mode
    block is CSS, so they read different things."""
    problems = []
    if "no-h1" in active and not re.search(r"<h1\b", markup, re.I):
        problems.append((FAIL, 1, "has no <h1>; every artifact needs a title stating the finding"))
    if "dark-mode" in active and "prefers-color-scheme" not in styled:
        problems.append((WARN, 1, "has no prefers-color-scheme block, so it will not follow a "
                                  "dark theme"))
    return problems


def check_stacked_tables(text):
    pairs = [m for m in STACKED.finditer(text) if prose_words(m.group(1)) < 4]
    if not pairs:
        return []
    return [(FAIL, line_of(text, pairs[0].start()),
             "stacks tables in %d place%s with only a heading between them; keep the one table "
             "whose shape carries meaning and write the rest as sentences"
             % (len(pairs), "" if len(pairs) == 1 else "s"))]


def is_hatch(label):
    """An escape hatch, not a real alternative.

    Matched on the whole label. Substring matching threw away "No change to API; migrate storage",
    and anchoring at the start threw away the same one, because "no change" leads a real approach as
    readily as it names a hatch. A hatch is the entire option or it is not a hatch. Triage triples
    stay quiet through the comparison-heading gate in diagram_obligations, not through this.
    """
    text = re.sub(r"[\s.!—-]+$", "", label.strip().lower())
    return "(specify)" in text or text in HATCH


def sections(text):
    """The span of each heading, from it to the next heading of the SAME OR SHALLOWER level.

    A drawing belongs to its section, and a subsection is inside its parent: an <h2> that owes a
    drawing is satisfied by one under an <h3> beneath it. Stopping at the next heading of any level
    reported those as missing.
    """
    marks = [(m.start(), m.end(), int(m.group(1)), text_of(m.group(2))) for m in HEADING.finditer(text)]
    spans = []
    for index, (start, end, level, heading) in enumerate(marks):
        stop = len(text)
        for later_start, _, later_level, _ in marks[index + 1:]:
            if later_level <= level:
                stop = later_start
                break
        spans.append({"start": start, "body_start": end, "stop": stop, "heading": heading})
    return spans


def innermost(spans, offset):
    """The deepest section containing an offset.

    Content-derived obligations attach here rather than to every heading above them: a section now
    contains its subsections, so counting per-span would report one missing chart once per level.
    """
    best = None
    for span in spans:
        if span["body_start"] <= offset < span["stop"]:
            if best is None or span["body_start"] > best["body_start"]:
                best = span
    return best


def ancestry(spans, span):
    """A span and every section enclosing it, so a subsection inherits its parent's subject.

    Compared on `start`, not `body_start`: a span's own body_start is always past its start, so
    keying on that excluded the span itself and a decision block sitting directly under an
    "Approaches" heading never saw the word that makes it a comparison.
    """
    return [s for s in spans if s["start"] <= span["start"] and span["stop"] <= s["stop"]]


def diagram_obligations(text):
    """What the content owes, itemised, and where each obligation lives.

    Obligations carry their span so a drawing has to sit in the section that owes it. A global count
    let one mechanism drawing satisfy a second, unrelated flow further down the page.
    """
    spans = sections(text)
    owed = []

    # Keyed to the heading's own wording, so no ancestor picks these up a second time.
    for span in spans:
        lowered = span["heading"].lower()
        # Delta map warns rather than gates: blocks.md marks its drawing RECOMMENDED, with an
        # explicit exception for a delta that is a single named piece. Failing an ordinary
        # "Current state" heading would enforce a rule the library does not state.
        for words, level, describe in ((FLOW_WORDS, FAIL, 'the flow described by "%s"'),
                                       (DELTA_WORDS, WARN, 'the before-and-after in "%s"'),
                                       (RANK_WORDS, FAIL, 'the ranking in "%s"')):
            if any(word in lowered for word in words):
                owed.append((span["start"], span, describe % span["heading"], level))

    counts = {}
    for cell in TABLE_CELL.finditer(text):
        if not PERCENT.search(text_of(cell.group(1))):
            continue
        span = innermost(spans, cell.start())
        if span is None:
            continue
        counts.setdefault(id(span), [span, 0])[1] += 1
    for span, count in counts.values():
        if count >= PERCENT_CELLS_FOR_CHART:
            owed.append((span["start"], span, 'the figures under "%s"' % span["heading"], FAIL))

    for match in QUESTION.finditer(text):
        span = innermost(spans, match.start())
        if span is None:
            continue
        nxt = QUESTION.search(text, match.start() + 1)
        end = min(nxt.start(), span["stop"]) if nxt else span["stop"]
        options = re.findall(r'data-plan-option\s*=\s*["\']([^"\']*)["\']',
                             text[match.start():end], re.I)
        real = [o for o in options if not is_hatch(o)]
        # The heading naming the comparison may be the parent of the one holding the block.
        headings = " ".join(s["heading"].lower() for s in ancestry(spans, span))
        if len(real) >= 3 and any(word in headings for word in COMPARISON_WORDS):
            owed.append((match.start(), span, "the comparison of %d options" % len(real), FAIL))

    return sorted(owed, key=lambda item: item[0])


def check_diagram_budget(text):
    """Each obligation needs a drawing inside its own section, and two need two."""
    diagrams = real_diagrams(text)
    obligations = diagram_obligations(text)

    per_span = {}
    for offset, span, subject, level in obligations:
        per_span.setdefault(id(span), {"span": span, "items": []})["items"].append(
            (offset, subject, level))

    # A drawing cannot cover two obligations, and a section contains its subsections, so a drawing
    # under an <h3> would otherwise also discharge its parent <h2>. Allocate innermost-first — the
    # section the drawing actually sits in claims it — and a parent only counts what is left.
    claimed = set()
    problems = []
    for entry in sorted(per_span.values(), key=lambda e: -e["span"]["body_start"]):
        span = entry["span"]
        inside = [d for d in diagrams
                  if span["body_start"] <= d.start() < span["stop"] and d.start() not in claimed]
        # A drawing settles a required obligation before a recommended one, so a section owing both
        # and carrying one is short on the recommendation, not on the rule.
        items = sorted(entry["items"], key=lambda item: item[2] != FAIL)
        for diagram in inside[:len(items)]:
            claimed.add(diagram.start())
        for offset, subject, level in items[len(inside):]:
            problems.append((level, line_of(text, offset),
                             "%s has no drawing in its own section; one drawing per flow, "
                             "comparison, before-and-after, ranking and set of figures, and a "
                             "drawing cannot cover two" % subject))
    return sorted(problems, key=lambda p: p[1])[:3]


BESPOKE = (check_external, check_badges, check_paint, check_mermaid, check_stacked_tables,
           check_svg_accessibility, check_diagram_budget)
BADGE_CHECKS = {check_badges: "badge-class"}
# These read the real stylesheet. Everything else reads markup only, with style contents blanked, so
# HTML-looking text in CSS — /* <svg></svg> */ or content:'class="ok"' — is not read as an element.
NEEDS_STYLESHEET = frozenset({check_external, check_paint})


def check_file(path):
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as error:
        return [(FAIL, 0, "cannot be read: %s" % error.strerror)]

    active = {"no-h1", "dark-mode", "badge-class"}
    # Both the marker AND the guide's own filename. The marker alone is editable document content,
    # so any artifact could paste it in and turn two checks off. Read on the raw text, because the
    # marker IS an HTML comment.
    if GUIDE_MARKER in text and GUIDE_FILE.match(os.path.basename(path)):
        active -= GUIDE_EXEMPT

    # Every check reads markup the browser actually parses. An SVG, a badge class or a Mermaid div
    # inside a comment or a <script> is an example the artifact is writing about: it must not fail
    # the page, and it must not satisfy a diagram obligation either.
    text = markup_only(text)
    # The stylesheet is CSS, not markup, so the markup checks do not read it either.
    markup = blank_spans(text, [(m.start(1), m.end(1)) for m in STYLE_BLOCK.finditer(text)])

    problems = check_required(markup, text, active)
    for check in BESPOKE:
        if BADGE_CHECKS.get(check) and BADGE_CHECKS[check] not in active:
            continue
        problems.extend(check(text if check in NEEDS_STYLESHEET else markup))
    return sorted(problems, key=lambda problem: (problem[1], problem[2]))


def main(argv):
    if not argv:
        print("usage: artifact-check.py <file.html> [...]", file=sys.stderr)
        return 2

    failures = 0
    for path in argv:
        for level, line, message in check_file(path):
            location = "%s:%d" % (path, line) if line else path
            print("%s%s %s" % ("warning: " if level == WARN else "", location, message))
            if level == FAIL:
                failures += 1

    if failures:
        return 1
    print("OK, nothing to fix in %d artifact%s" % (len(argv), "" if len(argv) == 1 else "s"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
