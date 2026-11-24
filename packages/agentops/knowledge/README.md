---
description: "The AgentOps knowledge base: LLM Wiki drafts, publication, versions, BM25 retrieval, memory projection, and model tools."
kind: "package-reference"
---

# @agentops/dsh-knowledge

English | [中文](README.zh.md)

## Summary

This package closes the LLM Wiki chain: task reports enter a durable draft box, deterministic checks surface duplicates, sensitive values and related pages, and released pages become versioned searchable documents. Agents file pages into an automatically maintained one- or two-segment category tree inside a fixed business-domain knowledge space, and create a directory only when no existing path matches. The same pages feed memory-nebula projections and model retrieval. Visibility remains closed by default: an empty `readableSpaces` returns no search results; when enabled, shared runtime domains join the configured grants.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use it to serve document retrieval and LLM Wiki maintenance. Curated space content still lives in [`../knowledge-base/`](../knowledge-base/GUIDE.md), which defines ten macro knowledge domains. Finance, HR, operations, project analysis, and review are flat; the other domains use stable document-type categories. Drafts without an explicit target are routed automatically, while uncertain material goes to review. Publishing a draft writes Markdown into the selected space, where `knowledge_search`, smart-query agents, and the memory nebula read the same versioned material. Agents can search knowledge and, where a preset allows it, list maintained categories, create checked Wiki drafts, re-run checks, and publish a ready draft into an existing space and category; they never create top-level knowledge spaces.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `src/store.ts` | Spaces, versions, chunks, and the retrieval index |
| `src/corpus.ts` | Space-directory loading and content-hash sync |
| `src/http.ts` | Routes with the `readableSpaces` filter |
| `src/wiki.ts` | Page types, schema, draft analysis and Markdown publication |
| `src/wiki-service.ts` | Draft checks, category maintenance, publication, operation log and memory projection |
| `src/tools.ts` | Model-facing search, import-plan and Wiki tools |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../vault/`](../vault/README.md) — credential storage for the same profile

-----

<a id="model-experience"></a>
## Model Experience

None, as this package indexes and retrieves documents; the search tool output is a tool result rather than model input construction.

#### KV Cache effect

None; this package neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Empty visibility means empty results** — a deployment that forgets `readableSpaces` gets a working but silent knowledge base.
- **Semantic contradictions need review** — deterministic checks catch structure, hashes, secrets and related pages; the agent must still judge semantic disagreement.
- **Publication is explicit** — a draft can be checked automatically, but publishing needs a selected target space or an enabled model tool call.
- **Automatic categories start unreviewed** — Agents may create a new category when no existing path matches; a reviewer confirms it later.
- **BM25 only** — there is no embedding or hybrid ranking path.
- **A corpus sync needs a restart** — writing the database from another process is safe, but the running host serves its in-memory index until it restarts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
