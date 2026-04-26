import { spawn, spawnSync } from "node:child_process";
import { type Static, Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

/**
 * pi-devboxer tools, vendored as pi-mono customTools.
 *
 * Mirrors the three tools shipped by github.com/leonj1/pi-devboxer
 * (devboxer_create, devboxer_list, devboxer_pull). The slash command
 * exposed by the upstream extension is intentionally omitted - it
 * uses ctx.ui.* APIs that are TUI-only and have no meaning over Telegram.
 *
 * Setup (operator side, on the bot host):
 *   npm install -g @devboxer/cli
 *   devboxer auth          # one-time, opens a browser
 *
 * If `devboxer` is not on PATH, all three tools are silently omitted.
 */

const DEVBOXER_BINARY = process.env.DEVBOXER_BINARY?.trim() || "devboxer";
const TIMEOUT_MS = 60_000;

const MODELS = [
  "opus",
  "claude-opus-4-6",
  "sonnet",
  "haiku",
  "amp",
  "gpt-5-low",
  "gpt-5-medium",
  "gpt-5",
  "gpt-5-high",
  "gpt-5.1-low",
  "gpt-5.1-medium",
  "gpt-5.1",
  "gpt-5.1-high",
  "gpt-5.2-low",
  "gpt-5.2-medium",
  "gpt-5.2",
  "gpt-5.2-high",
  "gpt-5.4-low",
  "gpt-5.4-medium",
  "gpt-5.4",
  "gpt-5.4-high",
  "gpt-5.4-xhigh",
  "gpt-5.1-codex-max-low",
  "gpt-5.1-codex-max-medium",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-high",
  "gpt-5.1-codex-max-xhigh",
  "gpt-5-codex-low",
  "gpt-5-codex-medium",
  "gpt-5-codex-high",
  "gpt-5.2-codex-low",
  "gpt-5.2-codex-medium",
  "gpt-5.2-codex-high",
  "gpt-5.2-codex-xhigh",
  "gpt-5.3-codex",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-medium",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-xhigh",
  "gemini-3.1-pro-preview",
  "gemini-3-pro",
  "gemini-2.5-pro",
  "grok-code",
  "qwen3-coder",
  "kimi-k2",
  "glm-4.6",
  "opencode/gemini-2.5-pro"
] as const;

type DevboxerResult = { stdout: string; stderr: string };

async function runDevboxer(
  args: string[],
  signal: AbortSignal | undefined
): Promise<DevboxerResult> {
  return new Promise<DevboxerResult>((resolve, reject) => {
    const child = spawn(DEVBOXER_BINARY, args, {
      signal,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      child.kill("SIGTERM");
      timer = undefined;
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const trimmedOut = stdout.trim();
      const trimmedErr = stderr.trim();
      if (code !== 0) {
        reject(
          new Error(
            `devboxer ${args.join(" ")} exited ${code}\n${trimmedErr || trimmedOut}`
          )
        );
        return;
      }
      resolve({ stdout: trimmedOut, stderr: trimmedErr });
    });
  });
}

function isDevboxerInstalled(): boolean {
  try {
    const probe = spawnSync(DEVBOXER_BINARY, ["--version"], {
      stdio: "ignore",
      timeout: 5_000
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

// ----- devboxer_create -----

const createParams = Type.Object({
  message: Type.String({ description: "Task description / prompt for the remote agent." }),
  repo: Type.Optional(Type.String({ description: "owner/repo. Defaults to the current git repo." })),
  branch: Type.Optional(Type.String({ description: "Base branch. Defaults to the current branch." })),
  newBranch: Type.Optional(
    Type.Boolean({ description: "Create a new branch (default true). Set false to use the existing branch." })
  ),
  mode: Type.Optional(StringEnum(["plan", "execute"] as const, { description: "Execution mode." })),
  model: Type.Optional(StringEnum(MODELS, { description: "DevBoxer-supported model." }))
});

const devboxerCreateTool = defineTool({
  name: "devboxer_create",
  label: "DevBoxer Create",
  description:
    "Create a new DevBoxer task and dispatch it to a remote agent. Defaults to the current repo and branch. Use mode='plan' to start in plan mode (no writes until approval).",
  promptSnippet: "devboxer_create: dispatch a new DevBoxer task to a remote agent.",
  promptGuidelines: [
    "Use devboxer_create when the user asks to dispatch work to DevBoxer or to spin off an autonomous task."
  ],
  parameters: createParams,
  async execute(_id, params: Static<typeof createParams>, signal) {
    const args = ["create", params.message];
    if (params.repo) args.push("--repo", params.repo);
    if (params.branch) args.push("--branch", params.branch);
    if (params.newBranch === false) args.push("--no-new-branch");
    if (params.mode) args.push("--mode", params.mode);
    if (params.model) args.push("--model", params.model);
    const { stdout, stderr } = await runDevboxer(args, signal);
    const text = stdout || stderr || "Task created.";
    return { content: [{ type: "text", text }], details: { stdout, stderr } };
  }
});

// ----- devboxer_list -----

const listParams = Type.Object({});

const devboxerListTool = defineTool({
  name: "devboxer_list",
  label: "DevBoxer List",
  description:
    "List DevBoxer tasks. When the bot host is inside a git checkout, results are filtered to that repo automatically.",
  promptSnippet: "devboxer_list: list existing DevBoxer tasks.",
  promptGuidelines: [
    "Use devboxer_list when the user asks what DevBoxer tasks exist, are running, or have PRs open."
  ],
  parameters: listParams,
  async execute(_id, _params: Static<typeof listParams>, signal) {
    const { stdout, stderr } = await runDevboxer(["list"], signal);
    return {
      content: [{ type: "text", text: stdout || stderr || "(no tasks)" }],
      details: { stdout, stderr }
    };
  }
});

// ----- devboxer_pull -----

const pullParams = Type.Object({
  taskId: Type.String({
    description: "Task id (the segment after /tasks/ in the URL, e.g. 'abc123-def456')."
  })
});

const devboxerPullTool = defineTool({
  name: "devboxer_pull",
  label: "DevBoxer Pull",
  description:
    "Pull a DevBoxer task's session data to the bot host by task id. Use the id segment from the task URL.",
  promptSnippet: "devboxer_pull: pull one DevBoxer task locally by id.",
  promptGuidelines: [
    "Use devboxer_pull when the user wants to bring a DevBoxer task's session data into the bot's working tree."
  ],
  parameters: pullParams,
  async execute(_id, params: Static<typeof pullParams>, signal) {
    const { stdout, stderr } = await runDevboxer(["pull", params.taskId], signal);
    return {
      content: [{ type: "text", text: stdout || stderr || "Pulled." }],
      details: { stdout, stderr }
    };
  }
});

/**
 * Build the DevBoxer tool set. Returns [] when the `devboxer` CLI is not on PATH
 * (or DEVBOXER_BINARY points somewhere that doesn't respond to `--version`),
 * so the LLM never sees a tool that will fail at the first call.
 */
export function createDevboxerTools(): ToolDefinition[] {
  if (!isDevboxerInstalled()) {
    console.log(
      `devboxer CLI not found on PATH (DEVBOXER_BINARY='${DEVBOXER_BINARY}'); devboxer_* tools disabled.`
    );
    return [];
  }
  return [devboxerCreateTool, devboxerListTool, devboxerPullTool];
}
