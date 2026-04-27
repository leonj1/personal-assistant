// Schedule management tools.
//
// These tools let the bot (and staff sub-agents) inspect, create, and
// delete recurring schedules in the notes service. The notes scheduler
// fires `script_path` on the days/times configured; for the bot's typical
// flow that script will POST back to the bot's /scheduler/trigger endpoint
// to wake up the appropriate staff member.
//
// Surface mirrored from notes/server.go:
//   schedule_list   -> GET    /schedules
//   schedule_create -> POST   /schedules
//   schedule_delete -> DELETE /schedules/:id
//
// There is no schedule_update or schedule_snooze tool because the notes
// service does not expose update endpoints over HTTP today. To "change" a
// schedule, delete and recreate.

import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { NotesApiError, type NotesClient } from "../notes.js";

// ---- schedule_list ----

const scheduleListParams = Type.Object({});

function buildScheduleListTool(client: NotesClient): ToolDefinition {
  return defineTool({
    name: "schedule_list",
    label: "List schedules",
    description:
      "List all recurring schedules registered with the notes scheduler. Each schedule fires its `script_path` on the configured allowed_days/allowed_times. Use this before `schedule_create` to avoid duplicates and to discover schedule ids you might want to delete. Returns an array of schedules; an empty array means nothing is scheduled.",
    promptSnippet:
      "schedule_list: list all recurring schedules in the notes service. No args.",
    parameters: scheduleListParams,
    async execute(_id, _params: Static<typeof scheduleListParams>, signal) {
      const items = await client.listSchedules(signal);
      const text = items.length
        ? `Found ${items.length} schedule(s):\n` +
          items
            .map((s) => {
              const desc = s.description ? ` — ${s.description}` : "";
              const days = s.allowed_days || "any-day";
              const times = s.allowed_times || "any-time";
              const status = s.status ?? "disabled";
              const snoozed = s.snoozed_until ? ` snoozed-until=${s.snoozed_until}` : "";
              return `- id=${s.id} [${status}] ${days} ${times} -> ${s.script_path}${desc}${snoozed}`;
            })
            .join("\n")
        : "No schedules registered.";
      return {
        content: [{ type: "text", text }],
        details: { count: items.length, items }
      };
    }
  });
}

// ---- schedule_create ----

const scheduleCreateParams = Type.Object({
  cron_schedule: Type.String({
    description:
      "Cron expression that triggers the schedule. Format is standard 5-field cron ('minute hour day month weekday'). The notes scheduler also enforces allowed_days and allowed_times on top of the cron, so a sensible idiom is to set cron_schedule to '0 * * * *' (every hour) and use allowed_days/allowed_times to restrict. Required."
  }),
  script_path: Type.String({
    description:
      "Shell command the notes scheduler will execute when the schedule fires. The notes scheduler runs this through `/bin/sh -c`, so it can be a full pipeline (e.g. a curl POST). For bot-driven workflows the idiom is a curl call to this bot's /scheduler/trigger endpoint, with the request and (optional) staff_id in the JSON body. Use the SCHEDULER_TRIGGER_URL_FROM_NOTES env var on the bot for the exact URL to put here. Required."
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Human-readable description shown in the UI and in `schedule_list` output. Strongly recommended (e.g. 'Check Windup Watch Fair brand roster')."
    })
  ),
  allowed_days: Type.Optional(
    Type.String({
      description:
        "Comma-separated 3-letter day names that this schedule is allowed to fire on (e.g. 'Mon,Tue,Wed,Thu,Fri'). Empty/missing means any day."
    })
  ),
  allowed_times: Type.Optional(
    Type.String({
      description:
        "Comma-separated time windows the schedule is allowed to fire in, in 24h HH:MM-HH:MM form (e.g. '08:00-09:00,14:00-15:00' for 'morning and afternoon'). Empty/missing means any time."
    })
  ),
  silence_days: Type.Optional(
    Type.String({
      description: "Days the schedule must NOT fire on (same format as allowed_days)."
    })
  ),
  silence_times: Type.Optional(
    Type.String({
      description: "Time windows the schedule must NOT fire in (same format as allowed_times)."
    })
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("enabled"), Type.Literal("disabled")], {
      description:
        "'enabled' means the scheduler will fire the script; 'disabled' means the schedule exists but is paused. SERVER DEFAULT IS 'disabled' — pass 'enabled' explicitly if you want the schedule to actually run."
    })
  ),
  interval_weeks: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Run only every N weeks relative to anchor_date. Default 1 (every week). Set to 2 for biweekly, 4 for monthly-ish, etc."
    })
  ),
  anchor_date: Type.Optional(
    Type.String({
      description:
        "Reference date (RFC3339) for week-parity calculations when interval_weeks > 1. Required only if interval_weeks > 1."
    })
  )
});

