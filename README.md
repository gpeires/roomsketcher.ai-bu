# RoomSketcher Help MCP

An MCP server on Cloudflare Workers that gives AI agents two capabilities:

1. **Help documentation** — search and browse RoomSketcher's Zendesk knowledge base
2. **Floor plan sketcher** — generate, edit, and export 2D floor plans from natural language

Users describe rooms to Claude, get an interactive browser sketcher with real-time sync, and download SVG exports.

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> && cd roomsketcher-help-mcp
npm install

# 2. Configure
cp .env.example .env
# Fill in CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID

# 3. Deploy
./deploy.sh
```

The deploy script handles D1 database creation, schema migration, worker deployment, and initial Zendesk sync.

## MCP Tools

### Help (6 tools)
| Tool | Description |
|------|-------------|
| `search_articles` | Full-text search across help articles |
| `list_categories` | Browse top-level categories |
| `list_sections` | Sections within a category |
| `list_articles` | Articles within a section |
| `get_article` | Full article by ID |
| `get_article_by_url` | Full article by URL |

### Sketcher (6 tools)
| Tool | Description |
|------|-------------|
| `generate_floor_plan` | Create a floor plan from JSON |
| `get_sketch` | Get plan summary |
| `open_sketcher` | Get browser sketcher URL |
| `update_sketch` | Apply changes + sync to browsers |
| `suggest_improvements` | AI analysis prompts |
| `export_sketch` | SVG download link |

## How It Works

1. **Claude** receives a room description and constructs a `FloorPlan` JSON
2. **`generate_floor_plan`** validates, renders SVG, stores in D1, returns a sketcher URL
3. **Browser sketcher** loads the plan, connects via WebSocket for live sync
4. **User edits** (draw walls, add doors/windows) sync back instantly
5. **Claude** can push updates via `update_sketch` — browser reflects them in real-time
6. **SVG export** downloads the finished plan

## Endpoints

| Route | Purpose |
|-------|---------|
| `/mcp` | MCP protocol |
| `/sketcher/:id` | Browser sketcher SPA |
| `/api/sketches/:id` | REST API (GET/PUT) |
| `/ws/:id` | WebSocket sync |
| `/health` | Health check |
| `/admin/sync` | Trigger Zendesk sync |

## Development

```bash
# Local dev server
npx wrangler dev

# Run tests
npm test

# Type check
npx tsc --noEmit
```

## Architecture

For agents and contributors: see **[docs/arch/main/ARCH.md](docs/arch/main/ARCH.md)** for the full architecture — data model, Durable Object design, request flows, SVG rendering pipeline, WebSocket protocol, and planned future work.

New major features get their own `docs/arch/<feature>/ARCH.md`.

## Tech Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **Database:** Cloudflare D1 (SQLite) with FTS5
- **MCP:** `@modelcontextprotocol/sdk` + `agents` (McpAgent)
- **Validation:** Zod
- **Testing:** Vitest
- **Frontend:** Single-file HTML SPA (no build step)

## Code Style

Configured via `.prettierrc`: 4-space indent, no semicolons, trailing commas.
