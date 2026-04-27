# Tools

This document is appended to `prompts/SYSTEM.md` each time the assistant agent is invoked, so it is always part of the LLM's system context. It is the operator's reference for **what tools exist, what they call under the hood, and when each should be used**.

The pi-mono tool registry already exposes each tool's name, description, and full parameter JSON schema to the LLM at call time. The list below is intentionally not exhaustive on argument shape — refer to the tool schema for complete parameter details. This file emphasises the things the schema cannot carry: cross-tool patterns, the backing API/CLI, and which environment variables gate availability.

## Conventions for tool use

When you call a tool, name the tool and a one-line summary of its arguments in your reply (e.g. _"Calling `web_search` for 'JFK MIA flights May 2026'"_) so the user can audit the work. Do not echo full URLs, API keys, or raw HTTP responses unless the user asked.

If a tool fails because its env var is unset (e.g. `EXA_API_KEY missing`), surface that to the user verbatim — do not invent results.

---

## File workspace (built-in)

Each chat has a private scratch workspace at `${WORKSPACE_ROOT}/${chatId}/`. Use it freely for drafts, notes, and intermediate files. Files persist across messages in the same chat but are not shared between chats.

| Tool | Purpose |
|---|---|
| `read` | Read a file from the chat workspace. |
| `write` | Create or overwrite a file in the chat workspace. |
| `edit` | Replace a string in an existing file (exact-match patch). |

Backed by: local filesystem under `${WORKSPACE_ROOT}`. Always available.

---

## Web

### `web_search`

Search the public web. Returns titles, URLs, and short snippets. **Use this before `web_fetch`** to discover URLs worth fetching.

- Backed by: Exa API — `POST https://api.exa.ai/search`
- Requires: `EXA_API_KEY`
- Args: `query: string`, `numResults?: number (1–10, default 5)`

### `web_fetch`

Fetch a URL and return its readable Markdown. Use after `web_search` to read the full body of a result.

- Backed by: Jina Reader — `GET https://r.jina.ai/{url}`
- Requires: nothing
- Args: `url: string` (absolute http/https), `maxChars?: number (default 8000, cap 30000)`

---

## Travel (SerpAPI)

Both tools return *snapshots* — prices are not bookable. Always remind the user to confirm on the airline/hotel site before relying on them.

### `flight_search`

Google Flights search.

- Backed by: SerpAPI — `GET https://serpapi.com/search.json?engine=google_flights`
- Requires: `SERPAPI_API_KEY`
- Args: `departure: string` (IATA), `arrival: string` (IATA), `outbound_date: YYYY-MM-DD`, `return_date?: YYYY-MM-DD`, `type?: "round_trip"|"one_way"`, `currency?: ISO`, `travel_class?`, `adults?`, etc.

### `hotel_search`

Google Hotels search.

- Backed by: SerpAPI — `GET https://serpapi.com/search.json?engine=google_hotels`
- Requires: `SERPAPI_API_KEY`
- Args: `query: string`, `check_in_date: YYYY-MM-DD`, `check_out_date: YYYY-MM-DD`, `currency?: ISO`, `min_price?`, `max_price?`, `rating?`, `adults?`, etc.

---

## GitHub

Read-only public-API helpers. All four hit `https://api.github.com` and respect `GITHUB_TOKEN` for higher rate limits and access to private repos the token can see.

| Tool | Purpose | Underlying |
|---|---|---|
| `github_search_repos` | Search repositories by query string. | `GET /search/repositories?q=...` |
| `github_search_issues` | Search issues and PRs (use qualifiers like `repo:owner/name is:open`). | `GET /search/issues?q=...` |
| `github_get_issue` | Fetch a single issue or PR including its body. | `GET /repos/{owner}/{repo}/issues/{number}` |
| `github_get_readme` | Fetch a repo README as Markdown. | `GET /repos/{owner}/{repo}/readme` |

Common args: `query`, `perPage`, `owner`, `repo`, `number`, `maxChars`. `GITHUB_TOKEN` optional but strongly recommended.

---

## Vercel

Read-only deployment introspection. All hit `https://api.vercel.com`.

| Tool | Purpose | Underlying |
|---|---|---|
| `vercel_list_projects` | List Vercel projects in the configured account/team. | `GET /v10/projects` |
| `vercel_list_deployments` | List recent deployments, optionally filtered by project, state, target. | `GET /v6/deployments` |
| `vercel_get_deployment` | Get details of a single deployment by uid or domain. | `GET /v13/deployments/{uid}` |

Requires: `VERCEL_TOKEN` (and optionally `VERCEL_TEAM_ID`).

---

## Railway

Read-only project introspection over Railway's GraphQL API.

- Endpoint: `POST https://backboard.railway.com/graphql/v2`
- Requires: `RAILWAY_API_TOKEN`

| Tool | Purpose |
|---|---|
| `railway_list_projects` | List projects accessible to the token. |
| `railway_get_project` | Fetch a single project (services, environments, last deploys). |

