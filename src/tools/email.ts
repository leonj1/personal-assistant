// Email tool — minimal text-only sender, supporting Mailtrap or Resend.
//
// The bot only needs to send transactional notifications ("the page changed",
// "your flight watch triggered"), so a one-call HTTP client per provider is
// enough — no folders, threading, or reply handling.
//
// Provider selection (auto, by env):
//   1. MAILTRAP_API_KEY set  -> Mailtrap "Email Sending" API
//      (https://send.api.mailtrap.io/api/send). Optionally
//      MAILTRAP_API_URL to override (e.g. the sandbox endpoint
//      https://sandbox.api.mailtrap.io/api/send/<inbox_id>).
//   2. RESEND_API_KEY set    -> Resend (https://api.resend.com/emails).
//   3. Neither               -> tool disabled, omitted from the registered
//                                toolset.
//
// EMAIL_FROM is the default From address used when the LLM omits `from`.
// Both providers require the From address to be on a domain you've verified
// with them. Format: either a bare address ("bot@your-domain.com") or
// "Name <bot@your-domain.com>". The Mailtrap backend parses the latter and
// translates to its `{email, name}` JSON shape; Resend accepts the string
// form directly.
//
// If EMAIL_FROM is missing, the LLM MUST pass `from` on every call (the tool
// surfaces a clear validation error rather than silently failing).

import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const RESEND_URL = "https://api.resend.com/emails";
const MAILTRAP_URL_DEFAULT = "https://send.api.mailtrap.io/api/send";

const emailSendParams = Type.Object({
  to: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
    description:
      "Recipient email address(es). Can be a single string or an array. Most providers cap arrays around 50-1000 recipients per send."
  }),
  subject: Type.String({
    description:
      "Subject line. Keep it short and concrete — a notification with a vague subject is more likely to be flagged as spam."
  }),
  text: Type.String({
    description:
      "Plain-text body. The bot deliberately does not expose an html parameter — keep it simple and readable. If you have a URL, paste it on its own line."
  }),
  from: Type.Optional(
    Type.String({
      description:
        "Override the From address. Default is the EMAIL_FROM env var (typically 'Personal Assistant <bot@your-domain.com>'). Must be on a domain you've verified with the configured provider, or the send will fail."
    })
  ),
  reply_to: Type.Optional(
    Type.String({
      description:
        "Optional Reply-To address. Useful when the From is a no-reply alias but the user might want to respond."
    })
  )
});

type EmailParams = Static<typeof emailSendParams>;

type EmailResult = {
  /** Best-effort message identifier from the provider, or "(unknown)". */
  id: string;
  /** Provider name shown to the LLM in the success summary. */
  provider: "mailtrap" | "resend";
};

/** Backend-specific transport. Each backend is responsible for translating
 *  the shared EmailParams shape into the provider's wire format and parsing
 *  the response. Errors are thrown with a descriptive message; success
 *  returns the message id and provider tag. */
type Backend = {
  name: "mailtrap" | "resend";
  send(params: EmailParams, defaultFrom: string | undefined, signal?: AbortSignal): Promise<EmailResult>;
};

// ---- Address parsing (shared) ------------------------------------------------

type ParsedAddress = { email: string; name?: string };

/** Parse "Name <addr@x.com>" or "addr@x.com" into {email, name?}.
 *  Throws if the input has no plausible @-address. */
export function parseAddress(input: string): ParsedAddress {
  const trimmed = input.trim();
  // RFC 5322 is famously hard; we only need the two common shapes the LLM
  // will produce.
  const angled = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(trimmed);
  if (angled) {
    const name = angled[1].trim().replace(/^"|"$/g, "");
    return name ? { email: angled[2], name } : { email: angled[2] };
  }
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(trimmed)) {
    throw new Error(`Invalid email address: '${input}'.`);
  }
  return { email: trimmed };
}

function normalizeRecipients(to: EmailParams["to"]): string[] {
  const list = Array.isArray(to) ? to : [to];
  if (list.length === 0) {
    throw new Error("`to` must contain at least one recipient.");
  }
  return list;
}

function resolveFrom(params: EmailParams, defaultFrom: string | undefined): string {
  const explicit = params.from?.trim();
  if (explicit) return explicit;
  if (defaultFrom?.trim()) return defaultFrom.trim();
  throw new Error(
    "No From address: pass `from` explicitly or set EMAIL_FROM in the bot's environment."
  );
}

// ---- Mailtrap backend --------------------------------------------------------

type MailtrapResponse = {
  success?: boolean;
  message_ids?: string[];
  errors?: string[] | string;
};

