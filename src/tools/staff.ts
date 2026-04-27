import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { MissionsApiError, type MissionsClient, type Staff } from "../missions.js";

/**
 * Hook for delegating a request to a (possibly newly-created) staff member.
 * The implementation lives in the bot host because it needs the live
 * pi-mono model + tool registry; this module only consumes it.
 *
 * Returns the staff's reply text. Errors propagate so the caller's tool
 * frame surfaces them to the LLM.
 */
export type StaffDelegateRunner = (
  staff: Staff,
  request: string,
  signal?: AbortSignal
) => Promise<string>;

// ---- staff_list ----

const staffListParams = Type.Object({
  area_of_focus: Type.Optional(
    Type.String({
      description:
        "Exact area_of_focus to filter by (e.g. 'travel'). Omit to list all staff."
    })
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("retired")], {
      description: "Filter by staff status. Defaults to all."
    })
  )
});

function buildStaffListTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "staff_list",
    label: "List staff",
    description:
      "List the staff members the assistant can delegate to. Use this BEFORE deciding whether to create a new staff for a request — area_of_focus values are unique, so if a matching staff already exists you should reuse it.",
    promptSnippet:
      "staff_list: list staff (singletons-per-area). Args: area_of_focus?, status?.",
    parameters: staffListParams,
    async execute(_id, params: Static<typeof staffListParams>, signal) {
      const staff = await client.listStaff(
        {
          area_of_focus: params.area_of_focus,
          status: params.status
        },
        signal
      );

      const text = staff.length
        ? staff
            .map(
              (s) =>
                `- ${s.id} | ${s.name} | area=${s.area_of_focus} | status=${s.status}` +
                (s.description ? `\n  ${s.description.replace(/\s+/g, " ").slice(0, 200)}` : "")
            )
            .join("\n")
        : "No staff found.";

      return {
        content: [{ type: "text", text }],
        details: { count: staff.length, staff }
      };
    }
  });
}

// ---- staff_create ----

const staffCreateParams = Type.Object({
  name: Type.String({
    description: "Display name for the staff member, e.g. 'Travel Agent'."
  }),
  area_of_focus: Type.String({
    description:
      "Unique area key (lowercase, hyphenated). One staff per area; e.g. 'travel', 'revenue', 'real-estate'. Required."
  }),
  system_prompt: Type.String({
    description:
      "The persona prompt used when the staff is summoned. Should describe the staff's role, tone, what tools to prefer, and how aggressive to be about breaking work into project + sub-tasks. Required."
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Short human-readable description of the staff's responsibilities (visible in staff_list)."
    })
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("retired")], {
      description: "Defaults to 'active'."
    })
  )
});

function buildStaffCreateTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "staff_create",
    label: "Hire staff",
    description:
      "Create a new staff member when no existing staff covers the area_of_focus you need. ALWAYS call `staff_list` with the area first; area_of_focus is UNIQUE and creating a duplicate will fail. Returns the new staff's id which you can immediately pass to `staff_delegate`.",
    promptSnippet:
      "staff_create: hire a new staff (one per area). Args: name, area_of_focus, system_prompt, description?, status?.",
    parameters: staffCreateParams,
    async execute(_id, params: Static<typeof staffCreateParams>, signal) {
      try {
        const staff = await client.createStaff(
          {
            name: params.name,
            area_of_focus: params.area_of_focus,
            system_prompt: params.system_prompt,
            description: params.description,
            status: params.status
          },
          signal
        );
        return {
          content: [
            {
              type: "text",
              text: `Hired ${staff.name} (id=${staff.id}, area=${staff.area_of_focus}). You can now delegate via staff_delegate.`
            }
          ],
          details: { staff }
        };
      } catch (err) {
        // Convert the missions API uniqueness error into something the LLM
        // can recover from by re-listing rather than retrying.
        if (
          err instanceof MissionsApiError &&
          err.status === 400 &&
          /area_of_focus/i.test(err.body ?? "")
        ) {
          const existing = await client.getStaffByArea(params.area_of_focus, signal).catch(() => null);
          const idHint = existing ? ` Existing staff for that area: ${existing.id} (${existing.name}).` : "";
          throw new Error(
            `Cannot create staff for area_of_focus="${params.area_of_focus}": already in use.${idHint} Use staff_delegate with the existing staff_id instead.`
          );
        }
        throw err;
      }
    }
  });
}

// ---- staff_delegate ----

const staffDelegateParams = Type.Object({
  staff_id: Type.String({
    description: "ID of the staff member to delegate to (from staff_list or staff_create)."
  }),
  request: Type.String({
    description:
      "The request to hand to the staff. Be specific — include the user's intent, any constraints, and the desired output. The staff sees this as a fresh prompt with no chat history."
  })
});

function buildStaffDelegateTool(
  client: MissionsClient,
  runner: StaffDelegateRunner
): ToolDefinition {
  return defineTool({
    name: "staff_delegate",
    label: "Delegate to staff",
    description:
      "Hand a request off to a staff member's persona. The staff is instantiated on-demand using its persisted system_prompt, given the same custom tools as the main bot, and may break the request into a project + sub-tasks. Returns the staff's final answer as a string.",
    promptSnippet:
      "staff_delegate: run a request as the named staff (ephemeral session). Args: staff_id, request.",
    parameters: staffDelegateParams,
    async execute(_id, params: Static<typeof staffDelegateParams>, signal) {
      let staff: Staff;
      try {
        staff = await client.getStaff(params.staff_id, signal);
      } catch (err) {
        if (err instanceof MissionsApiError && err.status === 404) {
          throw new Error(
            `Staff ${params.staff_id} not found. Call staff_list to see live staff, or staff_create to mint a new one.`
          );
        }
        throw err;
      }

      if (staff.status !== "active") {
        throw new Error(
          `Staff ${staff.id} (${staff.area_of_focus}) is status="${staff.status}"; cannot delegate.`
        );
      }

      const reply = await runner(staff, params.request, signal);

      return {
        content: [
          {
            type: "text",
            text:
              `[${staff.name} (${staff.area_of_focus})]\n` +
              `${reply}`
          }
        ],
        details: { staff_id: staff.id, area_of_focus: staff.area_of_focus }
      };
    }
  });
}

/**
 * Build the staff toolset. Returns an empty array when no missions client
 * is configured. The `runner` is required for `staff_delegate`; pass a
 * thunk that throws if you only want list/create.
 */
export function createStaffTools(
  client: MissionsClient | undefined,
  runner: StaffDelegateRunner | undefined
): ToolDefinition[] {
  if (!client) return [];
  const tools: ToolDefinition[] = [buildStaffListTool(client), buildStaffCreateTool(client)];
  if (runner) {
    tools.push(buildStaffDelegateTool(client, runner));
  }
  return tools;
}