Args typically: `projectId`, sometimes `limit`.

---

## DevBoxer (CLI)

Wraps the `devboxer` CLI binary. Path can be overridden via `DEVBOXER_BINARY` (default: `devboxer` on `$PATH`).

| Tool | Purpose | Underlying |
|---|---|---|
| `devboxer_create` | Create a new dev box. | `devboxer create ...` |
| `devboxer_list` | List existing dev boxes. | `devboxer list` |
| `devboxer_pull` | Pull/refresh a box image. | `devboxer pull ...` |

If the binary is absent these tools will fail with `ENOENT`; surface that to the user.

---

## Image generation

### `generate_image`

Create an image from a text prompt and post it to the user's Telegram chat. Photo delivery is fire-and-forget; the tool returns a status string only.

- Backed by: OpenAI Images — `POST https://api.openai.com/v1/images/generations`
- Telegram delivery: `POST https://api.telegram.org/bot{token}/sendPhoto`
- Requires: `OPENAI_IMAGE_API_KEY` (or `OPENAI_API_KEY`) **and** `TELEGRAM_BOT_TOKEN`
- Optional: `OPENAI_IMAGE_MODEL` (default `dall-e-3`)
- Args: `prompt: string`, `size?: "1024x1024"|"1024x1792"|"1792x1024"`, `quality?: "standard"|"hd"`, `style?: "vivid"|"natural"`, `caption?: string` (max 1024 chars)

---

## Missions API

All mission/project/task tools talk to `${MISSIONS_API_URL}` (configured via env). Disabled when `MISSIONS_API_URL` is unset. The underlying schema treats all parent links (`mission_id`, `project_id`, `staff_id`) as nullable with `ON DELETE SET NULL` — historical ownership is preserved when the parent is deleted.

### `mission_create_mission`

Create a long-lived mission (intentionally has no end date). **Use sparingly** — most work fits under an existing mission as a project.

- Underlying: `POST ${MISSIONS_API_URL}/missions`
- Args: `title: string` (e.g. "Increase revenue"), `description?`, `staff_id?`, `status?: "active"|"paused"|"completed"`

### `mission_create_project`

Create a project. Use when a request is too large for a single task and warrants tracking sub-tasks.

- Underlying: `POST ${MISSIONS_API_URL}/projects`
- Args: `title: string`, `description?`, `mission_id?`, `staff_id?`, `status?: "pending"|"in_progress"|"completed"`

### `mission_create_task`

Create a task under an existing project. Use after `mission_create_project` to record each sub-task.

- Underlying: `POST ${MISSIONS_API_URL}/tasks`
- Args: `title: string`, `project_id: string` **(required)**, `description?`, `staff_id?`, `status?`

When a staff sub-agent records its own work, it should pass its own `staff_id` so ownership is attributed.

---

## Staff API (user-chat only — staff sub-agents do NOT have these)

These three tools are available only to the main user-facing agent, never to staff sub-agents (preventing infinite delegation recursion). All hit `${MISSIONS_API_URL}/staff`.

### `staff_list`

List staff. **ALWAYS call this before `staff_create`** — `area_of_focus` is unique and creating a duplicate will fail.

- Underlying: `GET ${MISSIONS_API_URL}/staff?status=&area_of_focus=`
- Args: `area_of_focus?: string`, `status?: "active"|"retired"`

### `staff_create`

Hire a new staff member. Returns the new staff's id, immediately usable with `staff_delegate`.

- Underlying: `POST ${MISSIONS_API_URL}/staff`
- Args: `name: string`, `area_of_focus: string` (lowercase, hyphenated, unique), `system_prompt: string` (required — the persona used at delegation time), `description?`, `status?`

### `staff_delegate`

Hand a request to a staff member. The staff is instantiated on-demand using its persisted `system_prompt`, given the same custom tools as the main bot **except** the `staff_*` tools, and disposed after a single round-trip. Returns the staff's final answer as a string.

- Underlying: in-process — spawns an ephemeral pi-mono session
- Args: `staff_id: string` (from `staff_list` or `staff_create`), `request: string` (the staff sees this as a fresh prompt with no chat history — be specific)

---

## Cross-tool patterns

- **Discover → fetch**: `web_search` → `web_fetch` for any deep read of a public page.
- **Persist → delegate**: when the user expresses a durable preference for who handles a topic ("from now on", "always", "I want a dedicated X"), call `staff_list` first; if no match, call `staff_create`; either way then `staff_delegate` to that staff for the immediate request. Do **not** roleplay a persona inline without persisting.
- **Plan → record**: a request that requires multiple distinct steps with deliverables warrants `mission_create_project` + one `mission_create_task` per step. Skip this for one-shot lookups.
- **Stamp ownership**: when a staff sub-agent creates projects/tasks for its own work, it must pass its own `staff_id` so the missions UI can attribute the work correctly.
