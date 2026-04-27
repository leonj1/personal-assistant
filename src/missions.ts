// Missions API client. Wraps personal-assistant-missions REST endpoints
// with typed request/response shapes that match the Go services'
// CreateXxxInput / model JSON tags. See ../personal-assistant-missions/
// services/{staff,missions,projects,tasks}.go for the source of truth.

export type Mission = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  staff_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type Project = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  mission_id?: string | null;
  staff_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  project_id?: string | null;
  staff_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type Staff = {
  id: string;
  name: string;
  area_of_focus: string;
  description: string | null;
  system_prompt: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type Secret = {
  name: string;
  value: string;
  created_at: string;
};

// Server-side shape returned by GET /secrets. The bot's `secret_list` tool
// intentionally drops the `value` field before handing the result to the
// LLM; this type lives here so the HTTP client itself can stay typed end
// to end.
export type SecretListResult = {
  items: Secret[];
  total: number;
};

export type CreateSecretInput = {
  name: string;
  value: string;
};

export type UpdateSecretInput = {
  value: string;
};

export type ListSecretsFilter = {
  limit?: number;
  offset?: number;
};

export type CreateStaffInput = {
  name: string;
  area_of_focus: string;
  description?: string;
  system_prompt?: string;
  status?: string;
};

export type CreateMissionInput = {
  title: string;
  description?: string;
  status?: string;
  staff_id?: string;
};

export type CreateProjectInput = {
  title: string;
  description?: string;
  status?: string;
  mission_id?: string;
  staff_id?: string;
};

export type CreateTaskInput = {
  title: string;
  description?: string;
  status?: string;
  project_id?: string;
  staff_id?: string;
};

export type ListStaffFilter = {
  status?: string;
  area_of_focus?: string;
};

export type ListProjectsFilter = {
  status?: string;
  mission_id?: string;
  staff_id?: string;
};

export type ListTasksFilter = {
  status?: string;
  project_id?: string;
  staff_id?: string;
};

export class MissionsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "MissionsApiError";
  }
}

export class MissionsClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error("MissionsClient requires a non-empty baseUrl");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // ---- Staff ----

  listStaff(filter: ListStaffFilter = {}, signal?: AbortSignal): Promise<Staff[]> {
    return this.request<Staff[]>("GET", `/staff${this.qs(filter)}`, undefined, signal);
  }

  getStaff(id: string, signal?: AbortSignal): Promise<Staff> {
    return this.request<Staff>("GET", `/staff/${encodeURIComponent(id)}`, undefined, signal);
  }

  /**
   * Look up a staff member by exact area_of_focus. Returns null when no
   * match exists. Convenience wrapper around `listStaff` for the common
   * "do I already have a travel-agent?" check.
   */
  async getStaffByArea(area: string, signal?: AbortSignal): Promise<Staff | null> {
    const matches = await this.listStaff({ area_of_focus: area }, signal);
    return matches[0] ?? null;
  }

  createStaff(input: CreateStaffInput, signal?: AbortSignal): Promise<Staff> {
    return this.request<Staff>("POST", "/staff", input, signal);
  }

  // ---- Missions / Projects / Tasks (create-only for now; iteration 3 needs
  // these so a staff sub-agent can record a project + sub-tasks for the
  // request it just took on). ----

  createMission(input: CreateMissionInput, signal?: AbortSignal): Promise<Mission> {
    return this.request<Mission>("POST", "/missions", input, signal);
  }

  createProject(input: CreateProjectInput, signal?: AbortSignal): Promise<Project> {
    return this.request<Project>("POST", "/projects", input, signal);
  }

  createTask(input: CreateTaskInput, signal?: AbortSignal): Promise<Task> {
    return this.request<Task>("POST", "/tasks", input, signal);
  }

  listProjects(filter: ListProjectsFilter = {}, signal?: AbortSignal): Promise<Project[]> {
    return this.request<Project[]>("GET", `/projects${this.qs(filter)}`, undefined, signal);
  }

  listTasks(filter: ListTasksFilter = {}, signal?: AbortSignal): Promise<Task[]> {
    return this.request<Task[]>("GET", `/tasks${this.qs(filter)}`, undefined, signal);
  }

  // ---- Secrets ----

  /**
   * List secrets. Returns the raw {items, total} envelope from the missions
   * API, including each secret's `value`. The bot's `secret_list` tool is
   * responsible for stripping `value` before handing rows to the LLM.
   */
  listSecrets(filter: ListSecretsFilter = {}, signal?: AbortSignal): Promise<SecretListResult> {
    const params: Record<string, string | undefined> = {
      limit: filter.limit !== undefined ? String(filter.limit) : undefined,
      offset: filter.offset !== undefined ? String(filter.offset) : undefined
    };
    return this.request<SecretListResult>("GET", `/secrets${this.qs(params)}`, undefined, signal);
  }

  getSecret(name: string, signal?: AbortSignal): Promise<Secret> {
    return this.request<Secret>("GET", `/secrets/${encodeURIComponent(name)}`, undefined, signal);
  }

  createSecret(input: CreateSecretInput, signal?: AbortSignal): Promise<Secret> {
    return this.request<Secret>("POST", "/secrets", input, signal);
  }

  updateSecret(
    name: string,
    input: UpdateSecretInput,
    signal?: AbortSignal
  ): Promise<Secret> {
    return this.request<Secret>(
      "PUT",
      `/secrets/${encodeURIComponent(name)}`,
      input,
      signal
    );
  }

  deleteSecret(name: string, signal?: AbortSignal): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/secrets/${encodeURIComponent(name)}`,
      undefined,
      signal
    );
  }

  // ---- internals ----

  private qs(filter: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== "") {
        params.set(key, value);
      }
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const init: RequestInit = { method, signal };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new MissionsApiError(
        `Missions API ${method} ${path} failed: ${response.status} ${response.statusText}${
          text ? ` — ${text.slice(0, 300)}` : ""
        }`,
        response.status,
        text
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
