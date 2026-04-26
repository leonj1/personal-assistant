import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const TELEGRAM_API_BASE = "https://api.telegram.org";

const imageModel = process.env.OPENAI_IMAGE_MODEL?.trim() || "dall-e-3";

const generateImageParams = Type.Object({
  prompt: Type.String({
    description:
      "Detailed description of the image to generate. Be specific about subject, style, lighting, and composition."
  }),
  size: Type.Optional(
    Type.Union(
      [
        Type.Literal("1024x1024"),
        Type.Literal("1024x1792"),
        Type.Literal("1792x1024")
      ],
      { description: "Output dimensions. Default 1024x1024 (square)." }
    )
  ),
  quality: Type.Optional(
    Type.Union([Type.Literal("standard"), Type.Literal("hd")], {
      description: "Image quality. 'hd' costs more. Default 'standard'."
    })
  ),
  style: Type.Optional(
    Type.Union([Type.Literal("vivid"), Type.Literal("natural")], {
      description: "Visual style. 'vivid' is more saturated/dramatic. Default 'vivid'."
    })
  ),
  caption: Type.Optional(
    Type.String({
      description:
        "Optional caption to send alongside the photo on Telegram (max 1024 chars)."
    })
  )
});

type OpenAiImageResponse = {
  data?: Array<{ url?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

function buildGenerateImageTool(
  apiKey: string,
  telegramBotToken: string,
  chatId: number
): ToolDefinition {
  return defineTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image with OpenAI Images and send it to the Telegram chat as a photo. Returns a short confirmation; the user already sees the image.",
    promptSnippet:
      "generate_image: create an image (OpenAI) and send it to the chat. Args: prompt, size, quality, style, caption.",
    parameters: generateImageParams,
    async execute(_id, params: Static<typeof generateImageParams>, signal) {
      const { prompt } = params;
      const size = params.size ?? "1024x1024";
      const quality = params.quality ?? "standard";
      const style = params.style ?? "vivid";
      const caption = params.caption?.slice(0, 1024);

      // 1. Generate the image.
      const genResponse = await fetch(OPENAI_IMAGES_URL, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: imageModel,
          prompt,
          n: 1,
          size,
          quality,
          style,
          response_format: "url"
        })
      });

      const genJson = (await genResponse.json().catch(() => ({}))) as OpenAiImageResponse;
      if (!genResponse.ok) {
        throw new Error(
          `Image generation failed: ${genResponse.status} ${genJson.error?.message ?? genResponse.statusText}`
        );
      }
      const imageUrl = genJson.data?.[0]?.url;
      if (!imageUrl) {
        throw new Error("Image generation succeeded but returned no URL.");
      }
      const revisedPrompt = genJson.data?.[0]?.revised_prompt;

      // 2. Forward to Telegram. URL form: api accepts public URLs directly via 'photo'.
      const sendResponse = await fetch(
        `${TELEGRAM_API_BASE}/bot${telegramBotToken}/sendPhoto`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            chat_id: chatId,
            photo: imageUrl,
            caption
          })
        }
      );
      const sendJson = (await sendResponse.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
      };
      if (!sendResponse.ok || !sendJson.ok) {
        throw new Error(
          `sendPhoto failed: ${sendResponse.status} ${sendJson.description ?? sendResponse.statusText}`
        );
      }

      const confirmation = `Sent image to chat (${size}, ${quality}, ${style}).` +
        (revisedPrompt ? ` Revised prompt: ${revisedPrompt}` : "");

      return {
        content: [{ type: "text", text: confirmation }],
        details: { size, quality, style, revisedPrompt, imageUrl }
      };
    }
  });
}

/**
 * Build chatId-bound image tools. The tool sends the generated photo directly to
 * the Telegram chat via sendPhoto, so it must be constructed per session.
 */
export function createImageTools(chatId: number): ToolDefinition[] {
  const apiKey = process.env.OPENAI_IMAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!apiKey) {
    return [];
  }
  if (!telegramBotToken) {
    return [];
  }
  return [buildGenerateImageTool(apiKey, telegramBotToken, chatId)];
}
