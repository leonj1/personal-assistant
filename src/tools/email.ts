// Email tool — minimal text-only sender via Resend.
//
// We deliberately picked Resend (https://resend.com) for its tiny API
// surface: a single POST with bearer auth. The bot only needs to send
// transactional notifications ("the page changed", "your flight watch
// triggered"), so a one-call client is enough — no folders, threading,
// or reply handling.
//
// Required env vars:
//   RESEND_API_KEY  — bearer token from resend.com/api-keys
//   EMAIL_FROM      — default From address; can be overridden per-call
//
// If either is unset, the tool is omitted from the registered toolset
// (matching the existing web/travel/etc. convention) so the LLM doesn't
// see a broken tool in its prompt.

import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const RESEND_URL = "https://api.resend.com/emails";

const emailSendParams = Type.Object({
  to: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
    description:
      "Recipient email address(es). Can be a single string or an array. Resend caps the array at 50 recipients per send."
  }),
  subject: Type.String({
    description:
      "Subject line. Keep it short and concrete — a Resend-delivered notification with a vague subject is likely to be flagged as spam."
  }),
  text: Type.String({
    description:
      "Plain-text body. The bot deliberately does not expose an html parameter — keep it simple and readable. If you have a URL, paste it on its own line."
  }),
  from: Type.Optional(
    Type.String({
      description:
        "Override the From address. Default is the EMAIL_FROM env var (typically something like 'Personal Assistant <bot@your-domain.com>'). Must be on a domain verified in Resend, or the send will fail."
    })
  ),
  reply_to: Type.Optional(
    Type.String({
      description:
        "Optional Reply-To address. Useful when the From is a no-reply alias but the user might want to respond."
    })
  )
});

type ResendResponse = {
  id?: string;
  // On error Resend returns { name, message, statusCode }
  message?: string;
  name?: string;
  statusCode?: number;
};

function buildEmailSendTool(apiKey: string, defaultFrom: string): ToolDefinition {
  return defineTool({
    name: "email_send",
    label: "Send email",
    description:
      "Send a plain-text email via Resend. Use for autonomous notifications (e.g. 'the watched page changed'), not for casual chat — Telegram is the primary surface. The From address must be on a domain verified in Resend; default is configured via EMAIL_FROM. Returns the Resend message id on success.",
    promptSnippet:
      "email_send: send a plain-text email. Args: to (string or array), subject, text, from?, reply_to?.",
    parameters: emailSendParams,
    async execute(_id, params: Static<typeof emailSendParams>, signal) {
      const recipients = Array.isArray(params.to) ? params.to : [params.to];
      if (recipients.length === 0) {
        throw new Error("`to` must contain at least one recipient.");
      }

      const body: Record<string, unknown> = {
        from: params.from?.trim() || defaultFrom,
        to: recipients,
        subject: params.subject,
        text: params.text
      };
      if (params.reply_to?.trim()) body.reply_to = params.reply_to.trim();

      const response = await fetch(RESEND_URL, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      let parsed: ResendResponse | undefined;
      try {
        parsed = text ? (JSON.parse(text) as ResendResponse) : undefined;
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        const detail = parsed?.message ?? text.slice(0, 300) ?? response.statusText;
        throw new Error(
          `email_send failed: HTTP ${response.status} ${response.statusText} — ${detail}`
        );
      }

      const messageId = parsed?.id ?? "(unknown)";
      const summary = `Sent email '${params.subject}' to ${recipients.join(", ")} (id=${messageId}).`;
      return {
        content: [{ type: "text", text: summary }],
        details: {
          id: messageId,
          to: recipients,
          subject: params.subject,
          from: body.from
        }
      };
    }
  });
}

export function createEmailTools(): ToolDefinition[] {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const defaultFrom = process.env.EMAIL_FROM?.trim();

  if (!apiKey) {
    console.log("RESEND_API_KEY not set; email_send tool disabled.");
    return [];
  }
  if (!defaultFrom) {
    console.log(
      "EMAIL_FROM not set; email_send tool disabled (Resend requires a From address)."
    );
    return [];
  }
  return [buildEmailSendTool(apiKey, defaultFrom)];
}
