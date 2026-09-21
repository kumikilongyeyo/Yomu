#!/usr/bin/env python3
"""Exact Android execution canary for Yomu's APKBridge runtime.

Uses only the Python standard library so GitHub Actions can run it without
installing dependencies. It intentionally exercises a real extension through
popular -> details -> chapters -> pages and reports per-stage timings.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def compact_manga(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "url": value.get("url", ""),
        "title": value.get("title", ""),
    }
    for key in (
        "artist",
        "author",
        "description",
        "genre",
        "status",
        "thumbnail_url",
        "update_strategy",
        "initialized",
    ):
        if key in value and value[key] is not None:
            result[key] = value[key]
    return result


def compact_chapter(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "url": value.get("url", ""),
        "name": value.get("name", ""),
    }
    for key in ("date_upload", "chapter_number", "scanlator"):
        if key in value and value[key] is not None:
            result[key] = value[key]
    return result


class Bridge:
    def __init__(self, base_url: str, apk_path: Path, timeout: int) -> None:
        self.url = base_url.rstrip("/") + "/dalvik"
        raw = apk_path.read_bytes()
        if not raw.startswith(b"PK\x03\x04"):
            raise RuntimeError(f"{apk_path} is not an APK/ZIP payload")
        self.apk_b64 = base64.b64encode(raw).decode("ascii")
        self.timeout = timeout

    def invoke(self, method: str, **fields: Any) -> tuple[Any, float]:
        payload: dict[str, Any] = {"data": self.apk_b64, "method": method, "page": 1}
        payload.update(fields)
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Yomu-APKBridge-Canary/1.0",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} failed with HTTP {exc.code}: {body[:500]}") from exc
        duration = time.perf_counter() - started
        try:
            return json.loads(body), duration
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{method} returned invalid JSON: {body[:500]}") from exc


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge-url", default="http://127.0.0.1:18081")
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=75)
    args = parser.parse_args()

    bridge = Bridge(args.bridge_url, args.apk, args.timeout)
    timings: dict[str, float] = {}
    total_started = time.perf_counter()

    popular, timings["popular"] = bridge.invoke("getPopularManga", page=1)
    require(isinstance(popular, dict), "popular response is not an object")
    mangas = popular.get("mangas")
    require(isinstance(mangas, list) and len(mangas) > 0, "popular returned no manga")
    manga = mangas[0]
    require(isinstance(manga, dict) and manga.get("url") and manga.get("title"), "first manga is missing url/title")
    print(f"popular: {len(mangas)} titles; canary={manga.get('title')!r}")

    details, timings["details"] = bridge.invoke("getDetailsManga", mangaData=compact_manga(manga))
    require(isinstance(details, dict) and details.get("url"), "details returned no manga payload")
    print(f"details: title={details.get('title')!r}")

    chapters, timings["chapters"] = bridge.invoke("getChapterList", mangaData=compact_manga(details))
    require(isinstance(chapters, list) and len(chapters) > 0, "chapter list is empty")
    chapter = next((item for item in chapters if isinstance(item, dict) and item.get("url")), None)
    require(chapter is not None, "chapter list has no usable chapter")
    print(f"chapters: {len(chapters)}; canary={chapter.get('name')!r}")

    pages, timings["pages"] = bridge.invoke("getPageList", chapterData=compact_chapter(chapter))
    require(isinstance(pages, list) and len(pages) > 0, "page list is empty")
    usable_pages = [
        page
        for page in pages
        if isinstance(page, dict) and (page.get("imageUrl") or page.get("image_url") or page.get("url"))
    ]
    require(len(usable_pages) > 0, "page list contains no usable image/page URLs")
    print(f"pages: {len(pages)}; usable={len(usable_pages)}")

    total = time.perf_counter() - total_started
    print("timings_seconds=" + json.dumps({key: round(value, 3) for key, value in timings.items()}, sort_keys=True))
    print(f"total_seconds={total:.3f}")
    print("ANDROID_EXACT_EXECUTION_CANARY=PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ANDROID_EXACT_EXECUTION_CANARY=FAIL: {exc}", file=sys.stderr)
        raise
