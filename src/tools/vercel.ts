import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const VERCEL_API = "https://api.vercel.com";

function buildHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function vercelGet<T>(
  path: string,
  token: string,
  teamId: string | undefined,
  signal: AbortSignal | undefined
): Promise<T> {
  const url = new URL(`${VERCEL_API}${path}`);
  if (teamId && !url.searchParams.has("teamId")) {
    url.searchParams.set("teamId", teamId);
  }
  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(token),
    signal
  });
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Vercel ${path} failed: ${response.status} ${body.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

// ----- list_projects -----

const listProjectsParams = Type.Object({
  search: Type.Optional(
    Type.String({ description: "Filter projects whose name contains this substring." })
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max projects to return (1-50).", minimum: 1, maximum: 50 })
  )
});

type VercelProjectsResponse = {
  projects?: Array<{
    id?: string;
    name?: string;
    framework?: string | null;
    accountId?: string;
    updatedAt?: number;
    link?: { type?: string; repo?: string };
    targets?: { production?: { alias?: string[] } };
  }>;
};

function buildListProjectsTool(token: string, teamId: string | undefined): ToolDefinition {
  return defineTool({
    name: "vercel_list_projects",
    label: "Vercel: list projects",
    description: "List Vercel projects in the configured account/team. Read-only.",
    promptSnippet: "vercel_list_projects: list Vercel projects. Args: search, limit (default 20).",
    parameters: listProjectsParams,
    async execute(_id, params: Static<typeof listProjectsParams>, signal) {
      const limit = params.limit ?? 20;
      const search = params.search ? `&search=${encodeURIComponent(params.search)}` : "";
      const data = await vercelGet<VercelProjectsResponse>(
        `/v9/projects?limit=${limit}${search}`,
        token,
        teamId,
        signal
      );
      const projects = data.projects ?? [];
      const text = projects.length
        ? projects
            .map((p, i) => {
              const repo = p.link?.repo ? ` repo=${p.link.repo}` : "";
              const fw = p.framework ? ` framework=${p.framework}` : "";
              const aliases = p.targets?.production?.alias?.slice(0, 2).join(", ") ?? "";
              return `${i + 1}. ${p.name} (id=${p.id})${fw}${repo}` +
                (aliases ? `\n   prod: ${aliases}` : "");
            })
            .join("\n")
        : "No projects.";
      return {
        content: [{ type: "text", text }],
        details: { count: projects.length }
      };
    }
  });
}

// ----- list_deployments -----

const listDeploymentsParams = Type.Object({
  projectId: Type.Optional(
    Type.String({ description: "Vercel project id. Omit to see deployments across all projects." })
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max deployments to return (1-50).", minimum: 1, maximum: 50 })
  ),
  state: Type.Optional(
    Type.String({
      description:
        "Filter by state. Comma-separated. Values: BUILDING, ERROR, INITIALIZING, QUEUED, READY, CANCELED."
    })
  ),
  target: Type.Optional(
    Type.Union([Type.Literal("production"), Type.Literal("preview")], {
      description: "Filter by deployment target."
    })
  )
});

type VercelDeploymentsResponse = {
  deployments?: Array<{
    uid?: string;
    name?: string;
    url?: string;
    state?: string;
    target?: string | null;
    created?: number;
    creator?: { username?: string };
    meta?: { githubCommitMessage?: string; githubCommitSha?: string };
  }>;
};

function buildListDeploymentsTool(token: string, teamId: string | undefined): ToolDefinition {
  return defineTool({
    name: "vercel_list_deployments",
    label: "Vercel: list deployments",
    description:
      "List recent Vercel deployments, optionally filtered by project, state, or target. Read-only.",
    promptSnippet:
      "vercel_list_deployments: list deployments. Args: projectId, limit, state, target.",
    parameters: listDeploymentsParams,
    async execute(_id, params: Static<typeof listDeploymentsParams>, signal) {
      const qs = new URLSearchParams({ limit: String(params.limit ?? 20) });
      if (params.projectId) qs.set("projectId", params.projectId);
      if (params.state) qs.set("state", params.state);
      if (params.target) qs.set("target", params.target);
      const data = await vercelGet<VercelDeploymentsResponse>(
        `/v6/deployments?${qs.toString()}`,
        token,
        teamId,
        signal
      );
      const deployments = data.deployments ?? [];
      const text = deployments.length
        ? deployments
            .map((d, i) => {
              const when = d.created ? new Date(d.created).toISOString() : "?";
              const author = d.creator?.username ? ` by @${d.creator.username}` : "";
              const sha = d.meta?.githubCommitSha?.slice(0, 7);
              const commit = d.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 80) ?? "";
              const commitLine = sha ? `\n   ${sha} ${commit}` : commit ? `\n   ${commit}` : "";
              return `${i + 1}. [${d.state}] ${d.target ?? "?"} ${d.url ?? "?"} (${when})${author}${commitLine}\n   uid=${d.uid}`;
            })
            .join("\n\n")
        : "No deployments.";
      return {
        content: [{ type: "text", text }],
        details: { count: deployments.length }
      };
    }
  });
}

// ----- get_deployment -----

const getDeploymentParams = Type.Object({
  uid: Type.String({ description: "Deployment id (e.g. 'dpl_xxx') or domain." })
});

type VercelDeployment = {
  uid?: string;
  name?: string;
  url?: string;
  state?: string;
  target?: string | null;
  createdAt?: number;
  buildingAt?: number;
  ready?: number;
  errorMessage?: string;
  meta?: Record<string, string>;
  alias?: string[];
};

function buildGetDeploymentTool(token: string, teamId: string | undefined): ToolDefinition {
  return defineTool({
    name: "vercel_get_deployment",
    label: "Vercel: get deployment",
    description:
      "Get details of a single Vercel deployment by uid or domain. Includes state, target, timestamps, build error message if any.",
    promptSnippet: "vercel_get_deployment: get one deployment by uid.",
    parameters: getDeploymentParams,
    async execute(_id, params: Static<typeof getDeploymentParams>, signal) {
      const data = await vercelGet<VercelDeployment>(
        `/v13/deployments/${encodeURIComponent(params.uid)}`,
        token,
        teamId,
        signal
      );
      const lines = [
        `${data.name ?? "(unnamed)"}  state=${data.state ?? "?"}  target=${data.target ?? "?"}`,
        `uid=${data.uid ?? params.uid}`,
        data.url ? `url=https://${data.url}` : "",
        data.alias?.length ? `alias=${data.alias.slice(0, 3).join(", ")}` : "",
        data.createdAt ? `created=${new Date(data.createdAt).toISOString()}` : "",
        data.ready ? `ready=${new Date(data.ready).toISOString()}` : "",
        data.errorMessage ? `\nerror: ${data.errorMessage}` : ""
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          uid: data.uid,
          state: data.state,
          target: data.target,
          ready: data.ready,
          errorMessage: data.errorMessage
        }
      };
    }
  });
}

/**
 * Read-only Vercel tools. Requires VERCEL_TOKEN. VERCEL_TEAM_ID is optional and
 * scopes every request to a specific team account.
 */
export function createVercelTools(): ToolDefinition[] {
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) {
    return [];
  }
  const teamId = process.env.VERCEL_TEAM_ID?.trim() || undefined;
  return [
    buildListProjectsTool(token, teamId),
    buildListDeploymentsTool(token, teamId),
    buildGetDeploymentTool(token, teamId)
  ];
}
