import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from "@mariozechner/pi-coding-agent";
import { createWebTools } from "./tools/web.js";
import { createImageTools } from "./tools/image.js";
import { createGithubTools } from "./tools/github.js";
import { createVercelTools } from "./tools/vercel.js";
import { createRailwayTools } from "./tools/railway.js";
import { createTravelTools } from "./tools/travel.js";
import { createDevboxerTools } from "./tools/devboxer.js";
import { createMissionTools } from "./tools/missions.js";
import { createSecretTools } from "./tools/secrets.js";
import { createStaffTools } from "./tools/staff.js";
import { createScheduleTools } from "./tools/schedules.js";
import { createEmailTools } from "./tools/email.js";
import { MissionsClient, type Staff } from "./missions.js";
import { NotesClient } from "./notes.js";
import { runStaffSession } from "./staffSession.js";
import type { Api, Model } from "@mariozechner/pi-ai";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file present (or it was already loaded via --env-file). Ignore.
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type TelegramMessage = {
  chat?: {
    id?: number;
  };
  text?: string;
};

type TelegramInlineQuery = {
  id?: string;
  query?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  inline_query?: TelegramInlineQuery;
};

type TelegramApiResponse<Result> = {
  ok: boolean;
  result: Result;
  description?: string;
};

const port = Number(process.env.PORT ?? 3000);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramPollTimeoutSeconds = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? 30);
const telegramPollRetryDelayMs = Number(process.env.TELEGRAM_POLL_RETRY_DELAY_MS ?? 1000);
const telegramMaxMessageChars = 4000;

const llmProvider = process.env.LLM_PROVIDER;
const llmModelId = process.env.LLM_MODEL;
const llmBaseUrl = process.env.LLM_BASE_URL;
const llmApiKey = process.env.LLM_API_KEY;
const workspaceRoot = resolvePath(process.env.WORKSPACE_ROOT ?? "./data/workspaces");
const systemPromptPath = resolvePath(process.env.SYSTEM_PROMPT_PATH ?? "./prompts/SYSTEM.md");
const toolsPromptPath = resolvePath(process.env.TOOLS_PROMPT_PATH ?? "./prompts/TOOLS.md");
const missionsApiUrl = process.env.MISSIONS_API_URL?.trim();
const notesApiUrl = process.env.NOTES_API_URL?.trim();
const messengerInboundToken = process.env.MESSENGER_INBOUND_TOKEN?.trim();
const schedulerTriggerToken = process.env.SCHEDULER_TRIGGER_TOKEN?.trim();
const defaultTelegramChatIdRaw = process.env.DEFAULT_TELEGRAM_CHAT_ID?.trim();
const defaultTelegramChatId =
  defaultTelegramChatIdRaw && /^-?\d+$/.test(defaultTelegramChatIdRaw)
    ? Number(defaultTelegramChatIdRaw)
    : undefined;

// Logged once per process so a missing TOOLS.md doesn't spam the log on every
// session creation. Cleared only by restart.
let toolsManifestMissingWarned = false;

async function readSystemPromptFile(): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(systemPromptPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`System prompt file not found at ${systemPromptPath}.`);
    }
    throw new Error(
      `Failed to read system prompt from ${systemPromptPath}: ${(error as Error).message}`
    );
  }
  const trimmed = contents.trim();
  if (!trimmed) {
    throw new Error(`System prompt at ${systemPromptPath} is empty.`);
  }
  return trimmed;
}

/**
 * Read the optional tools manifest. Missing file is not fatal — the manifest
 * is meant to enrich the LLM's context with operational guidance, but the
 * pi-mono tool registry already exposes each tool's name + schema regardless.
 */
async function readToolsManifestFile(): Promise<string> {
  try {
    const contents = await readFile(toolsPromptPath, "utf8");
    return contents.trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (!toolsManifestMissingWarned) {
        console.log(
          `Tools manifest not found at ${toolsPromptPath}; agent will run without tools manifest.`
        );
        toolsManifestMissingWarned = true;
      }
      return "";
    }
    throw new Error(
      `Failed to read tools manifest from ${toolsPromptPath}: ${(error as Error).message}`
    );
  }
}

/**
 * Compose the full system prompt fed to a fresh agent session. Reads both
 * SYSTEM.md and TOOLS.md from disk on every call so operator edits to either
 * file take effect at the next chat session start without rebuild/restart.
 */
