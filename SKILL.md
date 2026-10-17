---
name: discord-community-research
description: Use when the user needs deep search or research (深度搜索/深度调研) across the Discord servers they have joined — private community discussions, shared resources, authors, and community sentiment that public web search cannot reach — and wants every finding traced to a Discord message. Do not use for quick questions that need no community search, or for general web research.
compatibility: Requires Node.js 20 or newer (22.21+ or 24+ when Discord is reached through a proxy), network access to discord.com, and a Discord user token in DISCORD_TOKEN or a .env file. Scripts use only Node built-ins, so nothing needs installing.
---

# Discord Community Research

## Overview

Run auditable Discord-only research with deterministic local scripts. Inventory
all joined servers, reduce broad query cost with two-stage search, read whole
threads when search is not enough, preserve failures and truncation, and keep
every conclusion traceable to Discord links.

## Scope

This skill only reaches the Discord servers the user's account has joined. If a
request is unlikely to be covered by those communities, tell the user and ask
before searching.

## Setup

- `<skill-dir>` is the directory containing this SKILL.md. Run scripts from the
  user's workspace as `node <skill-dir>/scripts/<name>.mjs`; do not cd into the
  skill directory. The token and output paths resolve from the working
  directory, and commands refuse to write inside the skill directory.
- Token: scripts read `DISCORD_TOKEN` (or the legacy `VITE_DISCORD_TOKEN`) from
  the environment, then from `.env` in the working directory or the file named
  by `DISCORD_RESEARCH_ENV_FILE`. Pass `--env-file <path>` to read one specific
  file. Never put the token on a command line.
- Output: research runs are written to `discord_research/runs/<runId>/` in the
  working directory; set `DISCORD_RESEARCH_OUTPUT` or pass `--output-root` for
  another root. Other commands write where `--output` points. Any directory a
  command creates gets a `.gitignore` so private messages are not committed.
  Save plans as `discord_research/plans/<runId>.json`.
- Proxy: if doctor exits 3 and the machine reaches Discord through a local
  proxy, set `NODE_USE_ENV_PROXY=1` (Node 22.21+ or 24+) with matching `HTTPS_PROXY`/`HTTP_PROXY`;
  doctor reports which of these are set. A network timeout is not an
  authentication result.

## Commands

Every command is in `<skill-dir>/scripts/`, prints its options with `--help`,
rejects unknown flags, writes a JSON summary to stdout, and reports progress on
stderr. Exit code 2 means Discord rejected the token and 3 a network or proxy
failure.

| Command | Use it to |
| --- | --- |
| `doctor.mjs` | check the token, network, and output location |
| `run-research.mjs` | run a research plan end to end: inventory, discovery, validation, enrichment, evidence, report |
| `run-search-plan.mjs` | run every plan query in one pass, without the discovery/validation split |
| `inventory-guilds.mjs` | list joined servers and their channels |
| `threads.mjs` | list forum posts and threads, archived ones included, with starter messages |
| `history.mjs` | read whole channels, threads, or forum posts, with reaction counts |
| `show.mjs` | open messages by jump URL with surrounding context |
| `enrich-hits.mjs` | add context, reply chains, and reaction counts to search hits |
| `media.mjs` | list and download attachments with a manifest |
| `image-metadata.mjs` | read NovelAI, ComfyUI, and A1111 parameters embedded in images |
| `build-evidence-index.mjs` | rebuild a run's graded evidence (`--run-dir`) |
| `build-report.mjs` | rebuild a run's report (`--run-dir`) |

## Workflow

