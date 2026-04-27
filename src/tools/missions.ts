import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type MissionsClient } from "../missions.js";

// ---- mission_create_project ----

const createProjectParams = Type.Object({
  title: Type.String({ description: "Project title (short, imperative). Required." }),
  description: Type.Optional(
    Type.String({
      description: "Longer free-form description of the project's goal. Optional."
    })
  ),
  mission_id: Type.Optional(
    Type.String({
      description:
        "ID of the parent mission this project rolls up to (e.g. an 'increase revenue' mission). Optional; omit for stand-alone projects."
    })
  ),
  staff_id: Type.Optional(
    Type.String({
      description:
        "ID of the staff member that owns this project. Pass your own staff_id when you (a staff sub-agent) are recording your own work."
    })
  ),
  status: Type.Optional(
    Type.Union(
      [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
      { description: "Project status. Defaults to 'pending'." }
    )
  )
});

function buildCreateProjectTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "mission_create_project",
    label: "Create project",
    description:
      "Create a project under the missions API. Use this when a request is too large for a single task and warrants tracking sub-tasks. Returns the created project's id.",
    promptSnippet:
      "mission_create_project: create a project. Args: title, description?, mission_id?, staff_id?, status?",
    parameters: createProjectParams,
    async execute(_id, params: Static<typeof createProjectParams>, signal) {
      const project = await client.createProject(
        {
          title: params.title,
          description: params.description,
          mission_id: params.mission_id,
          staff_id: params.staff_id,
          status: params.status
        },
        signal
      );
      return {
        content: [
          {
            type: "text",
            text: `Created project ${project.id} "${project.title}" (status=${project.status}${
              project.mission_id ? `, mission_id=${project.mission_id}` : ""
            }${project.staff_id ? `, staff_id=${project.staff_id}` : ""}).`
          }
        ],
        details: { project }
      };
    }
  });
}

// ---- mission_create_task ----

const createTaskParams = Type.Object({
  title: Type.String({ description: "Task title (short, imperative). Required." }),
  project_id: Type.String({
    description:
      "ID of the project this task belongs to. Required — tasks always live under a project."
  }),
  description: Type.Optional(
    Type.String({ description: "Longer free-form description of the task. Optional." })
  ),
  staff_id: Type.Optional(
    Type.String({
      description:
        "Staff member responsible for the task. Pass your own staff_id when you are recording your own work."
    })
  ),
  status: Type.Optional(
    Type.Union(
      [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
      { description: "Task status. Defaults to 'pending'." }
    )
  )
});

function buildCreateTaskTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "mission_create_task",
    label: "Create task",
    description:
      "Create a task under an existing project. Use after `mission_create_project` to record each sub-task of a broken-down request. Returns the created task's id.",
    promptSnippet:
      "mission_create_task: create a task. Args: title, project_id, description?, staff_id?, status?",
    parameters: createTaskParams,
    async execute(_id, params: Static<typeof createTaskParams>, signal) {
      const task = await client.createTask(
        {
          title: params.title,
          project_id: params.project_id,
          description: params.description,
          staff_id: params.staff_id,
          status: params.status
        },
        signal
      );
      return {
        content: [
          {
            type: "text",
            text: `Created task ${task.id} "${task.title}" (project_id=${task.project_id ?? "?"}, status=${task.status}${
              task.staff_id ? `, staff_id=${task.staff_id}` : ""
            }).`
          }
        ],
        details: { task }
      };
    }
  });
}

// ---- mission_create_mission ----

const createMissionParams = Type.Object({
  title: Type.String({
    description:
      "Mission title (e.g. 'Increase revenue'). Missions are intentionally long-lived and have no end date."
  }),
  description: Type.Optional(Type.String({ description: "Longer description. Optional." })),
  staff_id: Type.Optional(
    Type.String({ description: "Staff that owns the mission (e.g. a 'Head of X' staff)." })
  ),
  status: Type.Optional(
    Type.Union(
      [Type.Literal("active"), Type.Literal("paused"), Type.Literal("completed")],
      { description: "Mission status. Defaults to 'active'." }
    )
  )
});

function buildCreateMissionTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "mission_create_mission",
    label: "Create mission",
    description:
      "Create a long-lived mission (intentionally has no end date). Use sparingly — most work fits under an existing mission as a project.",
    promptSnippet:
      "mission_create_mission: create a mission. Args: title, description?, staff_id?, status?",
    parameters: createMissionParams,
    async execute(_id, params: Static<typeof createMissionParams>, signal) {
      const mission = await client.createMission(
        {
          title: params.title,
          description: params.description,
          staff_id: params.staff_id,
          status: params.status
        },
        signal
      );
      return {
        content: [
          {
            type: "text",
            text: `Created mission ${mission.id} "${mission.title}" (status=${mission.status}${
              mission.staff_id ? `, staff_id=${mission.staff_id}` : ""
            }).`
          }
        ],
        details: { mission }
      };
    }
  });
}

/**
 * Build the missions toolset (mission/project/task creation). Returns an
 * empty array when MISSIONS_API_URL is not configured so the LLM never
 * sees a broken tool surface.
 */
export function createMissionTools(client: MissionsClient | undefined): ToolDefinition[] {
  if (!client) return [];
  return [
    buildCreateMissionTool(client),
    buildCreateProjectTool(client),
    buildCreateTaskTool(client)
  ];
}
