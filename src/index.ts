import { createServer, type ServerResponse } from "node:http";
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
let piSystemPrompt = "";

async function loadSystemPrompt(): Promise<void> {
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
  piSystemPrompt = trimmed;
  console.log(`System prompt loaded from ${systemPromptPath} (${trimmed.length} chars).`);
}

let nextTelegramUpdateId = 0;
let isShuttingDown = false;
const telegramPollAbortController = new AbortController();

const piSessions = new Map<number, AgentSession>();
let piAuthStorage: AuthStorage | undefined;
let piModelRegistry: ModelRegistry | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let piModel: Model<any> | undefined;
let piResourceLoader: DefaultResourceLoader | undefined;
let piCustomTools: ToolDefinition[] = [];

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

    sendJson(response, 404, { error: "Not Found" });
  } catch (error) {
    console.error("Request handling failed", error);
    sendJson(response, 500, { error: "Internal Server Error" });
  }
});

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
  piResourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPrompt: piSystemPrompt
  });
  await piResourceLoader.reload();

  piCustomTools = [
    ...createWebTools(),
    ...createGithubTools(),
    ...createVercelTools(),
    ...createRailwayTools(),
    ...createTravelTools(),
    ...createDevboxerTools()
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
  if (!piModel || !piAuthStorage || !piModelRegistry || !piResourceLoader) {
    return undefined;
  }

  let session = piSessions.get(chatId);
  if (!session) {
    const chatWorkspace = resolvePath(workspaceRoot, String(chatId));
    await mkdir(chatWorkspace, { recursive: true });

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
      resourceLoader: piResourceLoader,
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
    .then(() => loadSystemPrompt())
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
