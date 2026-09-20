#!/usr/bin/env python3
"""Production export optimizer for Yomu.

Keeps deploy-only helpers route-aware instead of adding every search/source
script to every page, hardens the first-paint theme, and removes exact duplicate
resource tags. The source export remains untouched; this runs in CI immediately
before the release gauntlets and Cloudflare upload.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist-app"

COMMON = [
    '<link rel="stylesheet" href="/yomu-controls-base.css">',
    '<link rel="stylesheet" href="/yomu-controls-components.css">',
    '<script src="/yomu-controls.js" defer></script>',
    '<link rel="stylesheet" href="/yomu-mori-chat.css">',
    '<script src="/yomu-mori-drag.js" defer></script>',
    '<script src="/yomu-mori-chat.js" defer></script>',
]

LIBRARY = [
    '<link rel="stylesheet" href="/yomu-library.css">',
    '<script src="/yomu-library-engine.js" defer></script>',
    '<script src="/yomu-library-explorer.js" defer></script>',
]

CATALOG = [
    '<script src="/source-auto-switch.js" defer></script>',
    '<script src="/community-pack-top.js" defer></script>',
    '<link rel="stylesheet" href="/yomu-hero-plus.css">',
    '<script src="/yomu-catalog-fix.js" defer></script>',
    '<script src="/yomu-hero-plus.js" defer></script>',
    *LIBRARY,
]

SEARCH = [
    '<script src="/source-auto-switch.js" defer></script>',
    # Deliberately synchronous: /find can issue its first request while the
    # document is still parsing, so V3 has to capture native fetch first.
    '<script src="/yomu-search-v3.js"></script>',
    '<script src="/yomu-search-fast-bootstrap.js" defer></script>',
    '<script src="/yomu-source-reliability.js" defer></script>',
    '<script src="/yomu-source-ux-v2.js" defer></script>',
    '<script src="/yomu-search-fast.js" defer></script>',
    '<script src="/yomu-catalog-fix.js" defer></script>',
    *LIBRARY,
]

READER = [
    '<script src="/source-auto-switch.js" defer></script>',
    '<script src="/yomu-source-reliability.js" defer></script>',
    '<script src="/yomu-source-ux-v2.js" defer></script>',
]

SOURCES = [
    '<script src="/source-auto-switch.js" defer></script>',
    '<script src="/yomu-source-reliability.js" defer></script>',
    '<script src="/yomu-source-ux-v2.js" defer></script>',
    '<script src="/source-beast-loader.js" defer></script>',
]

BOOT_PAINT = (
    '<style id="yomu-boot-paint">'
    'html[data-yomu-boot="1"][data-mode="dark"],'
    'html[data-yomu-boot="1"][data-mode="dark"] body{background:#080d14!important}'
    'html[data-yomu-boot="1"][data-mode="light"],'
    'html[data-yomu-boot="1"][data-mode="light"] body{background:#f7f4ee!important}'
    '</style>'
)

CATALOG_PAGES = {"index.html", "discover.html", "adult.html"}
SEARCH_PAGES = {"find.html", "search.html"}
SOURCE_PAGES = {"sources.html", "add-sources.html", "extensions.html", "suwayomi-setup.html"}

RESOURCE_TAG = re.compile(r'<(?:script\b[^>]*\bsrc="[^"]+"[^>]*></script>|link\b[^>]*\bhref="[^"]+"[^>]*>)', re.I)


def helpers_for(relative: str) -> list[str]:
    tags = list(COMMON)
    if relative in CATALOG_PAGES:
        tags += CATALOG
    elif relative in SEARCH_PAGES:
        tags += SEARCH
    elif relative in SOURCE_PAGES:
        tags += SOURCES
    elif relative.startswith("read/") or relative.startswith("series/"):
        tags += READER
    return list(dict.fromkeys(tags))


def dedupe_exact_resource_tags(text: str) -> tuple[str, int]:
    seen: set[str] = set()
    removed = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal removed
        tag = match.group(0)
        if tag in seen:
            removed += 1
            return ""
        seen.add(tag)
        return tag

    return RESOURCE_TAG.sub(replace, text), removed


def inject_before_head_close(text: str, tags: list[str]) -> tuple[str, int]:
    added = []
    for tag in tags:
        if tag not in text:
            added.append(tag)
    if added:
        text = text.replace("</head>", "".join(added) + "</head>", 1)
    return text, len(added)


def optimize(path: Path) -> tuple[bool, int, int]:
    text = path.read_text(encoding="utf-8")
    if "</head>" not in text:
        return False, 0, 0

    original = text
    relative = path.relative_to(DIST).as_posix()
    text, removed = dedupe_exact_resource_tags(text)

    if 'id="yomu-boot-paint"' not in text:
        text = text.replace("</head>", BOOT_PAINT + "</head>", 1)

    text, added = inject_before_head_close(text, helpers_for(relative))

    if text != original:
        path.write_text(text, encoding="utf-8")
    return text != original, added, removed


def assert_release_contract() -> None:
    for required in ("find.html", "search.html"):
        text = (DIST / required).read_text(encoding="utf-8")
        for needle in (
            "/yomu-search-v3.js",
            "/yomu-source-reliability.js",
            "/yomu-source-ux-v2.js",
            "/yomu-library-engine.js",
            "/yomu-library-explorer.js",
            "/yomu-library.css",
        ):
            if needle not in text:
                raise SystemExit(f"optimizer contract failed: {required} missing {needle}")

    home = (DIST / "index.html").read_text(encoding="utf-8")
    for needle in ("/yomu-library-engine.js", "/yomu-library-explorer.js", "/yomu-library.css"):
        if needle not in home:
            raise SystemExit(f"optimizer contract failed: index.html missing {needle}")

    reader = DIST / "read" / "[chapterId].html"
    if reader.exists():
        text = reader.read_text(encoding="utf-8")
        for needle in ("/yomu-source-reliability.js", "/yomu-source-ux-v2.js"):
            if needle not in text:
                raise SystemExit(f"optimizer contract failed: reader missing {needle}")

    for path in DIST.rglob("*.html"):
        text = path.read_text(encoding="utf-8")
        if "</head>" in text and 'id="yomu-boot-paint"' not in text:
            raise SystemExit(f"optimizer contract failed: {path} missing first-paint guard")
        if "</head>" in text:
            for needle in ("/yomu-mori-chat.css", "/yomu-mori-drag.js", "/yomu-mori-chat.js"):
                if needle not in text:
                    raise SystemExit(f"optimizer contract failed: {path} missing {needle}")


def main() -> None:
    changed = added = removed = pages = 0
    for path in sorted(DIST.rglob("*.html")):
        pages += 1
        did_change, page_added, page_removed = optimize(path)
        changed += int(did_change)
        added += page_added
        removed += page_removed

    assert_release_contract()
    print(
        f"Yomu export optimized: {pages} pages checked, {changed} changed, "
        f"{added} route-aware helpers added, {removed} duplicate resource tags removed."
    )


if __name__ == "__main__":
    main()
