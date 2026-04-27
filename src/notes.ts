// Notes API client. Wraps the notes service's /schedules endpoints with
// typed request/response shapes that match the Go models in
// ../../notes/models/schedule.go.
//
// Surface (notes/server.go):
//   POST   /schedules           -> create
//   GET    /schedules           -> list
//   GET    /schedules/:id       -> read one
//   DELETE /schedules/:id       -> delete
//
// There is intentionally no update or snooze endpoint on the server today;
// to "change" a schedule, delete and recreate. This client mirrors that
// surface exactly — adding fake convenience methods would mislead the LLM.

export type Schedule = {
  // Notes' Go model serializes id as a JSON string ("id,string,omitempty"),
  // so the parsed value here is a string. Convert to number only if you
  // need to compare numerically.
  id: string;
  cron_schedule: string;
  allowed_days?: string;
  allowed_times?: string;
  silence_days?: string;
  silence_times?: string;
  script_path: string;
  description?: string;
  status?: "enabled" | "disabled";
  create_date?: string;
  interval_weeks?: number;
  anchor_date?: string;
  snoozed_until?: string;
};

export type CreateScheduleInput = {
  // Required by the server (models/schedule.go Save()).
  cron_schedule: string;
  script_path: string;

  // All other fields are optional. Defaults are server-side: status
  // defaults to "disabled" if not supplied (yes, that's the default — set
  // status: "enabled" explicitly when you want the schedule to actually
  // fire).
  allowed_days?: string; // e.g. "Mon,Tue,Wed,Thu,Fri"
  allowed_times?: string; // e.g. "08:00-09:00,14:00-15:00"
  silence_days?: string;
  silence_times?: string;
  description?: string;
  status?: "enabled" | "disabled";
  interval_weeks?: number;
  anchor_date?: string;
  snoozed_until?: string;
};

export class NotesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "NotesApiError";
  }
}

export class NotesClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) {
      throw new Error("NotesClient requires a non-empty baseUrl");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  listSchedules(signal?: AbortSignal): Promise<Schedule[]> {
    return this.request<Schedule[]>("GET", "/schedules", undefined, signal);
  }

  getSchedule(id: string, signal?: AbortSignal): Promise<Schedule> {
    return this.request<Schedule>(
      "GET",
      `/schedules/${encodeURIComponent(id)}`,
      undefined,
      signal
    );
  }

  createSchedule(input: CreateScheduleInput, signal?: AbortSignal): Promise<Schedule> {
    return this.request<Schedule>("POST", "/schedules", input, signal);
  }

  deleteSchedule(id: string, signal?: AbortSignal): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/schedules/${encodeURIComponent(id)}`,
      undefined,
      signal
    );
  }

  // ---- internals ----

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
      throw new NotesApiError(
        `Notes API ${method} ${path} failed: ${response.status} ${response.statusText}${
          text ? ` — ${text.slice(0, 300)}` : ""
        }`,
        response.status,
        text
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    // Some endpoints (DELETE) return short JSON envelopes like
    // {"status":"deleted"}; we still parse so the caller can ignore.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}
