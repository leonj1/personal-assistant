import { createServer, type ServerResponse } from "node:http";

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
const telegramTypingDelayMs = 1200;
const telegramPollTimeoutSeconds = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? 30);
const telegramPollRetryDelayMs = Number(process.env.TELEGRAM_POLL_RETRY_DELAY_MS ?? 1000);

let nextTelegramUpdateId = 0;
let isShuttingDown = false;
const telegramPollAbortController = new AbortController();

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

      await sleep(telegramTypingDelayMs);

      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: "hello"
      });
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

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  void startTelegramLongPolling();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    isShuttingDown = true;
    telegramPollAbortController.abort();
    server.close();
  });
}
