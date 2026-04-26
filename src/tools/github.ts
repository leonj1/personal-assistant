import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const GITHUB_API = "https://api.github.com";

function buildHeaders(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "myclaw-bot"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function githubGet<T>(
  path: string,
  token: string | undefined,
  signal: AbortSignal | undefined
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: "GET",
    headers: buildHeaders(token),
    signal
  });
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`GitHub ${path} failed: ${response.status} ${body.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

// ----- search_repos -----

const searchReposParams = Type.Object({
  query: Type.String({
    description:
      "GitHub repository search query. Supports qualifiers like 'language:rust stars:>1000'."
  }),
  perPage: Type.Optional(
    Type.Integer({ description: "Results per page (1-20).", minimum: 1, maximum: 20 })
  )
});

type RepoSearchResult = {
  items?: Array<{
    full_name?: string;
    html_url?: string;
    description?: string | null;
    stargazers_count?: number;
    language?: string | null;
    updated_at?: string;
  }>;
  total_count?: number;
};

function buildSearchReposTool(token: string | undefined): ToolDefinition {
  return defineTool({
    name: "github_search_repos",
    label: "GitHub: search repositories",
    description:
      "Search GitHub for repositories. Returns full_name, URL, description, stars, language, updated_at.",
    promptSnippet: "github_search_repos: search GitHub repos. Args: query, perPage (default 10).",
    parameters: searchReposParams,
    async execute(_id, params: Static<typeof searchReposParams>, signal) {
      const perPage = params.perPage ?? 10;
      const url = `/search/repositories?q=${encodeURIComponent(params.query)}&per_page=${perPage}`;
      const data = await githubGet<RepoSearchResult>(url, token, signal);
      const items = data.items ?? [];
      const text = items.length
        ? items
            .map((r, i) => {
              const stars = r.stargazers_count ?? 0;
              const lang = r.language ? ` [${r.language}]` : "";
              const desc = (r.description ?? "").trim().slice(0, 200);
              return `${i + 1}. ${r.full_name} (${stars}★)${lang}\n${r.html_url}\n${desc}`;
            })
            .join("\n\n")
        : `No repositories found for "${params.query}".`;
      return {
        content: [{ type: "text", text }],
        details: { totalCount: data.total_count ?? 0, returned: items.length }
      };
    }
  });
}

// ----- search_issues -----

const searchIssuesParams = Type.Object({
  query: Type.String({
    description:
      "GitHub issue search query. Use qualifiers like 'repo:owner/name is:open is:issue label:bug'."
  }),
  perPage: Type.Optional(
    Type.Integer({ description: "Results per page (1-20).", minimum: 1, maximum: 20 })
  )
});

type IssueSearchResult = {
  items?: Array<{
    title?: string;
    html_url?: string;
    state?: string;
    user?: { login?: string };
    pull_request?: unknown;
    number?: number;
    repository_url?: string;
    updated_at?: string;
  }>;
  total_count?: number;
};

function buildSearchIssuesTool(token: string | undefined): ToolDefinition {
  return defineTool({
    name: "github_search_issues",
    label: "GitHub: search issues and PRs",
    description:
      "Search GitHub issues and pull requests. Returns title, URL, state, author, kind (issue|pr).",
    promptSnippet:
      "github_search_issues: search GitHub issues/PRs. Args: query (use qualifiers), perPage (default 10).",
    parameters: searchIssuesParams,
    async execute(_id, params: Static<typeof searchIssuesParams>, signal) {
      const perPage = params.perPage ?? 10;
      const url = `/search/issues?q=${encodeURIComponent(params.query)}&per_page=${perPage}`;
      const data = await githubGet<IssueSearchResult>(url, token, signal);
      const items = data.items ?? [];
      const text = items.length
        ? items
            .map((it, i) => {
              const kind = it.pull_request ? "pr" : "issue";
              const author = it.user?.login ?? "?";
              return `${i + 1}. [${kind}/${it.state}] ${it.title} by @${author}\n${it.html_url}`;
            })
            .join("\n\n")
        : `No issues found for "${params.query}".`;
      return {
        content: [{ type: "text", text }],
        details: { totalCount: data.total_count ?? 0, returned: items.length }
      };
    }
  });
}

// ----- get_issue -----

const getIssueParams = Type.Object({
  owner: Type.String({ description: "Repository owner (user or org)." }),
  repo: Type.String({ description: "Repository name." }),
  number: Type.Integer({ description: "Issue or PR number.", minimum: 1 })
});

type IssueDetail = {
  title?: string;
  state?: string;
  body?: string | null;
  html_url?: string;
  user?: { login?: string };
  labels?: Array<{ name?: string } | string>;
  pull_request?: unknown;
  created_at?: string;
  updated_at?: string;
};

function buildGetIssueTool(token: string | undefined): ToolDefinition {
  return defineTool({
    name: "github_get_issue",
    label: "GitHub: get issue or PR",
    description: "Fetch a GitHub issue or pull request by repo + number, including its body.",
    promptSnippet: "github_get_issue: get an issue/PR by owner/repo/number.",
    parameters: getIssueParams,
    async execute(_id, params: Static<typeof getIssueParams>, signal) {
      const url = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.number}`;
      const data = await githubGet<IssueDetail>(url, token, signal);
      const kind = data.pull_request ? "Pull request" : "Issue";
      const labels = (data.labels ?? [])
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
        .filter(Boolean)
        .join(", ");
      const body = (data.body ?? "").trim().slice(0, 6000);
      const text =
        `${kind} #${params.number}: ${data.title ?? "(untitled)"}\n` +
        `State: ${data.state ?? "?"}  Author: @${data.user?.login ?? "?"}` +
        (labels ? `  Labels: ${labels}` : "") +
        `\n${data.html_url ?? ""}\n\n${body || "(no body)"}`;
      return {
        content: [{ type: "text", text }],
        details: { kind, state: data.state, url: data.html_url }
      };
    }
  });
}

