import type {
  Env,
  ExplainRequest,
  ExplainResponse,
  ChatMessage,
  ParsedIntent,
  DomainConfig,
  ComponentConfig,
  TraceStep,
} from "./types";
import { parseIntent } from "./intent/parser";
import { createConnection } from "./db/connection";
import { getSchemaCache } from "./db/bootstrap";
import { resolvePageBlocks } from "./db/queries/page-builder";
import { resolveProductsByName } from "./db/queries/products";
import { traceBlock } from "./db/filter-chains/dispatch";
import { traceAtdwImport } from "./db/filter-chains/atdw";
import {
  generateExplanation,
  streamExplanation,
} from "./explain/generator";
import { retrieveContext } from "./knowledge/search";
import WIDGET_JS from "./widget.js.txt";

// CORS headers for chatbot frontends
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/health") {
      return withCors(
        Response.json({ status: "ok", timestamp: Date.now() })
      );
    }

    // Main endpoint
    if (url.pathname === "/api/explain" && request.method === "POST") {
      return withCors(await handleExplain(request, env, ctx));
    }

    // Streaming endpoint
    if (url.pathname === "/api/explain/stream" && request.method === "POST") {
      return withCors(await handleExplainStream(request, env, ctx));
    }

    // Resolve hostname to tenant (for widget auto-detection)
    if (url.pathname === "/api/resolve-tenant" && request.method === "POST") {
      const body = await parseRequestBody<{ hostname?: string }>(request);
      if (!body.hostname) {
        return withCors(Response.json({ error: "hostname required" }, { status: 400 }));
      }
      const tenant = await resolveTenantFromHostname(env, body.hostname);
      return withCors(Response.json({ hostname: body.hostname, tenant }));
    }

    // Widget JS - bundled with the worker
    if (url.pathname === "/widget.js") {
      return withCors(new Response(WIDGET_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      }));
    }

    // Schema cache refresh
    if (url.pathname === "/api/refresh-schema" && request.method === "POST") {
      const body = await parseRequestBody<{ tenant?: string }>(request);
      const tenant = body.tenant ?? env.DEFAULT_TENANT;
      await env.CACHE.delete(`schema:${tenant}`);
      return withCors(
        Response.json({ status: "cache_cleared", tenant })
      );
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * Parse and minimally validate a JSON request body.
 * Returns a typed object or throws a structured error.
 */
async function parseRequestBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new RequestError("Invalid JSON in request body", 400);
  }
}

function validateExplainRequest(body: unknown): ExplainRequest {
  if (!body || typeof body !== "object") {
    throw new RequestError("Request body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;
  if (typeof b.question !== "string" || b.question.trim().length === 0) {
    throw new RequestError("'question' is required and must be a non-empty string", 400);
  }
  // Validate history if present: array of {role, content} objects, capped at 20 turns
  const history = Array.isArray(b.history)
    ? (b.history as { role?: unknown; content?: unknown }[])
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20) // keep only the most recent 20 turns
        .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content) }))
    : undefined;

  return {
    question: b.question,
    tenant: typeof b.tenant === "string" ? b.tenant : undefined,
    hostname: typeof b.hostname === "string" ? b.hostname : undefined,
    pageUri: typeof b.pageUri === "string" ? b.pageUri : undefined,
    componentIndex: typeof b.componentIndex === "number" ? b.componentIndex : undefined,
    history: history && history.length > 0 ? history : undefined,
  };
}

class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "RequestError";
  }
}

// ---------------------------------------------------------------------------
// Hostname -> tenant resolution via ORIGINS KV (shared with roam-saas-customer)
// ---------------------------------------------------------------------------

/**
 * Look up a customer hostname in the ORIGINS KV to find the tenant.
 * KV key: `origin:{hostname}` -> value: `{tenant}.roamhq.io`
 * Returns null if not found.
 */
