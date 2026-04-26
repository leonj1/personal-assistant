# personal-assistant

A Telegram bot that turns any chat into a conversation with an LLM agent that can search the web, fetch pages, edit files in a per-chat scratch workspace, generate images, query GitHub/Vercel/Railway, look up flights and hotels, and dispatch DevBoxer tasks.

Built on [pi-mono](https://github.com/badlogic/pi-mono) (LLM agent runtime) with one `AgentSession` per Telegram chat. Provider-agnostic: works with Anthropic, OpenAI, Google, OpenRouter, Requesty, and any OpenAI-compatible gateway (LiteLLM, vLLM, LM Studio, Ollama).

## Quick start (3 minutes)

**Prereqs:** Docker, a Telegram bot token from [@BotFather](https://t.me/BotFather), and one LLM provider API key.

```bash
git clone <this-repo> && cd personal-assistant
cp .env.example .env
# edit .env: set TELEGRAM_BOT_TOKEN and your LLM_PROVIDER + LLM_MODEL + matching API key
make start
```

Open Telegram, message your bot, get a reply. That's it.

Logs: `docker logs -f myclaw-app`. Stop: `make stop`.

### Without Docker

```bash
npm ci
npm run build
node dist/index.js
```

## Configuration

Everything is env-vars in `.env` (see `.env.example` for the full list). The minimum:

```env
TELEGRAM_BOT_TOKEN=123456:your-bot-token
LLM_PROVIDER=anthropic
LLM_MODEL=claude-3-5-sonnet-20241022
ANTHROPIC_API_KEY=sk-ant-...
```

Switch providers by changing those three values. For an OpenAI-compatible gateway (Requesty, LiteLLM, ...) also set `LLM_BASE_URL` and `LLM_API_KEY`.

The bot's persona lives in `prompts/SYSTEM.md` — edit that file (no rebuild needed if you mount it as a volume) and restart.

## Tools

Each tool auto-enables when its prerequisite env var is set; otherwise it's silently omitted from the LLM's tool list.

| Tool | Enables when |
|---|---|
| `web_search` (Exa) | `EXA_API_KEY` |
| `web_fetch` (Jina Reader, Markdown) | always |
| `read` / `write` / `edit` (per-chat scratch workspace) | always |
| `generate_image` (OpenAI → Telegram `sendPhoto`) | `OPENAI_API_KEY` or `OPENAI_IMAGE_API_KEY` |
| `github_search_repos` / `_search_issues` / `_get_issue` / `_get_readme` | always (`GITHUB_TOKEN` raises rate limits) |
| `vercel_list_projects` / `_get_deployments` | `VERCEL_TOKEN` |
| `railway_list_projects` / `_get_project` | `RAILWAY_API_TOKEN` |
| `flight_search` / `hotel_search` (SerpAPI Google Flights/Hotels) | `SERPAPI_API_KEY` |
| `devboxer_create` / `_list` / `_pull` | `devboxer` CLI on `PATH` |

`bash`, `grep`, `find`, `ls` are intentionally **disabled** — only `read`/`write`/`edit` from pi-mono's built-ins, scoped to `data/workspaces/<chatId>/` so chats can't see each other's files.

## What the startup logs tell you

```
System prompt loaded from /app/prompts/SYSTEM.md (250 chars).
pi-mono ready (provider=anthropic, model=claude-3-5-sonnet-20241022)
pi-mono custom tools enabled: web_fetch, github_search_repos, ...
[pi:<chatId>] session ready, active tools (N): read, write, edit, web_fetch, ...
```

The first `pi-mono custom tools enabled` line lists what was registered globally; the per-session `active tools` line is the **actual** list reaching the LLM (these used to differ — see `cdcceaf`).

## Make targets

| Target | What it does |
|---|---|
| `make build` | `tsc` → `dist/` (installs deps if needed) |
| `make image` | `docker build -t myclaw:local .` |
| `make start` | builds image and runs container `myclaw-app` on port 3213 |
| `make stop` / `make restart` | obvious |
| `make clean` | removes `dist/` |

## Caveats

- **Multi-tenant safety.** The bot has `read`/`write`/`edit` tools and APIs to GitHub, Vercel, Railway, OpenAI, etc. Anyone who can DM the bot can use them under your tokens. Add a `chatId` allowlist before exposing publicly.
- **Cost ceiling.** Each Telegram message can fan out into several LLM calls plus tool calls. There's no per-chat budget; rate-limit before opening it up.
- **Inline queries** still return a static article — they're handled outside the agent path because the latency budget is too tight for an LLM round-trip.
- **DevBoxer auth** (`devboxer auth`) is browser-based; in Docker, install the CLI in your image and mount the operator's `~/.devboxer` as a volume.
- **`prompts/SYSTEM.md` is required.** The bot exits 1 if it's missing or empty — by design, so misconfiguration is loud.

## License

MIT.
