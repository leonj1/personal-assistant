// Secret management tools.
//
// These tools let the bot (and staff sub-agents) inspect and write the
// secrets registry in personal-assistant-missions. The intended workflow is:
//
//   1. The bot or a staff sub-agent decides it needs a credential
//      (e.g. EXA_API_KEY).
//   2. It calls `secret_list` to see whether the user has already provided
//      a secret with that name. The list intentionally exposes only names
//      and timestamps — *never* values — so credentials never enter the
//      LLM's context window from a list call.
//   3. If missing, the bot asks the user for the value, then calls
//      `secret_create` (or `secret_update` if the name already exists).
//   4. `secret_delete` removes a secret when no longer needed.
//
// IMPORTANT contract: there is intentionally no `secret_get` tool. Reading
// a secret value would put it in the LLM's context (and therefore in the
// model provider's logs). The bot only needs to know which secrets *exist*;
// the actual values are consumed by tools that read process.env at runtime.
// If/when a "boot-time hydration" path is added (read DB → inject into
// process.env at process start), no LLM-facing read tool is needed for
// this either.
//
// Note also that writing a secret via `secret_create` or `secret_update`
// still flows the value through the LLM context for the duration of that
// call (because pi-mono passes tool args verbatim to the model). That is
// an inherent property of any LLM-driven write path; it's the cost of
// letting the bot manage credentials at all. Out-of-band writes (CLI,
// missions UI) remain available and recommended for long-lived secrets.
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { MissionsApiError, type MissionsClient } from "../missions.js";

// ---- secret_list ----
//
// Returns names + timestamps only. The `value` field from the missions API
// is dropped before the LLM sees the result.

const secretListParams = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description:
        "Maximum number of secret names to return. Defaults to 50 server-side; cap is 200."
    })
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Pagination offset. Defaults to 0."
    })
  )
});

function buildSecretListTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "secret_list",
    label: "List secrets",
    description:
      "List the names of secrets stored in the missions API. Returns each secret's name and creation timestamp ONLY — values are never exposed to this tool by design. Use this to find out what credentials the user has already provided so you can avoid asking for them again, or to discover what is missing before delegating to a staff member.",
    promptSnippet:
      "secret_list: list secret NAMES (no values) the user has stored. Args: limit?, offset?.",
    parameters: secretListParams,
    async execute(_id, params: Static<typeof secretListParams>, signal) {
      const result = await client.listSecrets(
        { limit: params.limit, offset: params.offset },
        signal
      );

      // Strip values before the LLM sees the result. We keep the same field
      // shape the API uses so the model isn't surprised by missing keys.
      const safeItems = result.items.map((s) => ({
        name: s.name,
        created_at: s.created_at
      }));

      const text = safeItems.length
        ? `Found ${result.total} secret(s) total; showing ${safeItems.length}:\n` +
          safeItems.map((s) => `- ${s.name} (created ${s.created_at})`).join("\n")
        : "No secrets stored. Ask the user for any credentials you need.";

      return {
        content: [{ type: "text", text }],
        details: { count: safeItems.length, total: result.total, items: safeItems }
      };
    }
  });
}

// ---- secret_create ----

const secretCreateParams = Type.Object({
  name: Type.String({
    description:
      "Unique secret name. Conventionally uppercase with underscores (e.g. 'EXA_API_KEY', 'STRIPE_TOKEN'). Must not already exist; call secret_list first to check, or use secret_update to change an existing value."
  }),
  value: Type.String({
    description:
      "The secret value to store. Anything the user provided. Will be persisted as-is."
  })
});

function buildSecretCreateTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "secret_create",
    label: "Create secret",
    description:
      "Persist a new secret (credential, API key, token) into the missions secrets registry. Use this when the user has just provided a credential the assistant needs. Fails if a secret with the same name already exists — call secret_update in that case. The stored value will not be readable back through any LLM-facing tool; the bot deliberately has no `secret_get` tool.",
    promptSnippet:
      "secret_create: persist a new credential by name. Args: name (e.g. EXA_API_KEY), value.",
    parameters: secretCreateParams,
    async execute(_id, params: Static<typeof secretCreateParams>, signal) {
      try {
        const secret = await client.createSecret(
          { name: params.name, value: params.value },
          signal
        );
        // Echo only the name back to the LLM — never the value.
        return {
          content: [
            {
              type: "text",
              text: `Stored secret '${secret.name}' (created ${secret.created_at}).`
            }
          ],
          details: { name: secret.name, created_at: secret.created_at }
        };
      } catch (err) {
        // The missions API returns a uniqueness error from MySQL via the
        // service layer. Detect by message contents since the API does not
        // currently use a distinct status code.
        if (err instanceof MissionsApiError) {
          const lower = (err.body ?? "").toLowerCase();
          if (lower.includes("duplicate") || lower.includes("already")) {
            throw new Error(
              `Secret '${params.name}' already exists. Use secret_update to change its value, or pick a different name.`
            );
          }
        }
        throw err;
      }
    }
  });
}

// ---- secret_update ----

const secretUpdateParams = Type.Object({
  name: Type.String({
    description: "Existing secret name to update. The lookup is exact-match."
  }),
  value: Type.String({
    description:
      "New value to store. The previous value is overwritten and not recoverable."
  })
});

function buildSecretUpdateTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "secret_update",
    label: "Update secret",
    description:
      "Overwrite the value of an existing secret. Use this when the user provides a refreshed credential. The previous value is not recoverable. Fails with a 404-shaped error if no secret with that name exists; call secret_create instead.",
    promptSnippet:
      "secret_update: overwrite an existing credential's value. Args: name, value.",
    parameters: secretUpdateParams,
    async execute(_id, params: Static<typeof secretUpdateParams>, signal) {
      try {
        const secret = await client.updateSecret(
          params.name,
          { value: params.value },
          signal
        );
        return {
          content: [
            {
              type: "text",
              text: `Updated secret '${secret.name}'.`
            }
          ],
          details: { name: secret.name, created_at: secret.created_at }
        };
      } catch (err) {
        if (err instanceof MissionsApiError && err.status === 404) {
          throw new Error(
            `Secret '${params.name}' does not exist. Use secret_create to add it.`
          );
        }
        throw err;
      }
    }
  });
}

// ---- secret_delete ----

const secretDeleteParams = Type.Object({
  name: Type.String({
    description: "Secret name to delete."
  })
});

function buildSecretDeleteTool(client: MissionsClient): ToolDefinition {
  return defineTool({
    name: "secret_delete",
    label: "Delete secret",
    description:
      "Remove a secret from the missions registry. Cascades through the mission_secrets join table — any mission that referenced this secret will see the name disappear from its `secrets` array. Idempotent in spirit but returns a 404-shaped error if the name is unknown.",
    promptSnippet: "secret_delete: remove a secret by name. Args: name.",
    parameters: secretDeleteParams,
    async execute(_id, params: Static<typeof secretDeleteParams>, signal) {
      try {
        await client.deleteSecret(params.name, signal);
        return {
          content: [{ type: "text", text: `Deleted secret '${params.name}'.` }],
          details: { name: params.name }
        };
      } catch (err) {
        if (err instanceof MissionsApiError && err.status === 404) {
          throw new Error(
            `Secret '${params.name}' does not exist; nothing to delete.`
          );
        }
        throw err;
      }
    }
  });
}

/**
 * Build the secret toolset. Returns an empty array when no missions client
 * is configured (i.e. `MISSIONS_API_URL` is unset), so the bot silently
 * omits the tools instead of registering broken stubs.
 */
export function createSecretTools(client: MissionsClient | undefined): ToolDefinition[] {
  if (!client) return [];
  return [
    buildSecretListTool(client),
    buildSecretCreateTool(client),
    buildSecretUpdateTool(client),
    buildSecretDeleteTool(client)
  ];
}