function buildScheduleCreateTool(client: NotesClient): ToolDefinition {
  return defineTool({
    name: "schedule_create",
    label: "Create schedule",
    description:
      "Create a recurring schedule that fires `script_path` on the configured cadence. Used to set up autonomous monitoring, periodic check-ins, or anything that needs to happen on a clock without the user pinging the bot. After this is created, the notes scheduler will exec the script on the configured days/times. IMPORTANT: server defaults status to 'disabled' — pass status: 'enabled' to actually run. Returns the new schedule including its server-assigned id.",
    promptSnippet:
      "schedule_create: register a recurring schedule with the notes scheduler. Args: cron_schedule (required), script_path (required), description, allowed_days, allowed_times, status ('enabled' to run), etc.",
    parameters: scheduleCreateParams,
    async execute(_id, params: Static<typeof scheduleCreateParams>, signal) {
      try {
        const sched = await client.createSchedule(params, signal);
        const text =
          `Created schedule id=${sched.id} status=${sched.status ?? "?"} ` +
          `cron='${sched.cron_schedule}' script='${sched.script_path}'` +
          (sched.description ? ` (${sched.description})` : "");
        return {
          content: [{ type: "text", text }],
          details: { schedule: sched }
        };
      } catch (err) {
        if (err instanceof NotesApiError) {
          throw new Error(
            `Schedule creation failed (HTTP ${err.status}): ${err.body || err.message}`
          );
        }
        throw err;
      }
    }
  });
}

// ---- schedule_delete ----

const scheduleDeleteParams = Type.Object({
  id: Type.String({
    description:
      "Numeric id of the schedule to delete (from schedule_list). Pass as a string; the notes API serializes ids as JSON strings."
  })
});

function buildScheduleDeleteTool(client: NotesClient): ToolDefinition {
  return defineTool({
    name: "schedule_delete",
    label: "Delete schedule",
    description:
      "Permanently delete a schedule by id. Cannot be undone — to pause a schedule temporarily, prefer recreating it with status='disabled' (note: the server has no update endpoint, so 'pause' currently means delete + recreate). Use schedule_list to find the id.",
    promptSnippet: "schedule_delete: delete a schedule by id. Args: id.",
    parameters: scheduleDeleteParams,
    async execute(_id, params: Static<typeof scheduleDeleteParams>, signal) {
      try {
        await client.deleteSchedule(params.id, signal);
        return {
          content: [{ type: "text", text: `Deleted schedule ${params.id}.` }],
          details: { id: params.id }
        };
      } catch (err) {
        if (err instanceof NotesApiError && err.status === 500) {
          // notes returns 500 with the error body for a not-found id;
          // surface that to the LLM as a recoverable miss.
          throw new Error(
            `Schedule ${params.id} could not be deleted: ${err.body || err.message}`
          );
        }
        throw err;
      }
    }
  });
}

/**
 * Build the schedule toolset. Returns an empty array when no notes client
 * is configured (i.e. `NOTES_API_URL` is unset), so the bot silently omits
 * the tools instead of registering broken stubs.
 */
export function createScheduleTools(client: NotesClient | undefined): ToolDefinition[] {
  if (!client) return [];
  return [
    buildScheduleListTool(client),
    buildScheduleCreateTool(client),
    buildScheduleDeleteTool(client)
  ];
}