async function resolveTenantFromHostname(
  env: Env,
  hostname: string
): Promise<string | null> {
  const origin = await env.ORIGINS.get(`origin:${hostname}`);
  if (!origin) return null;
  // Extract tenant prefix: "vicheartland.roamhq.io" -> "vicheartland"
  const match = origin.match(/^([a-z0-9_-]+)\.roamhq\.io$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Shared: resolve intent, DB trace
// ---------------------------------------------------------------------------

interface ResolvedData {
  intent: ParsedIntent;
  config: DomainConfig | null;
  trace: TraceStep[];
  targetProductIds: number[];
  codeContext: string;
  history: ChatMessage[];
  timing: Record<string, number>;
}

async function resolveData(
  request: Request,
  env: Env
): Promise<ResolvedData> {
  const timing: Record<string, number> = {};
  let t0 = Date.now();

  const raw = await parseRequestBody<unknown>(request);
  const body = validateExplainRequest(raw);
  const history = body.history ?? [];

  // Resolve tenant: explicit tenant > hostname lookup > default
  let tenant = body.tenant;
  if (!tenant && body.hostname) {
    tenant = await resolveTenantFromHostname(env, body.hostname) ?? undefined;
  }
  tenant = tenant ?? env.DEFAULT_TENANT;

  // Parse intent
  const intent = await parseIntent(body.question, body.pageUri, env);
  timing.intent = Date.now() - t0;

  const componentType = intent.componentType;

  // Retrieve code context from AutoRAG (runs in parallel with DB work)
  const codeContextPromise = retrieveContext(env, intent);

  // Resolve entities via DB
  t0 = Date.now();
  const db = createConnection(env, tenant);

  try {
    const schema = await getSchemaCache(db, env.CACHE, tenant);

    // -----------------------------------------------------------------------
    // ATDW import domain - separate from page-builder path
    // -----------------------------------------------------------------------
    if (intent.domain === "atdw_import") {
      t0 = Date.now();
      const [atdwResult, codeContext] = await Promise.all([
        traceAtdwImport(db, schema, intent),
        codeContextPromise,
      ]);
      timing.filterChain = Date.now() - t0;

      return {
        intent,
        config: atdwResult.config,
        trace: atdwResult.trace,
        targetProductIds: [],
        codeContext,
        history,
        timing,
      };
    }

    // -----------------------------------------------------------------------
    // Page-builder domain (existing path)
    //
    // No early error returns - always pass through to the LLM.
    // When data is thin, the LLM asks clarifying questions.
    // -----------------------------------------------------------------------
    const pageUri = intent.pageUri ?? body.pageUri;
    if (!pageUri) {
      const codeContext = await codeContextPromise;
      return {
        intent, config: null, trace: [], targetProductIds: [], codeContext, history, timing,
      };
    }

    // Resolve blocks - filter by component type, or get all if generic
    const blocks = await resolvePageBlocks(db, schema, pageUri, componentType);
    timing.resolveEntities = Date.now() - t0;

    if (blocks.length === 0) {
      // No matching blocks - still pass through to LLM with context
      const allBlocks = await resolvePageBlocks(db, schema, pageUri);
      const availableTypes = [...new Set(allBlocks.map((b) => b.blockType))];
      const codeContext = await codeContextPromise;

      // Give the LLM context about what we found (or didn't)
      intent.pageName = intent.pageName ?? pageUri;

      return {
        intent,
        config: null,
        trace: [{
          step: "block_config" as TraceStep["step"],
          description: availableTypes.length > 0
            ? `No "${componentType}" component found on "${pageUri}". Available components: ${availableTypes.join(", ")}.`
            : `No page builder blocks found at "${pageUri}". This may be an admin URL, a product page, or not a page-builder page.`,
          count: 0,
          productIds: [],
          targetPresent: null,
          details: { availableComponents: availableTypes, requestedType: componentType },
        }],
        targetProductIds: [],
        codeContext,
        history,
        timing,
      };
    }

    const blockIndex = body.componentIndex ?? 0;
    const block = blocks[Math.min(blockIndex, blocks.length - 1)];

    // Check trace cache
    const traceCacheKey = `trace:${tenant}:${pageUri}:${componentType}:${blockIndex}`;
    type TraceResult = { config: ComponentConfig; trace: TraceStep[] };
    let traceResult: TraceResult | null = null;

    const cachedTrace = await env.CACHE.get(traceCacheKey, "json");
    if (cachedTrace) {
      traceResult = cachedTrace as TraceResult;
      timing.filterChain = 0;
    }

    // Trace + product resolution - in parallel
    t0 = Date.now();
    const [freshTrace, targetProductIds] = await Promise.all([
      traceResult
        ? Promise.resolve(traceResult)
        : traceBlock(db, schema, block, []),
      intent.productNames.length > 0
        ? resolveProductsByName(db, schema, intent.productNames)
        : Promise.resolve([]),
    ]);

    if (!traceResult) {
      traceResult = freshTrace;
      timing.filterChain = Date.now() - t0;
      // Cache trace for 5 minutes
      await env.CACHE.put(traceCacheKey, JSON.stringify(traceResult), {
        expirationTtl: 300,
      });
    }

    const codeContext = await codeContextPromise;

    return {
      intent,
      config: traceResult.config,
      trace: traceResult.trace,
      targetProductIds,
      codeContext,
      history,
      timing,
    };
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// POST /api/explain - JSON response (non-streaming)
// ---------------------------------------------------------------------------

async function handleExplain(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  try {
    const data = await resolveData(request, env);

    const t0 = Date.now();
    const explanation = await generateExplanation(
      env,
      data.intent.rawQuestion,
      data.intent,
      data.config,
      data.trace,
      data.targetProductIds,
      data.codeContext,
      data.history
    );
    data.timing.generation = Date.now() - t0;

    const response: ExplainResponse = {
      explanation,
      trace: data.trace,
      config: data.config,
      debug: {
        intent: data.intent,
        timing: data.timing,
      },
    };

    return Response.json(response);
  } catch (error) {
    if (error instanceof RequestError) {
      return Response.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Explain error:", error);
    return Response.json(
      { error: "Failed to generate explanation", detail: message },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/explain/stream - SSE streaming response
// ---------------------------------------------------------------------------

async function handleExplainStream(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const data = await resolveData(request, env);

    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Run the async stream pipeline via waitUntil so the runtime
    // keeps the isolate alive until streaming completes
    ctx.waitUntil(
      (async () => {
        try {
          // Event 1: Send trace + config + timing immediately
          const metadata = {
            event: "metadata",
            trace: data.trace,
            config: data.config,
            debug: {
              intent: data.intent,
              timing: data.timing,
            },
          };
          await writer.write(
            encoder.encode(`event: metadata\ndata: ${JSON.stringify(metadata)}\n\n`)
          );

          // Event 2+: Stream explanation tokens
          const stream = streamExplanation(
            env,
            data.intent.rawQuestion,
            data.intent,
            data.config,
            data.trace,
            data.targetProductIds,
            data.codeContext,
            data.history
          );

          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }

          // Final event
          await writer.write(encoder.encode("event: done\ndata: {}\n\n"));
        } catch (error) {
          console.error("Stream error:", error);
          const errMsg = error instanceof Error ? error.message : "Stream failed";
          await writer.write(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`)
          );
        } finally {
          try {
            await writer.close();
          } catch {
            // Writer may already be closed if client disconnected
          }
        }
      })()
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof RequestError) {
      return Response.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Stream setup error:", error);
    return Response.json(
      { error: "Failed to start explanation stream", detail: message },
      { status: 500 }
    );
  }
}
