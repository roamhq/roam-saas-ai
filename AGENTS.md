# Roam AI Explainability Worker

Cloudflare Worker that answers "why does my page show these listings?" for tourism website managers on the Roam platform. Traces CMS filter chains via Hyperdrive, generates friendly explanations via Workers AI.

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
| `add-tracer` | `/add-tracer` | Guide | Scaffold new tracer domains (page-builder or separate) |
| `db-inspect` | `/db-inspect` | Scripts | Explore DB schema - tables, fields, relations, domains |
| `theme` | `/theme` | Scripts | Twig/Vue from GitHub - view, diff, search across themes |
| `core` | `/core` | Scripts | PHP services/records from GitHub - view, search, extract methods |

### Skill Relationships

```
/theme      Understand what the template renders
    |
    v
/core       Understand what the PHP service does
    |
    v
/db-inspect Understand what the data looks like
    |
    v
/add-tracer Build the tracer with full context
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
    │   └── SKILL.md              # /add-tracer - full tracer build guide
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
            ├── service.sh        # View a PHP service file
            ├── variable.sh       # Extract VariableService methods
            ├── record.sh         # View ActiveRecord models
            ├── twig.sh           # View core Twig templates
            └── search.sh         # Search across PHP/Twig source
```

---

## Skill Details

### add-tracer

Full guide for adding new tracer domains. Covers:
- Page-builder components (add case to `dispatch.ts`)
- Separate domains like ATDW import (new intent domain, new route in `index.ts`)
- Step-by-step: intent parser, query module, tracer, step labels, wiring, types
- File inventory and conventions checklist

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

Explore PHP services, records, VariableService, and core Twig from the `roamhq/roam` repo. Pulls from GitHub via `~/.ssh/github-roamhq`, cached in `/tmp/roam-core/`.

| Script | Usage |
|--------|-------|
| `service.sh <name> [--list]` | View PHP service (e.g., `ATDW/ProductService`) |
| `variable.sh <method> [--list]` | Extract VariableService method |
| `record.sh <name> [--list]` | View ActiveRecord model + table mapping |
| `twig.sh <name> [--list]` | View core Twig templates |
| `search.sh <pattern> [--scope services\|twig\|records]` | Search source |

All scripts support `--branch <branch>` and `--fresh`.

---

## Architecture Quick Reference

```
POST /api/explain  or  /api/explain/stream
  |
  v
Intent Parser (llama 8B) -> domain, page, component, products, question type
  |
  v
resolveData()
  |-- Schema cache (KV per-tenant)
  |-- DB: resolve page blocks (Hyperdrive -> Aurora)
  |-- Trace cache check (KV, 5min TTL)
  |
  v
Tracer Dispatcher (dispatch.ts)
  |-- "products" -> 9-step filter chain (filter-chain.ts)
  |-- other -> generic block inspector (generic.ts)
  |-- future: "atdw_import" -> ATDW tracer (not yet built)
  |
  v
Generator (llama 8B)
  |-- System prompt: friendly colleague, Roam platform, no jargon
  |-- Step labels map: internal names -> human-readable
  |-- Streaming: SSE with metadata event first
  |
  v
Response: { explanation, trace, config, debug: { intent, timing } }
```

### Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AI` | Workers AI | LLM (intent + generation) |
| `DB` | Hyperdrive | MySQL to Aurora (tenant-prefixed) |
| `CACHE` | KV | Schema + trace cache |
| `KNOWLEDGE_BASE` | R2 | Raw source files (CI-pushed) |

### Environments

| Env | Worker Name | Placement |
|-----|-------------|-----------|
| dev | roam-saas-ai-dev | Sydney |
| staging | roam-saas-ai-staging | Sydney |
| production | roam-saas-ai | Sydney |