async function composeAgentSystemPrompt(): Promise<{
  prompt: string;
  systemPart: string;
  toolsPart: string;
}> {
  const [systemPart, toolsPart] = await Promise.all([
    readSystemPromptFile(),
    readToolsManifestFile()
  ]);
  const prompt = toolsPart
    ? `${systemPart}\n\n---\n\n${toolsPart}`
    : systemPart;
  return { prompt, systemPart, toolsPart };
}

/**
 * Startup validation: makes sure SYSTEM.md exists and is non-empty before
 * any chat traffic arrives, and surfaces a one-time log line for TOOLS.md.
 */
async function validateAgentPrompts(): Promise<void> {
  const { systemPart, toolsPart } = await composeAgentSystemPrompt();
  console.log(
    `System prompt loaded from ${systemPromptPath} (${systemPart.length} chars).`
  );
  if (toolsPart) {
    console.log(
      `Tools manifest loaded from ${toolsPromptPath} (${toolsPart.length} chars); appended to system prompt at session start.`
    );
  }
}

let nextTelegramUpdateId = 0;
let isShuttingDown = false;
const telegramPollAbortController = new AbortController();

const piSessions = new Map<number, AgentSession>();
let piAuthStorage: AuthStorage | undefined;
let piModelRegistry: ModelRegistry | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let piModel: Model<any> | undefined;
// Resource loaders are constructed per chat in getOrCreatePiSession so the
// composed system prompt (SYSTEM.md + TOOLS.md) is read fresh from disk for
// each new session. There is intentionally no shared piResourceLoader.
let piCustomTools: ToolDefinition[] = [];
// Custom tools the staff sub-agent inherits. Excludes the staff_* tools
// (no recursion) but includes everything else, so a travel-agent staff
// can call web_search/flight_search/mission_create_task etc.
let piStaffSubagentTools: ToolDefinition[] = [];
let missionsClient: MissionsClient | undefined;
let notesClient: NotesClient | undefined;

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function callTelegramApi<Result>(
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Result> {
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload),
    signal
  });

  const responseBody = (await response.json()) as TelegramApiResponse<Result>;

  if (!response.ok || !responseBody.ok) {
    const description = responseBody.description ?? response.statusText;
    throw new Error(`Telegram API ${method} failed: ${response.status} ${description}`);
  }

  return responseBody.result;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const messageText = update.message?.text?.trim();
  const chatId = update.message?.chat?.id;
  const inlineQueryId = update.inline_query?.id;
  const inlineQuery = update.inline_query?.query?.trim();

  if (messageText) {
    console.log("Telegram message received", {
      updateId: update.update_id,
      chatId,
      text: messageText
    });

    if (chatId && telegramBotToken) {
      await callTelegramApi("sendChatAction", {
        chat_id: chatId,
        action: "typing"
      });

      let replyText: string;
      try {
        replyText = await generateAssistantReply(chatId, messageText);
      } catch (error) {
        console.error("Assistant reply failed", error);
        replyText = "Sorry, I hit an error trying to answer that.";
      }

      for (const chunk of chunkTelegramMessage(replyText)) {
        await callTelegramApi("sendMessage", {
          chat_id: chatId,
          text: chunk
        });
      }
    }
  }

  if (inlineQueryId) {
    console.log("Telegram inline query received", {
      updateId: update.update_id,
      query: inlineQuery ?? ""
    });

    if (telegramBotToken) {
      await callTelegramApi("answerInlineQuery", {
        inline_query_id: inlineQueryId,
        results: [
          {
            type: "article",
            id: inlineQueryId,
            title: inlineQuery ? `Process query: ${inlineQuery}` : "Empty query",
            input_message_content: {
              message_text: inlineQuery ? `Received inline query: ${inlineQuery}` : "Received empty inline query."
            },
            description: "Minimal webhook response from this service"
          }
        ],
        cache_time: 0,
        is_personal: true
      });
    }
  }
}

