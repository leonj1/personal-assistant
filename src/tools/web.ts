import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const JINA_READER_URL = "https://r.jina.ai/";

const exaSearchParams = Type.Object({
  query: Type.String({ description: "Search query in plain language." }),
  numResults: Type.Optional(
    Type.Integer({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10
    })
  )
});

type ExaResult = {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
};

function buildExaSearchTool(apiKey: string): ToolDefinition {
  return defineTool({
    name: "web_search",
    label: "Web search (Exa)",
    description:
      "Search the public web with Exa. Returns titles, URLs, and short snippets. Use this to find information that might not be in the model's training data, or to discover URLs that can then be fetched with web_fetch for full content.",
    promptSnippet:
      "web_search: search the web (Exa). Args: query, numResults (1-10, default 5).",
    parameters: exaSearchParams,
    async execute(_id, params: Static<typeof exaSearchParams>, signal) {
      const { query } = params;
      const numResults = params.numResults ?? 5;
      const response = await fetch(EXA_SEARCH_URL, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify({
          query,
          numResults,
          useAutoprompt: true,
          contents: { text: { maxCharacters: 800 } }
        })
      });

      if (!response.ok) {
        throw new Error(
          `Exa search failed: ${response.status} ${await response.text().catch(() => response.statusText)}`
        );
      }

      const data = (await response.json()) as { results?: ExaResult[] };
      const results = data.results ?? [];
      const text = results.length
        ? results
            .map((r, i) => {
              const title = r.title?.trim() || "(untitled)";
              const url = r.url ?? "";
              const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
              const snippet = (r.text ?? "").trim().replace(/\s+/g, " ").slice(0, 600);
              return `${i + 1}. ${title}${date}\n${url}\n${snippet}`;
            })
            .join("\n\n")
        : `No results for "${query}".`;

      return {
        content: [{ type: "text", text }],
        details: { query, numResults, count: results.length }
      };
    }
  });
}

const webFetchParams = Type.Object({
  url: Type.String({
    description: "Absolute http(s) URL to fetch and convert to readable Markdown."
  }),
  maxChars: Type.Optional(
    Type.Integer({
      description: "Maximum characters of body to return (default 8000, hard cap 30000).",
      minimum: 200,
      maximum: 30000
    })
  )
});

function buildWebFetchTool(): ToolDefinition {
  return defineTool({
    name: "web_fetch",
    label: "Fetch web page",
    description:
      "Fetch a URL and return the page as readable Markdown via Jina Reader. Use this after web_search to read the full contents of a result. Long pages are truncated; raise maxChars only when needed.",
    promptSnippet:
      "web_fetch: fetch URL as Markdown (Jina Reader). Args: url, maxChars (default 8000).",
    parameters: webFetchParams,
    async execute(_id, params: Static<typeof webFetchParams>, signal) {
      const { url } = params;
      const maxChars = params.maxChars ?? 8000;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Only http(s) URLs are supported, got: ${parsed.protocol}`);
      }

      const response = await fetch(`${JINA_READER_URL}${parsed.toString()}`, {
        method: "GET",
        signal,
        headers: {
          Accept: "text/plain",
          "X-Return-Format": "markdown"
        }
      });

      if (!response.ok) {
        throw new Error(
          `web_fetch failed: ${response.status} ${await response.text().catch(() => response.statusText)}`
        );
      }

      let body = await response.text();
      const truncated = body.length > maxChars;
      if (truncated) {
        body = `${body.slice(0, maxChars)}\n\n[... truncated, ${body.length - maxChars} more chars ...]`;
      }

      return {
        content: [{ type: "text", text: body }],
        details: { url: parsed.toString(), bytes: body.length, truncated }
      };
    }
  });
}

/**
 * Build the web-tool set. Tools whose required env vars are missing are silently omitted
 * so the agent never sees a broken tool in its prompt.
 */
export function createWebTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  const exaKey = process.env.EXA_API_KEY?.trim();
  if (exaKey) {
    tools.push(buildExaSearchTool(exaKey));
  } else {
    console.log("EXA_API_KEY not set; web_search tool disabled.");
  }

  // Jina Reader is keyless for low volume.
  tools.push(buildWebFetchTool());

  return tools;
}
