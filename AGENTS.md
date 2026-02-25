# Roam AI Explainability Worker

Cloudflare Worker that answers "why does my page show these listings?" for tourism website managers on the Roam platform. Combines **data collection** (DB queries via Hyperdrive) with **code understanding** (AutoRAG over indexed PHP/Twig) to produce client-friendly explanations via Workers AI.

## Design Principles

1. **Data collection is the worker's job** - query the live DB for actual state (product records, postcodes, regions, entry status). AutoRAG can't do this.
2. **Code understanding is AutoRAG's job** - retrieve relevant PHP/Twig source that explains the system's behaviour. Don't replicate PHP logic in TypeScript.
3. **Synthesis is the LLM's job** - combine data facts + code context into a warm, jargon-free explanation. No PHP references, no technical terms, just plain English.
4. **Tracers are data collectors, not logic replicators** - they gather structured facts from the DB. The LLM interprets what those facts mean using the retrieved code context.

## Paths

| What | Path |
|------|------|
| **Project root** | `~/roam-eco.nosync/roam-saas-ai/` |
| **Skills** | `.claude/skills/` |
| **Scripts** | `.claude/skills/{skill-name}/scripts/` |
| **Core repo** | `github.com:roamhq/roam` (SSH key: `~/.ssh/github-roamhq`) |
| **Theme repos** | `github.com:roamhq/theme-{handle}` |
| **Local DB** | `ddev mysql` in `/Users/rombot/www/roam` (user: db, pass: db) |

---

## Skills

| Skill | Invoke | Type | Purpose |
|-------|--------|------|---------|
| `add-tracer` | `/add-tracer` | Guide | Scaffold new data-collection tracers |
| `db-inspect` | `/db-inspect` | Scripts | Explore DB schema - tables, fields, relations, domains |
| `theme` | `/theme` | Scripts | Twig/Vue from GitHub - view, diff, search across themes |
| `core` | `/core` | Scripts | PHP from GitHub - trace call stacks, view services, search |

### Skill Relationships

```
/core       Understand the PHP call stack (also feeds R2 knowledge base)
    |
    v
/theme      Understand what the template renders (also feeds R2 knowledge base)
    |
    v
/db-inspect Understand what the data looks like (informs data-collection queries)
    |
    v
/add-tracer Build the data collector (thin DB queries, no PHP logic)
```

---

## Structure

```
.claude/
├── rules/
│   └── cli-tools.md
├── agents/
│   ├── cloudflare-expert.md
│   └── typescript-expert.md
└── skills/
    ├── tracer-skill/
    │   └── SKILL.md              # /add-tracer - data collector build guide
    ├── db-inspect-skill/
    │   ├── SKILL.md              # /db-inspect
    │   └── scripts/
    │       ├── tables.sh         # List tables by pattern
    │       ├── describe.sh       # Table schema + sample rows
    │       ├── fields.sh         # Craft fields by context/handle/group
    │       ├── element.sh        # Element lookup by ID/URI/search
    │       ├── relations.sh      # craft_relations graph for an element
    │       └── domain.sh         # Map feature area to tables/fields
    ├── theme-skill/
    │   ├── SKILL.md              # /theme
    │   └── scripts/
    │       ├── fetch-theme.sh    # Sparse checkout from GitHub (internal)
    │       ├── list-components.sh # List components in a theme
    │       ├── component.sh      # View a component's template/Vue
    │       ├── diff-component.sh # Compare between two themes
    │       └── search.sh         # Search across templates
    └── core-skill/
        ├── SKILL.md              # /core
        └── scripts/
            ├── fetch-core.sh     # Sparse checkout from GitHub (internal)
            ├── trace.sh          # Trace full call stacks across PHP files
            ├── service.sh        # View a PHP service file
            ├── variable.sh       # Extract VariableService methods
            ├── record.sh         # View ActiveRecord models
            ├── twig.sh           # View core Twig templates
            └── search.sh         # Search across PHP/Twig source
```

---

## Skill Details

### add-tracer

Guide for adding new data-collection tracers. Covers:
- Page-builder components (add case to `dispatch.ts`)
- Separate domains like ATDW import (new intent domain, new route in `index.ts`)
- Focus on DB queries that collect facts - AutoRAG handles code interpretation
- Conventions: thin tracers, structured data, no PHP logic replication

### db-inspect

Explore database structure via `ddev mysql` against local Craft CMS instance.

| Script | Usage |
|--------|-------|
| `domain.sh <name>` | Map a feature area to its tables, fields, categories, sections |
| `tables.sh [pattern]` | List tables (e.g., `roam_%`, `craft_matrix%`) |
| `describe.sh <table> [--sample N]` | Columns, types, indexes, sample rows |
| `fields.sh [--context X] [--handle Y]` | Craft fields filtered by context or handle |
| `element.sh <id>` or `--uri` or `--search` | Element lookup |
| `relations.sh <id> [--direction both]` | craft_relations inbound/outbound |