async function startTelegramLongPolling(): Promise<void> {
  if (!telegramBotToken) {
    console.log("TELEGRAM_BOT_TOKEN is not configured. Telegram polling is disabled.");
    return;
  }

  let webhookCleared = false;

  while (!isShuttingDown) {
    try {
      if (!webhookCleared) {
        await callTelegramApi("deleteWebhook", {
          drop_pending_updates: false
        });

        webhookCleared = true;
        console.log("Telegram long polling started");
      }

      const updates = await callTelegramApi<TelegramUpdate[]>(
        "getUpdates",
        {
          offset: nextTelegramUpdateId,
          timeout: telegramPollTimeoutSeconds,
          allowed_updates: ["message", "inline_query"]
        },
        telegramPollAbortController.signal
      );

      for (const update of updates) {
        if (typeof update.update_id === "number") {
          nextTelegramUpdateId = update.update_id + 1;
        }

        await handleTelegramUpdate(update);
      }
    } catch (error) {
      if (telegramPollAbortController.signal.aborted) {
        break;
      }

      console.error("Telegram long polling failed", error);
      await sleep(telegramPollRetryDelayMs);
    }
  }
}

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const parsedUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (method === "GET" && parsedUrl.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (method === "POST" && parsedUrl.pathname === "/messenger/dispatch") {
      await handleMessengerDispatch(request, response);
      return;
    }

    if (method === "POST" && parsedUrl.pathname === "/scheduler/trigger") {
      await handleSchedulerTrigger(request, response);
      return;
    }

    if (method === "POST" && parsedUrl.pathname === "/query") {
      await handleQueryRequest(request, response);
      return;
    }

    sendJson(response, 404, { error: "Not Found" });
  } catch (error) {
    console.error("Request handling failed", error);
    sendJson(response, 500, { error: "Internal Server Error" });
  }
});

// ---- Messenger inbound (from personal-assistant-watcher) ----

type MessengerResolution =
  | "staff"
  | "fallback_no_assignment"
  | "fallback_staff_deleted"
  | "fallback_lookup_failed";

type MessengerDispatchPayload = {
  event?: {
    id?: string;
    event_type?: string;
    source_id?: string;
    project_id?: string;
    purpose_id?: string;
    summary?: string;
    details?: string;
    emitted_by?: string;
    occurred_at?: string;
  };
  topic?: string;
  entity_kind?: "task" | "project";
  resolution?: MessengerResolution;
  task?: Record<string, unknown>;
  project?: Record<string, unknown>;
  staff?: Staff;
};

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function authorizeMessenger(request: IncomingMessage): boolean {
  if (!messengerInboundToken) return true;
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match !== null && match[1].trim() === messengerInboundToken;
}

