# Yomu Source Hunter v2

Hunter v2 turns public source ecosystems into **candidate feeds**, then makes every candidate survive Yomu's own live reader tests before it can be considered for the Community Pack.

## Candidate feeds

Hunter currently reads public metadata from:

- `Aidoku-Community/sources` — source name, language, base URL and version metadata.
- `YofaGh/MangaScraper` — manga module domains and their test samples.

Yomu does **not** assume a source works because another project lists it. A GitHub listing only earns the source a place in the test queue.

`YofaGh/MangaScraper` is MIT licensed. Hunter consumes its public module registry as discovery metadata; it does not vendor its scraper implementation. Other ecosystems can be added later as candidate feeds without changing Yomu's promotion rules.

## Dedupe and rotation

Before testing, Hunter removes hosts already present in Yomu's Community Pack or extension registry. The remaining candidates are scored by cross-ecosystem evidence and rotated daily, so scheduled runs inspect a manageable batch rather than hammering every known site.

Default scheduled batch: **8 unseen candidates per day**.

## The gauntlet

For each selected site Hunter:

1. Uses Source Forge discovery to find a real title/series page.
2. Runs the existing Yomu catalog → chapters → reader-page gauntlet across multiple chapter samples.
3. Checks visible chapter dates and requires activity within **5 days** for an automatic PASS.
4. Fetches small prefixes/ranges from real reader images and checks dimensions/size as a quality floor.
5. Rejects broken readers, duplicate/shared-chrome traps, stale sources and clearly low-quality image samples.

### Results

- **PASS** — reader gauntlet passes, recent activity is proven, and image quality passes.
- **REVIEW** — reader works, but freshness or image quality cannot be proven automatically.
- **REJECT** — reader gauntlet fails, activity is stale, or image quality is below the floor.

A PASS is still only a **candidate**. Hunter intentionally does not edit `dist-app/source-packs/community.json` by itself.

## Outputs

Every live run produces:

- `hunter-output/report.json` — full machine-readable evidence.
- `hunter-output/summary.md` — compact human review table.
- `hunter-output/candidate-pack.json` — PASS survivors in source-pack format, ready for review/testing before promotion.

GitHub Actions uploads these as the `yomu-hunter-report` artifact and shows the summary in the workflow run.

## Commands

Install Source Forge and Chromium once, then:

```bash
npm run source:hunter -- --max 8 --fresh-days 5 --out hunter-output
```

Useful options:

```text
--max N            number of candidates tested in this run (1–30)
--fresh-days N     maximum visible chapter age for PASS
--timeout MS       per-page timeout
--max-probes N     Source Forge discovery probe budget
--out PATH         report directory
--all-languages    include non-English candidate feeds
```

## Automation

`.github/workflows/source-hunter.yml` runs validation on pull requests and runs the live Hunter on a daily schedule or manual workflow dispatch. Daily execution does not mean every source must publish daily: the freshness gate remains a rolling five-day requirement.
