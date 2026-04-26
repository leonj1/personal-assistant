import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

const port = Number(process.env.PORT ?? 3000);
const telegramWebhookPath = process.env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook";
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramEchoMessages = process.env.TELEGRAM_ECHO_MESSAGES === "true";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody) as unknown;
}

async function callTelegramApi(method: string, payload: Record<string, unknown>): Promise<void> {
  if (!telegramBotToken) {
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API ${method} failed: ${response.status} ${errorText}`);
  }
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

    if (telegramEchoMessages && chatId && telegramBotToken) {
      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: `Received: ${messageText}`
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

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const parsedUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (method === "GET" && parsedUrl.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (method === "POST" && parsedUrl.pathname === telegramWebhookPath) {
      if (
        telegramWebhookSecret &&
        request.headers["x-telegram-bot-api-secret-token"] !== telegramWebhookSecret
      ) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const body = await readJsonBody(request);
      await handleTelegramUpdate(body as TelegramUpdate);
      sendJson(response, 200, { ok: true });
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
  console.log(`Telegram webhook endpoint available at ${telegramWebhookPath}`);
});