async function handleMessengerDispatch(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!authorizeMessenger(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  let payload: MessengerDispatchPayload;
  try {
    payload = (await readJsonBody(request)) as MessengerDispatchPayload;
  } catch (error) {
    sendJson(response, 400, { error: `Invalid JSON: ${(error as Error).message}` });
    return;
  }

  const event = payload.event;
  const resolution = payload.resolution;
  if (!event || !resolution) {
    sendJson(response, 400, { error: "event and resolution are required" });
    return;
  }

  console.log("Messenger dispatch received", {
    event_id: event.id,
    event_type: event.event_type,
    topic: payload.topic,
    entity_kind: payload.entity_kind,
    resolution,
    staff_id: payload.staff?.id
  });

  // Acknowledge fast; the actual handling runs out-of-band so the watcher's
  // consumer loop is not blocked by an LLM round-trip.
  sendJson(response, 202, { accepted: true });

  void processMessengerDispatch(payload).catch((error) => {
    console.error("Messenger dispatch processing failed", error);
  });
}

async function processMessengerDispatch(payload: MessengerDispatchPayload): Promise<void> {
  const event = payload.event!;
  const resolution = payload.resolution!;
  const summary = describeEvent(payload);

  if (resolution === "staff" && payload.staff) {
    if (!piModel) {
      console.warn("Messenger 'staff' dispatch arrived but pi-mono is not initialized; dropping.");
      return;
    }
    try {
      const toolsManifest = await readToolsManifestFile();
      const result = await runStaffSession(payload.staff, summary, {
        model: piModel,
        authStorage: piAuthStorage!,
        modelRegistry: piModelRegistry!,
        staffTools: piStaffSubagentTools,
        workspaceRoot,
        toolsManifest
      });
      await deliverAutonomousMessage(
        `[${result.staff.name} (${result.staff.area_of_focus})]\n${result.text}`
      );
    } catch (error) {
      console.error("Staff session failed for messenger dispatch", error);
      await deliverAutonomousMessage(
        `Staff ${payload.staff.name} could not handle the event: ${(error as Error).message}`
      );
    }
    return;
  }

  // All fallback resolutions go to the user's main chat session, where the
  // LLM has staff_list / staff_create / staff_delegate available and can
  // decide whether to mint a new staff or handle the request directly.
  if (defaultTelegramChatId === undefined) {
    console.warn(
      "Messenger fallback received but DEFAULT_TELEGRAM_CHAT_ID is not set; dropping.",
      { resolution, event_id: event.id }
    );
    return;
  }

  const fallbackPrompt = composeFallbackPrompt(payload);
  try {
    const reply = await generateAssistantReply(defaultTelegramChatId, fallbackPrompt);
    for (const chunk of chunkTelegramMessage(reply)) {
      await callTelegramApi("sendMessage", {
        chat_id: defaultTelegramChatId,
        text: chunk
      });
    }
  } catch (error) {
    console.error("Messenger fallback reply failed", error);
  }
}

// ---- Scheduler trigger inbound (from notes scheduler) ----
//
// The notes service runs a script on a cron, which POSTs here to wake the
// bot. Two flows are supported:
//   1. With staff_id: instantiate that staff member with the given request
//      and post the result to DEFAULT_TELEGRAM_CHAT_ID. Used for "every
//      morning a staff member checks X" workflows.
//   2. Without staff_id: feed the request to the user's main chat session
//      so the LLM can decide whether to mint a staff member or handle
//      the request directly. Behaves like a synthetic user message.

type SchedulerTriggerPayload = {
  // Human-readable description of why this fired (logged + included in
  // the LLM prompt). Recommended.
  description?: string;
  // If set, the bot wakes that specific staff member. Looked up via the
  // missions client. If the staff doesn't exist, the request falls back
  // to the main chat session like flow #2 above.
  staff_id?: string;
  // The request to hand to the staff (or the main chat). Required.
  request?: string;
  // Optional schedule id, logged so audits can correlate.
  schedule_id?: string;
};

function authorizeSchedulerTrigger(request: IncomingMessage): boolean {
  if (!schedulerTriggerToken) return true;
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match !== null && match[1].trim() === schedulerTriggerToken;
}

async function handleSchedulerTrigger(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!authorizeSchedulerTrigger(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  let payload: SchedulerTriggerPayload;
  try {
    payload = (await readJsonBody(request)) as SchedulerTriggerPayload;
  } catch (error) {
    sendJson(response, 400, { error: `Invalid JSON: ${(error as Error).message}` });
    return;
  }

  const requestText = payload.request?.trim();
  if (!requestText) {
    sendJson(response, 400, { error: "request is required" });
    return;
  }

  console.log("Scheduler trigger received", {
    schedule_id: payload.schedule_id,
    staff_id: payload.staff_id,
    description: payload.description
  });

  sendJson(response, 202, { accepted: true });

  void processSchedulerTrigger(payload, requestText).catch((error) => {
    console.error("Scheduler trigger processing failed", error);
  });
}

async function processSchedulerTrigger(
  payload: SchedulerTriggerPayload,
  requestText: string
): Promise<void> {
  const header = payload.description
    ? `Scheduled trigger: ${payload.description}`
    : "Scheduled trigger";

  // Flow #1: explicit staff_id -> ephemeral staff session, post result.
  if (payload.staff_id && missionsClient && piModel) {
    try {
      const staff = await missionsClient.getStaff(payload.staff_id);
      const toolsManifest = await readToolsManifestFile();
      const result = await runStaffSession(staff, requestText, {
        model: piModel,
        authStorage: piAuthStorage!,
        modelRegistry: piModelRegistry!,
        staffTools: piStaffSubagentTools,
        workspaceRoot,
        toolsManifest
      });
      await deliverAutonomousMessage(
        `[${result.staff.name} (${result.staff.area_of_focus})] ${header}\n${result.text}`
      );
      return;
    } catch (error) {
      console.error("Scheduler staff session failed; falling back to main chat", error);
      // Fall through to flow #2.
    }
  }

  // Flow #2: synthesize a user message into the main chat session.
  if (defaultTelegramChatId === undefined) {
    console.warn(
      "Scheduler trigger received but DEFAULT_TELEGRAM_CHAT_ID is not set; dropping.",
      { schedule_id: payload.schedule_id }
    );
    return;
  }

  const synthesized =
    `${header}\n\n` +
    `(This message was generated by the notes scheduler, not by the user. Decide ` +
    `whether to delegate to an existing staff member, mint a new one, or handle ` +
    `directly. Respond as you normally would for a request of this shape.)\n\n` +
    `Request: ${requestText}`;

  try {
    const reply = await generateAssistantReply(defaultTelegramChatId, synthesized);
    for (const chunk of chunkTelegramMessage(reply)) {
      await callTelegramApi("sendMessage", {
        chat_id: defaultTelegramChatId,
        text: chunk
      });
    }
  } catch (error) {
    console.error("Scheduler trigger main-chat reply failed", error);
  }
}

function describeEvent(payload: MessengerDispatchPayload): string {
  const event = payload.event!;
  const lines: string[] = [];
  lines.push(`event_type=${event.event_type ?? "?"}`);
  lines.push(`entity_kind=${payload.entity_kind ?? "?"}`);
  lines.push(`source_id=${event.source_id ?? "?"}`);
  if (event.project_id) lines.push(`project_id=${event.project_id}`);
  if (event.purpose_id) lines.push(`purpose_id=${event.purpose_id}`);
  if (event.emitted_by) lines.push(`emitted_by=${event.emitted_by}`);
  if (event.occurred_at) lines.push(`occurred_at=${event.occurred_at}`);
  const summary = (event.summary ?? "").trim();
  const details = (event.details ?? "").trim();
  const head = lines.join(", ");
  return [
    head,
    summary ? `\nSummary: ${summary}` : "",
    details ? `\nDetails: ${details}` : ""
  ]
    .join("")
    .trim();
}

function composeFallbackPrompt(payload: MessengerDispatchPayload): string {
  const reason =
    payload.resolution === "fallback_no_assignment"
      ? "No staff member is assigned to this event."
      : payload.resolution === "fallback_staff_deleted"
        ? "The previously assigned staff member no longer exists."
        : "The watcher could not look up the assigned staff member.";

  return (
    `An autonomous event arrived from the watcher and needs handling.\n` +
    `${reason} Decide whether to mint a new staff member (staff_create) and delegate ` +
    `(staff_delegate), or handle the request yourself. If you choose to delegate, list ` +
    `existing staff first via staff_list to avoid duplicates.\n\n` +
    `--- Event ---\n` +
    describeEvent(payload)
  );
}

async function deliverAutonomousMessage(text: string): Promise<void> {
  if (defaultTelegramChatId === undefined) {
    console.log("Autonomous message dropped (no DEFAULT_TELEGRAM_CHAT_ID):", text);
    return;
  }
  if (!telegramBotToken) {
    console.log("Autonomous message dropped (no TELEGRAM_BOT_TOKEN):", text);
    return;
  }
  for (const chunk of chunkTelegramMessage(text)) {
    await callTelegramApi("sendMessage", {
      chat_id: defaultTelegramChatId,
      text: chunk
    });
  }
}

// ---- Local /query endpoint (no Telegram) ----
//
// Default chat id used by /query when the caller does not supply one. Negative
// so it cannot collide with a real Telegram chat id (Telegram chat ids are
// non-negative integers for users and large negatives for groups; -1 is
// reserved here as the local-test sentinel).
const QUERY_DEFAULT_CHAT_ID = -1;

// Request body shape for POST /query. Only `text` is required.
type QueryRequestBody = {
  text?: unknown;
  chatId?: unknown;
};

// handleQueryRequest is the local-test surface for the assistant: it bypasses
// Telegram entirely and exercises the same `generateAssistantReply` path the
// Telegram handler uses. Useful for smoke tests on this machine without
// configuring TELEGRAM_BOT_TOKEN or proxying webhook traffic.
async function handleQueryRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: `invalid JSON body: ${(error as Error).message}` });
    return;
  }

  const parsed = body as QueryRequestBody;
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    sendJson(response, 400, { error: "field 'text' must be a non-empty string" });
    return;
  }

  let chatId: number = QUERY_DEFAULT_CHAT_ID;
  if (typeof parsed.chatId === "number" && Number.isFinite(parsed.chatId)) {
    chatId = Math.trunc(parsed.chatId);
  } else if (parsed.chatId !== undefined) {
    sendJson(response, 400, { error: "field 'chatId' must be a number when provided" });
    return;
  }

  if (!piModel) {
    sendJson(response, 503, {
      error:
        "assistant not initialized: set LLM_PROVIDER, LLM_MODEL (and LLM_BASE_URL/LLM_API_KEY for OpenAI-compatible providers) and restart"
    });
    return;
  }

  console.log("Local /query received", { chatId, length: text.length });

  try {
    const reply = await generateAssistantReply(chatId, text);
    sendJson(response, 200, { reply, chatId });
  } catch (error) {
    console.error("Local /query failed", error);
    sendJson(response, 502, { error: (error as Error).message });
  }
}

