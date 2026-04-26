import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

async function railwayQuery<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<T> {
  const response = await fetch(RAILWAY_GRAPHQL, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Railway HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`Railway GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("Railway returned an empty data field.");
  }
  return json.data;
}

// ----- list_projects -----

const listProjectsParams = Type.Object({});

type Edge<T> = { node?: T };
type Page<T> = { edges?: Edge<T>[] };

type ListProjectsResult = {
  me?: {
    projects?: Page<{
      id?: string;
      name?: string;
      description?: string | null;
      createdAt?: string;
      services?: Page<{ id?: string; name?: string }>;
      environments?: Page<{ id?: string; name?: string }>;
    }>;
  };
};

const listProjectsQuery = /* GraphQL */ `
  query {
    me {
      projects {
        edges {
          node {
            id
            name
            description
            createdAt
            services { edges { node { id name } } }
            environments { edges { node { id name } } }
          }
        }
      }
    }
  }
`;

function buildListProjectsTool(token: string): ToolDefinition {
  return defineTool({
    name: "railway_list_projects",
    label: "Railway: list projects",
    description:
      "List Railway projects accessible to the configured token, including their services and environments. Read-only.",
    promptSnippet: "railway_list_projects: list Railway projects with services and environments.",
    parameters: listProjectsParams,
    async execute(_id, _params: Static<typeof listProjectsParams>, signal) {
      const data = await railwayQuery<ListProjectsResult>(token, listProjectsQuery, {}, signal);
      const projects = (data.me?.projects?.edges ?? [])
        .map((e) => e.node)
        .filter((n): n is NonNullable<typeof n> => Boolean(n));
      const text = projects.length
        ? projects
            .map((p, i) => {
              const services = (p.services?.edges ?? [])
                .map((e) => e.node?.name)
                .filter(Boolean)
                .join(", ");
              const envs = (p.environments?.edges ?? [])
                .map((e) => e.node?.name)
                .filter(Boolean)
                .join(", ");
              return (
                `${i + 1}. ${p.name} (id=${p.id})` +
                (p.description ? `\n   ${p.description}` : "") +
                (services ? `\n   services: ${services}` : "") +
                (envs ? `\n   envs: ${envs}` : "")
              );
            })
            .join("\n\n")
        : "No projects.";
      return {
        content: [{ type: "text", text }],
        details: { count: projects.length }
      };
    }
  });
}

// ----- get_project -----

const getProjectParams = Type.Object({
  id: Type.String({ description: "Railway project id." })
});

type GetProjectResult = {
  project?: {
    id?: string;
    name?: string;
    description?: string | null;
    services?: Page<{
      id?: string;
      name?: string;
      deployments?: Page<{
        id?: string;
        status?: string;
        staticUrl?: string | null;
        createdAt?: string;
        environment?: { name?: string };
        meta?: { commitMessage?: string };
      }>;
    }>;
  };
};

const getProjectQuery = /* GraphQL */ `
  query ($id: String!) {
    project(id: $id) {
      id
      name
      description
      services {
        edges {
          node {
            id
            name
            deployments(first: 3) {
              edges {
                node {
                  id
                  status
                  staticUrl
                  createdAt
                  environment { name }
                  meta
                }
              }
            }
          }
        }
      }
    }
  }
`;

function buildGetProjectTool(token: string): ToolDefinition {
  return defineTool<typeof getProjectParams, { id?: string; services?: number }>({
    name: "railway_get_project",
    label: "Railway: get project",
    description:
      "Get a Railway project with its services and the latest 3 deployments per service (status, environment, URL, commit). Read-only.",
    promptSnippet: "railway_get_project: get one project's services and recent deployments.",
    parameters: getProjectParams,
    async execute(_id, params: Static<typeof getProjectParams>, signal) {
      const data = await railwayQuery<GetProjectResult>(
        token,
        getProjectQuery,
        { id: params.id },
        signal
      );
      const project = data.project;
      if (!project) {
        return { content: [{ type: "text", text: `No project with id=${params.id}` }], details: {} };
      }
      const services = (project.services?.edges ?? [])
        .map((e) => e.node)
        .filter((n): n is NonNullable<typeof n> => Boolean(n));
      const blocks = services.map((svc) => {
        const deps = (svc.deployments?.edges ?? []).map((e) => e.node).filter(Boolean);
        const depLines = deps.length
          ? deps
              .map((d) => {
                const when = d?.createdAt ? d.createdAt.slice(0, 19) + "Z" : "?";
                const env = d?.environment?.name ?? "?";
                const url = d?.staticUrl ? ` ${d.staticUrl}` : "";
                const msg = d?.meta?.commitMessage?.split("\n")[0]?.slice(0, 80) ?? "";
                return `   - [${d?.status ?? "?"}] ${env}${url} (${when})` + (msg ? ` "${msg}"` : "");
              })
              .join("\n")
          : "   (no deployments)";
        return `Service ${svc.name} (id=${svc.id}):\n${depLines}`;
      });
      const text =
        `Project ${project.name} (id=${project.id})` +
        (project.description ? `\n${project.description}` : "") +
        (blocks.length ? `\n\n${blocks.join("\n\n")}` : "\n(no services)");
      return {
        content: [{ type: "text", text }],
        details: { id: project.id, services: services.length }
      };
    }
  });
}

/**
 * Read-only Railway tools. Requires RAILWAY_API_TOKEN (a personal or team token,
 * NOT a project token - project tokens are scoped to one project and can't list).
 */
export function createRailwayTools(): ToolDefinition[] {
  const token = process.env.RAILWAY_API_TOKEN?.trim();
  if (!token) {
    return [];
  }
  return [buildListProjectsTool(token), buildGetProjectTool(token)];
}