1. Run `node <skill-dir>/scripts/doctor.mjs` first. It reports the account, where the token was loaded from, and the output root. Fix access before starting a run.
2. Clarify the objective, date range, ambiguous terms, and desired evidence. Use [query-planning.md](references/query-planning.md) for query families and search filters.
3. Persist a JSON plan containing runId, objective, queries, dateRange, and bounded options. Mark broad recall queries as purpose: discovery and practical follow-ups as purpose: validation. Filters such as author, has image, attachment extension, or link host go in a query's criteria or a plan-level criteria object.
4. Discord matches a multi-word query as a near-phrase: with the default slop of 2, its words must appear within two words of each other. When the words only need to share a message, set options.slop: 100 (or criteria.slop on one query), or split them into single-term queries and filter with --require-all.
5. Prefer the single-command runner: `node <skill-dir>/scripts/run-research.mjs --plan discord_research/plans/<runId>.json --max-hits 20`. It checks access and the plan's criteria, inventories joined servers, runs discovery across them, runs validation only in discovery-hit servers, enriches top candidates, and writes state.json, contexts.ndjson, evidence.json, and report.md to the run directory.
6. For strict co-occurrence, add --require-all redis,cluster; this filters message body text after deduplication and reports the filtered count.
7. Use --no-enrich for a fast discovery pass. To resume, rerun the same plan from the same working directory; --run-id overrides the plan's runId. Progress and ETA are written to stderr; the final summary is JSON on stdout.
8. Read the report's Coverage line before concluding. yes supports absence claims for every planned query; scoped means validation queries were skipped in servers without discovery hits; no means work failed, was truncated or partial, or the run aborted. Rephrase the queries listed under Zero-Result Queries before reporting that something was not found.
9. Keep at least one discovery query in a run-research plan. For an intentional validation-only or unrestricted single pass, use run-search-plan.mjs.
10. Open any message a finding rests on with `node <skill-dir>/scripts/show.mjs <jump-url>` before quoting it.

## Reading Threads, Forums, and Media

Search finds messages that match words; it is not an inventory. When the task
needs everything in a forum, thread, or channel (every post, image, or reaction),
list the threads with threads.mjs, read them with history.mjs, and follow
[media-collection.md](references/media-collection.md) for downloads, reaction
ranking, and embedded generation parameters. history.mjs marks each channel
complete, truncated, or failed; only complete channels support claims that
something was not posted there.

**Downloading needs no token.** Attachment URLs from Discord's CDN carry their
own signature (`?ex=&is=&hm=`), so `media.mjs --download` fetches them with a
plain GET and no `Authorization` header, right up to the `ex` timestamp. Only
listing (reading messages) and refreshing a link that already expired need the
token. Practical consequence: if the token stops working mid-collection, keep
downloading — the links listed less than a day ago still work. Read the `ex`
values and finish the download before they lapse, because after that the URLs
cannot be renewed without the token.

## Non-Negotiable Rules

- Discord-only by default; external validation requires explicit user approval.
- A failed or rate-limited query is not complete.
- A partial task (Discord still indexing the server, or far fewer messages returned than reported) does not support absence claims.
- Reusing a runId requires identical task inputs. If a query, date range, criteria,
  slop, or page limit changes, start a new runId instead of mixing old and new evidence.
- One process writes a run directory at a time; a second process on the same runId fails fast.
- Truncation and inaccessible servers are visible in the final report.
- Do not claim absence without sufficient completed coverage.
- Never print or persist Discord credentials.
- Keep options.concurrency bounded (default 1; use 2-3 only when rate limits allow).
- Treat project-linked as a concrete external project URL mentioned in Discord,
  unverified-claim as an official or official-sounding claim without such a URL,
  and community-only as ordinary community evidence.
- Read generated UTF-8 JSON/NDJSON with Node or an editor that preserves UTF-8;
  do not use a legacy PowerShell pipeline as the parser for Chinese or emoji text.

Evidence grades describe Discord evidence strength only; they do not prove quality,
correctness, safety, popularity, or external project activity. See
[evidence-rubric.md](references/evidence-rubric.md) for grading and uncertainty language.

## Maintaining This Skill

Keep the directory self-contained so it can be copied to another project or
agent platform: scripts import only Node built-ins and files inside it, and docs
use paths relative to it. Run `node --test` from this directory; test files are
named `*-test.mjs` so a host project's Vitest or Jest defaults skip them.