async function initializePiMono(): Promise<void> {
  if (!llmProvider || !llmModelId) {
    console.log(
      "LLM_PROVIDER or LLM_MODEL is not configured. The bot will reply with a static fallback message."
    );
    return;
  }

  piAuthStorage = AuthStorage.create();
  piModelRegistry = ModelRegistry.create(piAuthStorage);

  if (llmBaseUrl) {
    if (!llmApiKey) {
      console.error(
        "LLM_BASE_URL is set but LLM_API_KEY is missing. Custom OpenAI-compatible provider needs both."
      );
      return;
    }

    piModelRegistry.registerProvider(llmProvider, {
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      api: "openai-completions" satisfies Api,
      authHeader: true,
      models: [
        {
          id: llmModelId,
          name: llmModelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384
        }
      ]
    });

    console.log(
      `pi-mono custom provider registered: ${llmProvider} -> ${llmBaseUrl} (model=${llmModelId})`
    );
  }

  const model = piModelRegistry.find(llmProvider, llmModelId);
  if (!model) {
    console.error(
      `pi-mono model not found: provider='${llmProvider}', model='${llmModelId}'. Bot will reply with a static fallback message.`
    );
    return;
  }

  piModel = model;
  // Resource loader (and therefore the composed system prompt) is built fresh
  // per chat session in getOrCreatePiSession.

  if (missionsApiUrl) {
    missionsClient = new MissionsClient(missionsApiUrl);
    console.log(`Missions API client configured: ${missionsApiUrl}`);
  } else {
    console.log("MISSIONS_API_URL not set; staff_* and mission_* tools disabled.");
  }

  if (notesApiUrl) {
    notesClient = new NotesClient(notesApiUrl);
    console.log(`Notes API client configured: ${notesApiUrl}`);
  } else {
    console.log("NOTES_API_URL not set; schedule_* tools disabled.");
  }

  // Tools the staff sub-agent gets when delegated to. Built first so the
  // staff_delegate runner closes over a stable list without seeing its
  // own staff_* tools (would cause delegation recursion).
  piStaffSubagentTools = [
    ...createWebTools(),
    ...createGithubTools(),
    ...createVercelTools(),
    ...createRailwayTools(),
    ...createTravelTools(),
    ...createDevboxerTools(),
    ...createMissionTools(missionsClient),
    ...createSecretTools(missionsClient),
    ...createScheduleTools(notesClient),
    ...createEmailTools()
  ];

  const staffDelegateRunner = piModel
    ? async (staff: Staff, request: string): Promise<string> => {
        const toolsManifest = await readToolsManifestFile();
        const result = await runStaffSession(staff, request, {
          model: piModel!,
          authStorage: piAuthStorage!,
          modelRegistry: piModelRegistry!,
          staffTools: piStaffSubagentTools,
          workspaceRoot,
          toolsManifest
        });
        return result.text;
      }
    : undefined;

  piCustomTools = [
    ...piStaffSubagentTools,
    ...createStaffTools(missionsClient, staffDelegateRunner)
  ];
  if (piCustomTools.length > 0) {
    console.log(`pi-mono custom tools enabled: ${piCustomTools.map((t) => t.name).join(", ")}`);
  }

  // Image tools are constructed per-chat (need chatId) but we probe here so the
  // log line at startup tells the operator whether they will be available.
  const imageProbe = createImageTools(0);
  if (imageProbe.length > 0) {
    console.log(`pi-mono per-chat tools enabled: ${imageProbe.map((t) => t.name).join(", ")}`);
  } else if (!process.env.OPENAI_IMAGE_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY/OPENAI_IMAGE_API_KEY not set; generate_image tool disabled.");
  }

  console.log(`pi-mono ready (provider=${llmProvider}, model=${llmModelId})`);
}

