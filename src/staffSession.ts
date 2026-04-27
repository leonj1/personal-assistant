// Ephemeral staff session runner.
//
// Per Iteration 1 design notes, staff are not long-running threads — a
// `Staff` row is configuration. This module instantiates a one-shot
// pi-mono AgentSession using the staff's persisted `system_prompt` plus
// a small system preamble that tells the LLM which staff it is.
//
// The session is disposed after a single prompt/response round-trip so the
// bot doesn't accumulate state for staff that may only be summoned once
// every few hours or days.
import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  type AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { Staff } from "./missions.js";

export type StaffSessionDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /**
   * Tools available to the staff sub-agent. The caller MUST exclude the
   * `staff_*` tools to prevent infinite recursion (a travel-agent staff
   * delegating to itself).
   */
  staffTools: ToolDefinition[];
  /**
   * Built-in pi-mono tool names the staff is allowed to use. Defaults to
   * `["read", "write", "edit"]` matching the main bot's allowlist.
   */
  builtinAllowlist?: string[];
  /**
   * Workspace root directory; staff scratch sessions live under
   * `${workspaceRoot}/staff/${staff.id}/`.
   */
  workspaceRoot: string;
};

export type StaffSessionResult = {
  text: string;
  staff: Staff;
};

const DEFAULT_BUILTINS = ["read", "write", "edit"];

/**
 * Run a single prompt against an ephemeral staff session and return the
 * staff's reply text. The session is disposed before this function
 * resolves; callers do not need to clean up.
 *
 * Throws if the staff record has no `system_prompt` (the bot relies on the
 * persisted prompt to set persona; an empty staff is a configuration bug).
 */
export async function runStaffSession(
  staff: Staff,
  request: string,
  deps: StaffSessionDeps
): Promise<StaffSessionResult> {
  const systemPrompt = composeStaffSystemPrompt(staff);

  const workspace = resolvePath(deps.workspaceRoot, "staff", staff.id);
  await mkdir(workspace, { recursive: true });

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: getAgentDir(),
    systemPrompt
  });
  await resourceLoader.reload();

  const builtinAllowlist = deps.builtinAllowlist ?? DEFAULT_BUILTINS;
  const allowedToolNames = [...builtinAllowlist, ...deps.staffTools.map((t) => t.name)];

  const { session } = await createAgentSession({
    model: deps.model,
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    customTools: deps.staffTools,
    cwd: workspace,
    tools: allowedToolNames
  });

  try {
    await session.prompt(request);

    const messages = session.messages;
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      if (last.stopReason === "error" || last.stopReason === "aborted") {
        throw new Error(last.errorMessage ?? `Staff session ${last.stopReason}`);
      }
    }

    const text = session.getLastAssistantText()?.trim() || "(no response)";
    return { text, staff };
  } finally {
    session.dispose();
  }
}

/**
 * Compose the system prompt seen by the staff sub-agent. Wraps the
 * persisted `staff.system_prompt` with a short identity preamble plus a
 * standing instruction to break complex requests into project + tasks
 * via the mission tools when appropriate.
 */
export function composeStaffSystemPrompt(staff: Staff): string {
  const persisted = (staff.system_prompt ?? "").trim();
  if (!persisted) {
    throw new Error(
      `Staff ${staff.id} (${staff.area_of_focus}) has no system_prompt; refusing to dispatch.`
    );
  }

  const description = (staff.description ?? "").trim();
  const preamble =
    `You are ${staff.name}, a staff member specialised in ${staff.area_of_focus}.\n` +
    (description ? `${description}\n` : "") +
    `\n` +
    `When you receive a request, first decide whether it is a one-off task or warrants ` +
    `a project with sub-tasks. If it warrants a project, call \`mission_create_project\` ` +
    `(optionally with a parent mission_id) and then \`mission_create_task\` for each ` +
    `sub-task; pass your own staff_id="${staff.id}" so the work stays attributed to you. ` +
    `Otherwise complete the request directly and return a concise final answer.\n` +
    `\n` +
    `--- Persona-specific instructions ---\n`;

  return `${preamble}${persisted}`;
}
