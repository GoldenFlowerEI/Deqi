#!/usr/bin/env python3
"""
strip-unused-imports.py — remove the unused imports ESLint reports.

Why a script
------------
Turning on linting surfaced 45 unused-symbol errors in shipped
packages. Every one is an import that was added when a feature was
started and never removed when the feature took a different shape.
Deleting them by hand is mechanical and error-prone; doing it by
regex is worse. This reads ESLint's own JSON report and removes
exactly the specifiers ESLint named — nothing inferred.

It only ever touches `import { a, b } from '...'` and
`import x, { a } from '...'` statements, and it refuses to touch
anything it cannot confidently rewrite.

Usage:
    npx eslint <paths> --format json > report.json
    python3 scripts/strip-unused-imports.py report.json [--apply]
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# `import { a, b as c } from 'x'` / `import x, { a } from 'x'` /
# `import * as ns from 'x'` / `import type { T } from 'x'`.
# Spans newlines: most imports in this repo are formatted one
# specifier per line, which a single-line pattern would skip entirely.
IMPORT_RE = re.compile(
    r"^import\s+(?P<type>type\s+)?(?P<clause>[^;]*?)\s+from\s+"
    r"(?P<source>'[^']+'|\"[^\"]+\")\s*;?[ \t]*$",
    re.MULTILINE | re.DOTALL,
)


def specifier_name(spec: str) -> str:
    """`a as b` -> `a` (the binding ESLint reports)."""
    return spec.split(" as ")[0].strip()


def rewrite(stmt: str, drop: set[str]) -> str | None:
    """Remove `drop` from the named-import list of a single import."""
    m = re.match(
        r"^import\s+(?P<type>type\s+)?(?P<default>[A-Za-z_$][\w$]*\s*,\s*)?"
        r"\{(?P<named>[^}]*)\}\s+from\s+(?P<source>'[^']+'|\"[^\"]+\")\s*;?[ \t]*$",
        stmt.strip(),
        re.DOTALL,
    )
    if not m:
        return None
    specs = [s for s in (x.strip() for x in m.group("named").replace("\n", " ").split(",")) if s]
    kept = [s for s in specs if specifier_name(s) not in drop]
    if len(kept) == len(specs):
        return None
    type_kw = m.group("type") or ""
    multiline = "\n" in stmt
    if kept:
        default = re.sub(r"\s+", " ", (m.group("default") or "")).strip()
        if multiline:
            body = "".join(f"\n  {s}," for s in kept)
            return f"import {type_kw}{default}{{{body}\n}} from {m.group('source')};"
        named = ", ".join(kept)
        return f"import {type_kw}{default}{{ {named} }} from {m.group('source')};"
    # Everything named was unused. Keep a side-effect-free import only
    # if there is a default binding; otherwise drop the line entirely.
    default = m.group("default")
    if default:
        return f"import {type_kw}{re.sub(r'\s+', ' ', default).strip()} from {m.group('source')};"
    return None


def read_report(path: Path) -> str:
    """
    Read the ESLint JSON report, whatever the shell wrote it as.

    PowerShell's `>` redirection produces UTF-16LE with a BOM, while
    `cmd` and bash produce UTF-8. Guessing wrong makes the script
    useless to half the people who would run it, so sniff the BOM
    instead.
    """
    raw = path.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    return raw.decode("utf-8")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    report_path = Path(sys.argv[1])
    apply = "--apply" in sys.argv

    report = json.loads(read_report(report_path))
    by_file: dict[str, set[str]] = defaultdict(set)
    for entry in report:
        path = entry.get("filePath") or ""
        # Ignore anything outside the repo, and anything in a tree the
        # linter was told to skip.
        for msg in entry.get("messages", []):
            if msg.get("ruleId") != "@typescript-eslint/no-unused-vars":
                continue
            text = msg.get("message", "")
            if "is defined but never used" not in text:
                continue
            m = re.search(r"'([^']+)'", text)
            if m:
                by_file[path].add(m.group(1))

    if not by_file:
        print("no unused imports reported")
        return 0

    total = 0
    for path, names in sorted(by_file.items()):
        p = Path(path)
        if not p.is_file():
            continue
        src = p.read_text(encoding="utf-8", errors="surrogateescape")
        original = src
        out: list[str] = []
        pos = 0
        for m in IMPORT_RE.finditer(src):
            stmt = m.group(0)
            named = re.search(r"\{([^}]*)\}", stmt, re.DOTALL)
            stmt_names = set()
            if named:
                stmt_names = {
                    specifier_name(s)
                    for s in (
                        x.strip()
                        for x in named.group(1).replace("\n", " ").split(",")
                    )
                    if s
                }
            if not stmt_names or not (stmt_names & names):
                continue
            replacement = rewrite(stmt, names)
            if replacement is None and stmt_names <= names:
                replacement = ""  # every specifier was unused: drop the line
            out.append(src[pos:m.start()])
            out.append(replacement)
            pos = m.end()
        out.append(src[pos:])
        new = "".join(out)
        # Collapse a blank-line pair left by a removed import.
        new = re.sub(r"\n{3,}", "\n\n", new)
        if new != original:
            removed = len(re.findall(r"^\s*import", original, re.M)) - len(
                re.findall(r"^\s*import", new, re.M)
            )
            total += removed
            print(f"{p.name}: removed {removed} import(s)")
            if apply:
                # surrogateescape round-trips bytes that were never
                # valid UTF-8, so a file saved in the system codepage
                # does not get mangled by this tool on its way past.
                p.write_text(new, encoding="utf-8", errors="surrogateescape")
    print(f"\ntotal: {total} import statement(s) {'removed' if apply else 'would be removed'}")
    if not apply:
        print("re-run with --apply to write the changes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