async function getOrCreatePiSession(chatId: number): Promise<AgentSession | undefined> {
  if (!piModel || !piAuthStorage || !piModelRegistry) {
    return undefined;
  }

  let session = piSessions.get(chatId);
  if (!session) {
    const chatWorkspace = resolvePath(workspaceRoot, String(chatId));
    await mkdir(chatWorkspace, { recursive: true });

    // Compose SYSTEM.md + TOOLS.md fresh from disk so operator edits land at
    // the next new-chat session without bot restart. Existing cached sessions
    // keep their prompt; clear piSessions or restart to refresh those.
    const composed = await composeAgentSystemPrompt();
    const chatResourceLoader = new DefaultResourceLoader({
      cwd: chatWorkspace,
      agentDir: getAgentDir(),
      systemPrompt: composed.prompt
    });
    await chatResourceLoader.reload();

    const chatCustomTools = [...piCustomTools, ...createImageTools(chatId)];
    // pi-mono treats `tools` as an allowlist that ALSO filters customTools.
    // We must include every custom tool name here, otherwise pi-mono drops
    // them from the registry and the LLM never sees their schemas.
    const allowedToolNames = [
      "read",
      "write",
      "edit",
      ...chatCustomTools.map((t) => t.name)
    ];

    const result = await createAgentSession({
      model: piModel,
      authStorage: piAuthStorage,
      modelRegistry: piModelRegistry,
      resourceLoader: chatResourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      customTools: chatCustomTools,
      // Per-chat working directory for the read/write/edit tools.
      cwd: chatWorkspace,
      // Allowlist: built-in read/write/edit + every custom tool.
      // bash/grep/find/ls intentionally excluded.
      tools: allowedToolNames
    });
    session = result.session;
    const activeNames = session.getActiveToolNames();
    console.log(`[pi:${chatId}] session ready, active tools (${activeNames.length}): ${activeNames.join(", ")}`);
    session.subscribe((event) => {
      // Log a compact, useful subset; ignore noisy per-token streaming events.
      switch (event.type) {
        case "agent_start":
        case "agent_end":
        case "turn_start":
        case "message_start":
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
          console.log(`[pi:${chatId}] ${event.type}`);
          break;
        case "message_end": {
          const msg = event.message;
          if (msg.role === "assistant") {
            const stop = msg.stopReason;
            console.log(
              `[pi:${chatId}] message_end role=assistant stop=${stop ?? "ok"}` +
                (msg.errorMessage ? ` err=${msg.errorMessage}` : "")
            );
          }
          break;
        }
        default:
          break;
      }
    });
    piSessions.set(chatId, session);
  }

  return session;
}

