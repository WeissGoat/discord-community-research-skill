# Media Collection

Use this when a task needs every post or image in a forum or thread, ranking by
reactions, or verified generation parameters. `<skill-dir>` is the directory
containing SKILL.md. Keep each collection in its own folder, for example
`discord_research/media/<topic>/`; a folder the commands create gets a
`.gitignore` because it holds private content.

## Collect a Forum or Thread

Search hits show that a topic exists; they are not an inventory. Read the posts
directly:

1. List the posts:
   `node <skill-dir>/scripts/threads.mjs --channel <forum-id> --after <date> --output <dir>/threads.json`.
   Forum and media channels are listed newest activity first with tags and each
   post's starter message; text channels combine active, archived public, and
   joined private threads. Add `--name <text>` to match post titles.
2. Read them:
   `node <skill-dir>/scripts/history.mjs --channels-from <dir>/threads.json --after <date> --output <dir>/messages.ndjson`.
   Records keep empty-body messages (many image posts have no text), thread and
   forum titles, attachments, and reaction counts. Pass `--channel <id>` to read
   one channel or thread instead.
3. Check the history summary. A channel is complete when it reached the start
   of the thread or the `--after` date, truncated at `--max-pages` or
   `--max-messages`, or failed. Report truncated and failed threads and rerun
   failed ones with `--channel`.

## Select and Download Attachments

`node <skill-dir>/scripts/media.mjs --input <dir>/messages.ndjson --output <dir>/media --min-dimension 512 --download`

- Inputs can be history or search NDJSON, enrich-hits contexts, evidence.json,
  or threads.json; attachments are deduplicated by attachment id.
- `--types` defaults to png, jpg, jpeg, webp, and gif; `--types all` keeps every
  file. Extension and MIME type complement each other because Discord metadata
  can be incomplete.
- media.json records each file's jump URL, author, timestamp, reaction count,
  local path, SHA-256, and status. Rerunning skips finished files.
- Attachment links expire. Expired links are refreshed by re-reading the
  message, which needs the token. Cite jump URLs, never CDN links.
- `--with-parameters` keeps only images that embed generation parameters. It
  reads the first 64 KB of each file (and the last 64 KB of a PNG when
  needed) and downloads the whole file only when a text chunk carries a
  NovelAI, ComfyUI or A1111 keyword. A file is kept only if its parameters then
  parse; the others are marked `no-parameters` (no file saved). Use it
  to collect prompts from search hits without downloading every attachment;
  reruns do not probe `no-parameters` files again, and the manifest is saved
  every 25 files.

## Reaction-Aware Ranking

History records carry reaction counts. Search hits do not: `reactionCount: null`
means unknown, not zero. run-research fetches counts for the top `--max-hits`
candidates. For more, run
`node <skill-dir>/scripts/enrich-hits.mjs --input <run>/evidence.json --output <dir>/reactions.ndjson --before 0 --after 0 --max-hits 500`
(nearby hits share one request), then
`node <skill-dir>/scripts/build-evidence-index.mjs --run-dir <run> --contexts <dir>/reactions.ndjson`.
Report counts as total emoji reaction marks, not as a like or quality score, and
keep model or metadata verification as a separate filter.

## Embedded Parameter Verification

`node <skill-dir>/scripts/image-metadata.mjs --manifest <dir>/media/media.json --output <dir>/metadata.ndjson`

It also accepts image files or folders. It reads PNG text chunks and JPEG and
WebP EXIF/XMP, classifies each image as novelai, comfyui, a1111, or unknown, and
keeps the Discord link from the manifest.

- NovelAI: `generation.complete` is true only when the model name and hash,
  prompt, negative prompt (UC), steps, size, scale, CFG rescale, seed, sampler,
  and noise schedule are all present; `missing` lists the rest, and `version`
  comes from the model marker (V5, V4.5, V4; V3 for "Stable Diffusion XL").
  V4 and later also give `characters` (each box's prompt, negative and
  `centers`), `useCoords` (false means AI's Choice), `requestType`, and the V5
  UI toggles `quality_boost`, `tag_hint_qt` and `tag_hint_uc_preset` as raw values.
- ComfyUI: checkpoints, LoRAs with strengths, sampler settings, and the prompt
  text the sampler is wired to.
- A1111/Forge: prompt, negative prompt, and the settings line.

Report two totals: downloaded images, and images with complete, verified
parameters. Keep V5, V4/V4.5, incomplete, and metadata-free images in separate
categories. Metadata hidden in pixels (NovelAI stealth info) is not decoded, and
a missing field is unknown, never evidence that another model or tool made the
image. Do not treat a filename, message text, or a visual guess as proof of
parameters.
