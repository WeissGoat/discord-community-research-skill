# Evidence Rubric

Grades measure the strength of evidence visible in Discord messages. They are
not external validation and are not a ranking of project quality.

| Grade | Meaning | Typical content |
| --- | --- | --- |
| E0 | Mention | Name-only, link-only, or too little context to interpret |
| E1 | Discussion | Question, opinion, general discussion, or recommendation |
| E2 | Technical | Setup, parameters, workflow, code, limitations, errors, or fixes |
| E3 | Demonstrated | Concrete result, demo, screenshot, attachment, or output |
| E4 | Repeated use | Explicit repeated-use or production language together with technical or demonstrated detail |

Grades describe the message itself. Term matching covers English, Chinese
(simplified and traditional), and common Japanese terms. A message counts as
link-only when its text outside URLs is shorter than 12 letters or digits, with
each CJK character counting as two.

Ordering signals include recency, technical density, distinct authors, distinct
servers/channels, reply and thread context, reactions fetched during enrichment,
and query agreement. Link-only and repeated content are penalties. Signals help
triage; they do not establish correctness, safety, popularity, or maintainership.

## Verification Status

- project-linked: the message includes a link to a recognizable project host
  such as GitHub, GitLab, Gitee, npm, PyPI, or Hugging Face.
- unverified-claim: the message makes an official or official-sounding claim
  without a recognizable project link.
- community-only: useful Discord evidence without either status above.

These statuses describe what the message contains. They do not validate the
project or prove that an official relationship exists.

## Reporting Language

- Complete, empty coverage: `No relevant results were observed in the completed Discord coverage.`
- Scoped coverage (validation queries skipped where discovery found nothing): `Relevant results were not observed for the executed queries.` Name the skipped queries and servers.
- Incomplete coverage: `Relevant results were not observed within the completed coverage.`
- Missing access: state the server and request status.
- Truncated search: state the fetched count, reported total, and limit.
- Partial search: state the reason (Discord still indexing the server, or fewer messages returned than reported).
- Aborted run: state the reason and how many tasks are still pending.

Every key finding should cite a Discord jump URL. Do not use attachment CDN URLs
as durable citations, and do not imply that external validation occurred unless it
was explicitly enabled and reported in a separate section.