async function generateAssistantReply(chatId: number, text: string): Promise<string> {
  const session = await getOrCreatePiSession(chatId);
  if (!session) {
    return "hello";
  }

  await session.prompt(text);

  // pi-mono reports LLM errors on the last assistant message rather than throwing.
  const messages = session.messages;
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    if (last.stopReason === "error" || last.stopReason === "aborted") {
      throw new Error(last.errorMessage ?? `Request ${last.stopReason}`);
    }
  }

  return session.getLastAssistantText()?.trim() || "(no response)";
}

function chunkTelegramMessage(text: string): string[] {
  if (text.length <= telegramMaxMessageChars) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += telegramMaxMessageChars) {
    chunks.push(text.slice(index, index + telegramMaxMessageChars));
  }

  return chunks;
}

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  void mkdir(workspaceRoot, { recursive: true })
    .then(() => validateAgentPrompts())
    .then(() => initializePiMono())
    .then(() => {
      void startTelegramLongPolling();
    })
    .catch((error: unknown) => {
      console.error(`Startup failed: ${(error as Error).message}`);
      process.exit(1);
    });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    isShuttingDown = true;
    telegramPollAbortController.abort();
    for (const session of piSessions.values()) {
      session.dispose();
    }
    piSessions.clear();
    server.close();
  });
}