### theme

Explore Twig templates and Vue components across 18 theme repos. Pulls fresh from GitHub via sparse checkout, cached in `/tmp/roam-themes/`.

| Script | Usage |
|--------|-------|
| `list-components.sh [--theme X] [--all-themes]` | List components |
| `component.sh <name> [--theme X] [--all-themes]` | View template |
| `diff-component.sh <name> <theme1> <theme2>` | Diff between themes |
| `search.sh <pattern> [--theme X] [--type twig\|vue\|js]` | Search templates |

All scripts support `--branch <branch>` and `--fresh` to re-pull.

### core

Explore PHP services, records, VariableService, and core Twig from the `roamhq/roam` repo. Trace full call stacks across files. Pulls from GitHub via `~/.ssh/github-roamhq`, cached in `/tmp/roam-core/`.

| Script | Usage |
|--------|-------|
| `trace.sh <stack> [--list]` | **Trace full call stacks** (e.g., `atdw-import`, `page-products`) |
| `trace.sh --from "Class::method"` | Auto-trace from any method (follows references 3 levels deep) |
| `service.sh <name> [--list]` | View PHP service (e.g., `ATDW/ProductService`) |
| `variable.sh <method> [--list]` | Extract VariableService method |
| `record.sh <name> [--list]` | View ActiveRecord model + table mapping |
| `twig.sh <name> [--list]` | View core Twig templates |
| `search.sh <pattern> [--scope services\|twig\|records]` | Search source |

All scripts support `--branch <branch>` and `--fresh`.

Scopes pulled: services, helpers, models, formatters, records, providers, controllers, app.

---

## Architecture

### Three-Layer Design

```
Client question: "Why isn't Mildura Grand Hotel on my website?"
  |
  v
[1] AutoRAG retrieval (code understanding)
  |  env.AI.autorag("roam-ai").search(question)
  |  -> retrieves relevant PHP/Twig source from R2
  |  -> "here's how ProductService::createRecord() decides imports"
  |
  v
[2] Data collection (thin DB queries via Hyperdrive)
  |  -> raw facts: ATDW record, postcode, regions, entry state
  |  -> structured as DataSnapshot, NOT interpreted
  |
  v
[3] Workers AI synthesis (LLM generation)
  |  -> system prompt: friendly colleague, Roam platform, no jargon
  |  -> input: code context (from AutoRAG) + data facts (from DB)
  |  -> output: client-friendly explanation
  |
  v
"The Mildura Grand Hotel is in postcode 3500. Your site imports
 products from the Yarra Valley region, which covers different
 postcodes. That's why it hasn't appeared on your website."
```

### Request Flow

```
POST /api/explain  or  /api/explain/stream
  |
  v
Intent Parser (llama 8B)
  |-- Detects: domain, page, component, products, question type
  |-- Lightweight classification only - AutoRAG retrieval is domain-aware
  |
  v
resolveData()
  |-- AutoRAG: retrieve relevant PHP/Twig code context
  |-- DB: collect raw facts (data snapshot, not logic trace)
  |-- Cache: KV per-tenant, 5min TTL
  |
  v
Domain Router
  |-- page_component:
  |   |-- "products" -> product data collector (filter-chain.ts)
  |   |-- other -> generic block inspector (generic.ts)
  |-- atdw_import -> ATDW data collector (atdw.ts)
  |
  v
Generator (llama 8B)
  |-- Combines: code context + data snapshot
  |-- Streaming: SSE with metadata event first
  |
  v
Response: { explanation, trace, config, debug: { intent, timing } }
```

### R2 Knowledge Base (AutoRAG)

PHP and Twig files are indexed in R2 and searched via Cloudflare AI Search (AutoRAG).

| Source | Pushed by | Contents |
|--------|-----------|----------|
| Core PHP | `roamhq/roam` deployment.yml | services/**/*, helpers/, formatters/, models/, records/ |
| Theme templates | `push-knowledge.yml` (per theme) | Twig components, Vue files, JS |

AutoRAG provides semantic search over this indexed codebase. The worker uses `autorag.search()` (retrieval only) to get relevant source chunks, then feeds them to the LLM alongside data facts.

### Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AI` | Workers AI | LLM (intent + generation) + AutoRAG (code retrieval) |
| `DB` | Hyperdrive | MySQL to Aurora (tenant-prefixed) |
| `CACHE` | KV | Schema + trace cache |
| `ORIGINS` | KV | Hostname -> tenant mapping |
| `KNOWLEDGE_BASE` | R2 | PHP + Twig source (indexed by AutoRAG) |

### Environments

| Env | Worker Name | Placement |
|-----|-------------|-----------|
| dev | roam-saas-ai-dev | Sydney |
| staging | roam-saas-ai-staging | Sydney |
| production | roam-saas-ai | Sydney |
