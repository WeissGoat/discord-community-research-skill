# Query Planning

Build a small query family instead of relying on one broad keyword. Persist each
query with an id, exact content, purpose, and optional criteria.

## Families

- Exact names: project, product, repository, package, model, or abbreviation.
- Variants: spelling, punctuation, capitalization, plural, translated, and common misspellings.
- Problem language: the question a user would ask when blocked.
- Technical language: install, setup, export, workflow, API, format, error, limit, and version terms.
- Validation language: demo, result, example, benchmark, used, production, limitation, and comparison.

Use discovery queries for recall and validation queries for practical detail. Pair
ambiguous terms with a domain term or filter them after retrieval. Do not treat a
server name or a single high-frequency word as proof of relevance.

## Search Syntax

Discord's `content` search is a proximity match. `slop` is the number of words
allowed between matching tokens: the default is 2 and the maximum is 100. With
the default, `Redis cluster setup` only matches messages where those words sit
close together, which silently drops most co-occurrences.

- Exact names and phrases: keep the default slop.
- Words that only need to share a message: set `options.slop: 100` for the
  plan, or `criteria.slop` on one query.
- Highest recall: search single terms and apply `filters.requireAll` after
  retrieval.

The report's Zero-Result Queries section marks multi-word queries that ran with
the default slop. Rephrase those before reporting absence.

## Search Filters

Put filters in a query's `criteria`, or in a plan-level `criteria` object that
every query inherits; a query's own values win. The runners reject unknown keys
and values before the first request.

| Key | Discord parameter | Values |
| --- | --- | --- |
| `authorIds` | author_id | user ids (max 100) |
| `authorType` | author_type | user, bot, webhook; prefix `-` to exclude |
| `mentions`, `mentionsRoleIds` | mentions, mentions_role_id | user or role ids |
| `mentionEveryone` | mention_everyone | true or false |
| `repliedToUserIds`, `repliedToMessageIds` | replied_to_user_id, replied_to_message_id | ids |
| `channelIds` | channel_id | channel or thread ids (max 500) |
| `has` | has | image, sound, video, file, sticker, embed, link, poll, snapshot; prefix `-` to exclude |
| `attachmentExtension` | attachment_extension | e.g. png, pdf, json |
| `attachmentFilename` | attachment_filename | filename text |
| `linkHostname` | link_hostname | e.g. github.com, huggingface.co, youtube.com |
| `embedType`, `embedProvider` | embed_type, embed_provider | image, video, gif, sound, article; provider names are case-sensitive |
| `pinned` | pinned | true or false |
| `minDate`, `maxDate`, `minId`, `maxId` | min_id, max_id | dates or message ids |
| `sortBy`, `sortOrder` | sort_by, sort_order | timestamp or relevance; asc or desc |
| `slop` | slop | 0 to 100 |
| `includeNsfw` | include_nsfw | default true; false skips age-restricted channels |

Singular spellings (`authorId`, `channelId`, `mentionsRoleId`, and the
`repliedTo...Id` forms) are accepted. List values may be a string or an array.

Filters find structure that words miss: `has: ["image"]` with
`attachmentExtension: ["png"]` narrows to PNG attachments, and
`linkHostname: ["github.com"]` finds repository links that never name the
project. A query may leave `content` empty to search by filters alone, but
run-research picks validation servers from discovery query text, so give every
discovery query content.

## Two Passes

1. Mark exact names, aliases, and broad problem terms as purpose: discovery.
2. Run discovery queries across all joined servers with a small
   options.discoveryMaxPages (usually 1).
3. Extract names, URLs, package identifiers, and repeated vocabulary from strong
   discovery hits. The runner automatically restricts validation queries to
   servers with at least one discovery hit.
4. Mark install, workflow, limitation, demo, and usage terms as
   purpose: validation; run them with the normal options.maxPages.

The single-command runner requires at least one discovery query. Use the
lower-level run-search-plan.mjs command for an intentional validation-only or
unrestricted single pass.

Validation queries that never ran in a server are not evidence of absence there.
The report marks such runs as scoped coverage. If a validation query does not
contain a discovery term, it may still match in skipped servers; promote it to
discovery when its absence matters.

Keep the original query attached to each hit. When two queries find the same
message, merge the message and retain all matched queries.

For ambiguous topics, use filters.requireAll or the --require-all term-a,term-b
flag. The filter applies to message body text after message deduplication, so
coverage statistics can show how many messages were removed without confusing
a partial match with a co-occurrence.

## Ambiguity

Record competing meanings in `ambiguities`. Require co-occurring terms when a
term has common unrelated meanings. If ambiguity remains, report the uncertainty
and do not silently convert a partial match into a finding.