function buildMailtrapBackend(apiKey: string, url: string): Backend {
  return {
    name: "mailtrap",
    async send(params, defaultFrom, signal) {
      const recipients = normalizeRecipients(params.to);
      const fromParsed = parseAddress(resolveFrom(params, defaultFrom));

      const body: Record<string, unknown> = {
        from: fromParsed,
        to: recipients.map((addr) => parseAddress(addr)),
        subject: params.subject,
        text: params.text
      };
      if (params.reply_to?.trim()) {
        // Mailtrap accepts reply_to either as object or array; we pick the
        // single-object form to mirror Resend's single-string `reply_to`.
        body.reply_to = parseAddress(params.reply_to.trim());
      }

      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      let parsed: MailtrapResponse | undefined;
      try {
        parsed = text ? (JSON.parse(text) as MailtrapResponse) : undefined;
      } catch {
        parsed = undefined;
      }

      if (!response.ok || parsed?.success === false || parsed?.errors) {
        const errors = parsed?.errors;
        const detail = Array.isArray(errors)
          ? errors.join("; ")
          : typeof errors === "string"
            ? errors
            : (text.slice(0, 300) || response.statusText);
        throw new Error(
          `email_send failed via Mailtrap: HTTP ${response.status} ${response.statusText} — ${detail}`
        );
      }

      const id = parsed?.message_ids?.[0] ?? "(unknown)";
      return { id, provider: "mailtrap" };
    }
  };
}

// ---- Resend backend ---------------------------------------------------------

type ResendResponse = {
  id?: string;
  message?: string;
  name?: string;
  statusCode?: number;
};

function buildResendBackend(apiKey: string): Backend {
  return {
    name: "resend",
    async send(params, defaultFrom, signal) {
      const recipients = normalizeRecipients(params.to);
      const from = resolveFrom(params, defaultFrom);

      const body: Record<string, unknown> = {
        from,
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
          `email_send failed via Resend: HTTP ${response.status} ${response.statusText} — ${detail}`
        );
      }

      return { id: parsed?.id ?? "(unknown)", provider: "resend" };
    }
  };
}

// ---- Tool definition --------------------------------------------------------

function buildEmailSendTool(backend: Backend, defaultFrom: string | undefined): ToolDefinition {
  const providerHint =
    backend.name === "mailtrap"
      ? "via Mailtrap (https://mailtrap.io)"
      : "via Resend (https://resend.com)";
  return defineTool({
    name: "email_send",
    label: "Send email",
    description:
      `Send a plain-text email ${providerHint}. Use for autonomous notifications ` +
      `(e.g. 'the watched page changed'), not for casual chat — Telegram is the ` +
      `primary surface. The From address must be on a domain you've verified with ` +
      `the configured provider; default is configured via EMAIL_FROM. Returns the ` +
      `provider's message id on success.`,
    promptSnippet:
      "email_send: send a plain-text email. Args: to (string or array), subject, text, from?, reply_to?.",
    parameters: emailSendParams,
    async execute(_id, params: EmailParams, signal) {
      const recipients = normalizeRecipients(params.to);
      // Per-call audit log so operators can confirm which path actually fired
      // (main session vs. delegated staff sub-agent) when debugging delivery.
      console.log(
        `[email_send] -> ${backend.name} to=${JSON.stringify(recipients)} ` +
          `subject=${JSON.stringify(params.subject)} ` +
          `from=${JSON.stringify(params.from?.trim() || defaultFrom || "(unset)")}`
      );
      let result: EmailResult;
      try {
        result = await backend.send(params, defaultFrom, signal);
      } catch (err) {
        console.log(
          `[email_send] ${backend.name} send FAILED: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
      console.log(`[email_send] ${backend.name} send OK id=${result.id}`);
      const summary =
        `Sent email '${params.subject}' to ${recipients.join(", ")} ` +
        `via ${result.provider} (id=${result.id}).`;
      return {
        content: [{ type: "text", text: summary }],
        details: {
          id: result.id,
          provider: result.provider,
          to: recipients,
          subject: params.subject,
          from: params.from?.trim() || defaultFrom
        }
      };
    }
  });
}

/** Build the email tool. Picks Mailtrap if MAILTRAP_API_KEY is set, otherwise
 *  Resend if RESEND_API_KEY is set, otherwise returns []. The chosen provider
 *  and the resolved default-From are logged at registration so operators can
 *  see at a glance which backend the bot will use. */
export function createEmailTools(): ToolDefinition[] {
  const mailtrapKey = process.env.MAILTRAP_API_KEY?.trim();
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const defaultFromRaw = process.env.EMAIL_FROM?.trim();
  const defaultFrom = defaultFromRaw || undefined;

  let backend: Backend | undefined;
  if (mailtrapKey) {
    const url = process.env.MAILTRAP_API_URL?.trim() || MAILTRAP_URL_DEFAULT;
    backend = buildMailtrapBackend(mailtrapKey, url);
    console.log(
      `email_send tool enabled via Mailtrap (url=${url}, default_from=${defaultFrom ?? "(unset)"}).`
    );
  } else if (resendKey) {
    backend = buildResendBackend(resendKey);
    console.log(
      `email_send tool enabled via Resend (default_from=${defaultFrom ?? "(unset)"}).`
    );
  } else {
    console.log(
      "Neither MAILTRAP_API_KEY nor RESEND_API_KEY set; email_send tool disabled."
    );
    return [];
  }

  // EMAIL_FROM is recommended but not required: when the LLM passes `from`
  // explicitly the tool still works. We log a soft warning so operators know
  // they're forcing the LLM to remember a From address on every call.
  if (!defaultFrom) {
    console.log(
      "EMAIL_FROM not set; email_send will require a `from` argument on every call."
    );
  }

  return [buildEmailSendTool(backend, defaultFrom)];
}
