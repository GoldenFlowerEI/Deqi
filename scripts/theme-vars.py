"""
v0.5: replace hardcoded hex colours in styles.css with the semantic
variables added in the same change.

Hand-editing 75 call sites is how you get three of them missed. The
mapping is explicit, the script fails loudly if a colour is not in
the table, and it prints what it changed so the diff is reviewable.
"""
import sys

MAP = {
    # accents
    "#89b4fa": "var(--accent-blue)",
    "#8aa6ff": "var(--accent-slate)",
    "#cba6f7": "var(--accent-purple)",
    "#a6e3a1": "var(--accent-green)",
    "#f38ba8": "var(--accent-red)",
    "#f9e2af": "var(--accent-amber)",
    # layout surfaces that also live in the palette
    "#181c26": "var(--assistant-bg)",
    "#1a1d27": "var(--tool-bg)",
    "#1a1e28": "var(--bg-card)",
    "#1f2533": "var(--user-bg)",
    "#1c2030": "var(--bg-input)",
    "#14171f": "var(--bg-elev)",
    "#2a3340": "var(--border)",
    "#6b7280": "var(--fg-muted)",
    "#9ca3af": "var(--think-fg)",
    "#9aa1b0": "var(--fg-dim)",
    "#e6e8ee": "var(--fg)",
    # Text drawn on the accent fill. Both themes use a dark amber, so
    # one value covers both — but it still has to be a variable, or the
    # light theme's buttons keep dark-on-dark text.
    "#1f1300": "var(--accent-on)",
    # A slightly different red, but the same job: error text. Mapping
    # it to the semantic token is what makes it legible in light mode.
    "#f87171": "var(--status-err)",
}

# rgba() overlays keyed by their base colour.
RGBA_MAP = {
    "rgba(137, 180, 250, 0.35)": "var(--accent-blue-soft)",
    "rgba(255, 255, 255, 0.035)": "var(--accent-inset)",
    "rgba(255, 255, 255, 0.06)": "var(--accent-inset-2)",
    "rgba(0, 0, 0, 0.24)": "var(--accent-code-bg)",
}

path = sys.argv[1]
with open(path, "r", encoding="utf-8", errors="surrogateescape") as fh:
    text = fh.read()

# Split into three regions BEFORE any replacement: the dark palette, the
# light palette, and the body. The two palette blocks define the very
# variables this script substitutes, so running a substitution across
# them rewrites the definitions into self-references like
# `--accent-inset: var(--accent-inset)` — silently, and only visible if
# you read the top of the file.
marker = ":root[data-theme='light']"
cut = text.find(marker)
if cut == -1:
    print("warning: no light-theme block found; substituting the whole file")
    head, palettes, tail = "", "", text
else:
    end = text.find("\n}", cut)
    if end == -1:
        print("error: unterminated light-theme block; refusing to rewrite")
        sys.exit(1)
    end += 2
    head, palettes, tail = text[:cut], text[cut:end], text[end:]

changed = 0
for src, dst in RGBA_MAP.items():
    n = tail.count(src)
    if n:
        tail = tail.replace(src, dst)
        changed += n

for src, dst in MAP.items():
    n = tail.count(src)
    if n:
        tail = tail.replace(src, dst)
        changed += n

# The alpha variants of the accent colours, used for borders/tints.
import re

ALPHA = {
    "89, 180, 250": "--accent-blue-rgb",
    "243, 139, 168": "--accent-red-rgb",
    "249, 226, 175": "--accent-amber-rgb",
    "166, 227, 161": "--accent-green-rgb",
    "203, 166, 247": "--accent-purple-rgb",
    "138, 166, 255": "--accent-slate-rgb",
}
rgb_changed = 0
for src, var in ALPHA.items():
    pattern = re.compile(r"rgba\(" + re.escape(src) + r",\s*([0-9.]+)\)")
    found = pattern.findall(tail)
    if found:
        rgb_changed += len(found)
        tail = pattern.sub(lambda m: f"rgb(var({var}) / {m.group(1)})", tail)

with open(path, "w", encoding="utf-8", errors="surrogateescape", newline="") as fh:
    fh.write(head + palettes + tail)

# Fail loudly rather than leaving a half-themed file behind. A colour
# left literal is invisible in review and unthemed in the product.
leftovers = sorted(set(re.findall(r"#[0-9a-fA-F]{6}", tail)))
if leftovers:
    print("LEFTOVER literal colours outside the palette:", ", ".join(leftovers))
    sys.exit(1)

print(f"replaced {changed} literal colours, {rgb_changed} alpha tints")