// ----- get_readme -----

const getReadmeParams = Type.Object({
  owner: Type.String({ description: "Repository owner (user or org)." }),
  repo: Type.String({ description: "Repository name." }),
  maxChars: Type.Optional(
    Type.Integer({
      description: "Maximum body characters to return (default 8000, hard cap 30000).",
      minimum: 200,
      maximum: 30000
    })
  )
});

type ReadmeResponse = { content?: string; encoding?: string; html_url?: string };

function buildGetReadmeTool(token: string | undefined): ToolDefinition {
  return defineTool({
    name: "github_get_readme",
    label: "GitHub: get README",
    description: "Fetch the README of a GitHub repository as Markdown text.",
    promptSnippet: "github_get_readme: get a repo README as text. Args: owner, repo, maxChars.",
    parameters: getReadmeParams,
    async execute(_id, params: Static<typeof getReadmeParams>, signal) {
      const maxChars = params.maxChars ?? 8000;
      const url = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/readme`;
      const data = await githubGet<ReadmeResponse>(url, token, signal);
      let body = "";
      if (data.encoding === "base64" && data.content) {
        body = Buffer.from(data.content, "base64").toString("utf-8");
      } else if (data.content) {
        body = data.content;
      }
      const truncated = body.length > maxChars;
      if (truncated) {
        body = `${body.slice(0, maxChars)}\n\n[... truncated, ${body.length - maxChars} more chars ...]`;
      }
      return {
        content: [{ type: "text", text: body || "(empty README)" }],
        details: { url: data.html_url, bytes: body.length, truncated }
      };
    }
  });
}

/**
 * Read-only GitHub tools. GITHUB_TOKEN is optional but strongly recommended -
 * unauthenticated requests are limited to 60/hour for public endpoints and
 * 10/minute for search.
 */
export function createGithubTools(): ToolDefinition[] {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    console.log("GITHUB_TOKEN not set; GitHub tools will run unauthenticated (low rate limits).");
  }
  return [
    buildSearchReposTool(token),
    buildSearchIssuesTool(token),
    buildGetIssueTool(token),
    buildGetReadmeTool(token)
  ];
}
