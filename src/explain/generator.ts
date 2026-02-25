import type {
  Env,
  ChatMessage,
  ParsedIntent,
  DomainConfig,
  ComponentConfig,
  AtdwImportConfig,
  TraceStep,
  TraceStepName,
} from "../types";

/**
 * AutoRAG aiSearch request with model field.
 * The `model` parameter exists in the API but isn't in @cloudflare/workers-types yet.
 */
interface AiSearchRequest {
  query: string;
  model?: string;
  system_prompt?: string;
  rewrite_query?: boolean;
  max_num_results?: number;
  ranking_options?: { score_threshold?: number };
  reranking?: { enabled?: boolean };
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Non-streaming generation via aiSearch()
// ---------------------------------------------------------------------------

/**
 * Generate an explanation using AutoRAG aiSearch().
 *
 * This replaces the old two-step approach (search() + AI.run()) with a
 * single call that handles both code retrieval and generation. A capable
 * model (Claude Sonnet, Gemini Pro) reasons about the retrieved source
 * code directly - no custom tracers needed for code understanding.
 *
 * DB trace data is embedded in the system prompt so the model has both
 * code context (from AutoRAG) and live data facts (from Hyperdrive).
 */
export async function generateExplanation(
  env: Env,
  question: string,
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[],
  history: ChatMessage[] = [],
  tenant?: string
): Promise<{ explanation: string; codeContext: string }> {
  const systemPrompt = buildSystemPrompt(intent, config, trace, targetProductIds, history);
  const query = buildQuery(question, intent, tenant);

  try {
    const autorag = env.AI.autorag(env.AUTORAG_NAME);
    const response = await autorag.aiSearch({
      query,
      model: env.AISEARCH_MODEL,
      system_prompt: systemPrompt,
      rewrite_query: true,
      max_num_results: 10,
      reranking: { enabled: true },
      ranking_options: { score_threshold: 0.2 },
    } as AiSearchRequest as Parameters<typeof autorag.aiSearch>[0]);

    // Extract code context from search results for debug output
    const codeContext = (response.data ?? [])
      .map((r) => {
        const text = r.content?.map((c) => c.text ?? "").join("\n") ?? "";
        return `--- ${r.filename ?? "document"} (score: ${r.score?.toFixed(2) ?? "?"}) ---\n${text}`;
      })
      .join("\n\n");

    return {
      explanation: response.response ?? "I wasn't able to generate an explanation. Please try rephrasing your question.",
      codeContext,
    };
  } catch (error) {
    console.error("aiSearch generation failed:", error);
    return {
      explanation: generateFallbackExplanation(intent, config, trace, targetProductIds),
      codeContext: "",
    };
  }
}

// ---------------------------------------------------------------------------
// Streaming generation via aiSearch()
// ---------------------------------------------------------------------------

/**
 * Stream an explanation using AutoRAG aiSearch() with stream: true.
 * Returns a ReadableStream of SSE-formatted text chunks.
 */
export function streamExplanation(
  env: Env,
  question: string,
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[],
  history: ChatMessage[] = [],
  tenant?: string
): ReadableStream {
  const systemPrompt = buildSystemPrompt(intent, config, trace, targetProductIds, history);
  const query = buildQuery(question, intent, tenant);
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        const autorag = env.AI.autorag(env.AUTORAG_NAME);
        const response = await autorag.aiSearch({
          query,
          model: env.AISEARCH_MODEL,
          system_prompt: systemPrompt,
          rewrite_query: true,
          max_num_results: 10,
          reranking: { enabled: true },
          ranking_options: { score_threshold: 0.2 },
          stream: true,
        } as AiSearchRequest as Parameters<typeof autorag.aiSearch>[0]);

        // aiSearch with stream: true returns a Response object
        const body = (response as unknown as Response).body;
        if (!body) {
          const fallback = generateFallbackExplanation(intent, config, trace, targetProductIds);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: fallback })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }

        controller.close();
      } catch (error) {
        console.error("Stream aiSearch failed:", error);
        const fallback = generateFallbackExplanation(intent, config, trace, targetProductIds);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: fallback })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/**
 * Build the aiSearch query. This is what AutoRAG uses for both retrieval
 * (finding relevant code) and generation (answering the question).
 * Include tenant/theme name so embeddings prefer the right theme's templates.
 */
function buildQuery(question: string, intent: ParsedIntent, tenant?: string): string {
  const themeHint = tenant ? ` on the ${tenant} theme` : "";

  if (intent.domain === "atdw_import") {
    return (
      `${question} ` +
      `ATDW product import${themeHint}: how does the Roam platform handle this? ` +
      `Include relevant formatters, services, and template rendering.`
    );
  }

  const componentType = intent.componentType || "products";
  return (
    `${question} ` +
    `How does the ${componentType} component work${themeHint}? ` +
    `Include template source, VariableService methods, and filter logic.`
  );
}

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the system prompt with persona + DB trace data.
 *
 * The system prompt serves two purposes:
 * 1. Persona and response style instructions
 * 2. Structured data from DB queries (trace steps, config, etc.)
 *
 * AutoRAG injects the retrieved code context automatically - we don't
 * need to include it here. The model sees both the system prompt AND
 * the retrieved code chunks.
 */
function buildSystemPrompt(
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[],
  history: ChatMessage[]
): string {
  const persona = buildPersona(intent.domain);
  const dataContext = buildDataContext(intent, config, trace, targetProductIds);
  const historyContext = buildHistoryContext(history);

  return `${persona}

${dataContext}
${historyContext}
Important: AutoRAG has retrieved relevant source code from the Roam platform codebase.
Use this code to understand HOW the system works - but NEVER reference code, filenames,
function names, or technical details in your response. Translate code behaviour into
plain-language explanations.`;
}

function buildPersona(domain: string): string {
  const conversationalRules = `
Conversational rules:
- You are a chatbot. ALWAYS respond with something helpful - never leave the user with nothing.
- If the diagnostic data is empty or you don't have enough context, ask a friendly clarifying question.
  For example: "I'd love to help with that! Could you tell me which product you're asking about?" or
  "I can see you're looking at a page, but I'm not sure which component you mean. Could you describe what you're seeing?"
- If the data doesn't fully answer their question, share what you CAN see and ask about the rest.
- Read URL clues: if the page URL contains "/admin/entries/products/", they're looking at a specific product in the admin panel.
- Keep it to 2-3 short paragraphs. Be warm but concise - respect their time.
- Never reference internal step names, database tables, trace data, or technical jargon.`;

  if (domain === "atdw_import") {
    return `You are a friendly, knowledgeable support person helping tourism website managers understand how ATDW (Australian Tourism Data Warehouse) products are imported into their website.

The user manages a tourism website on the Roam platform. Products from the ATDW Atlas system are automatically imported based on configured categories, regions, and postcodes. The import process checks each product against the site's settings to decide whether to import it.

You have been given diagnostic data about a specific product's import journey, AND relevant source code from the platform has been retrieved automatically. Use both to answer accurately - but explain in everyday language.

Writing style:
- Talk about "the import process" or "how the sync works", never "the reason column" or "createRecord"
- Use the actual product name, organisation name, and location - never raw IDs
- Explain the WHY naturally: "Because the product's postcode 3500 (Mildura) isn't in any of your enabled regions..."
- If a product wasn't imported, explain which specific check prevented it
- If a product is inactive or expired, explain what that means in practical terms
- Mention the ATDW category (accommodation, event, attraction, etc.) in plain terms` + conversationalRules;
  }

  return `You are a friendly, knowledgeable support person helping tourism website managers understand their website.

The user manages a tourism website on the Roam platform. Pages have components like "Products" that display tourism businesses, experiences, and deals. These components have settings (categories, regions, tiers) that control what gets shown. Products can also be imported from the ATDW (Australian Tourism Data Warehouse).

You have been given diagnostic data (which may be partial or empty), AND relevant source code from the platform has been retrieved automatically. Use both to answer accurately - but explain in everyday language.

Writing style:
- Talk about "the component settings" or "how this is configured", never "the filter chain" or "step 3"
- Use the actual names of categories, regions, and products - never IDs or technical references
- Explain the WHY naturally: "Because the region setting resolved to Talbot, and no listings have a Talbot postcode..."
- If products appear from unexpected places, explain the mechanism simply
- If the display limit cuts results, mention it naturally
- If order is randomised, mention that what they see will change on each page load` + conversationalRules;
}

function buildDataContext(
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[]
): string {
  const traceSummary = formatTrace(trace);

  if (intent.domain === "atdw_import" && config && "domain" in config && config.domain === "atdw_import") {
    const atdwConfig = config as AtdwImportConfig;
    let ctx = `\n--- DATABASE DIAGNOSTIC DATA ---\n`;
    ctx += `ATDW Product: ${atdwConfig.productName}\n`;
    ctx += `Organisation: ${atdwConfig.organisation ?? "unknown"}\n`;
    ctx += `Category: ${atdwConfig.category}\n`;
    ctx += `ATDW Status: ${atdwConfig.atdwStatus}\n`;
    ctx += `Location: ${atdwConfig.city ?? "unknown"} (postcode: ${atdwConfig.postcode ?? "unknown"})\n`;
    ctx += `Imported: ${atdwConfig.imported ? "Yes" : "No"}\n`;
    ctx += `Has website entry: ${atdwConfig.hasEntry ? "Yes" : "No"}\n`;
    if (traceSummary) ctx += `\nData trace:\n${traceSummary}\n`;
    ctx += `--- END DIAGNOSTIC DATA ---\n`;
    return ctx;
  }

  let ctx = `\n--- DATABASE DIAGNOSTIC DATA ---\n`;
  ctx += `Page URL: ${intent.pageUri ?? "not provided"}\n`;

  if (targetProductIds.length > 0) {
    ctx += `Asking about specific products (IDs: ${targetProductIds.join(", ")})\n`;
  }

  if (config && !("domain" in config)) {
    ctx += `\nComponent configuration:\n${formatConfig(config as ComponentConfig)}\n`;
  }

  if (traceSummary) {
    ctx += `\nData trace:\n${traceSummary}\n`;
  } else {
    ctx += `\nNo diagnostic data collected. The page URL may not match a page-builder page, or the question is about something broader.\n`;
  }

  ctx += `--- END DIAGNOSTIC DATA ---\n`;
  return ctx;
}

function buildHistoryContext(history: ChatMessage[]): string {
  if (history.length === 0) return "";

  // Include recent history so the model has conversation context
  let budget = 3000;
  const lines: string[] = ["\n--- CONVERSATION HISTORY ---"];

  for (const msg of history) {
    const content = msg.content.length > 500
      ? msg.content.slice(0, 500) + "..."
      : msg.content;
    budget -= content.length;
    if (budget < 0) break;
    lines.push(`${msg.role === "user" ? "Client" : "You"}: ${content}`);
  }

  lines.push("--- END HISTORY ---\n");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers (unchanged)
// ---------------------------------------------------------------------------

function formatConfig(config: ComponentConfig): string {
  const lines: string[] = [];

  if (config.categories.length > 0) {
    lines.push(`Categories: ${config.categories.map((c) => c.title).join(", ")}`);
  } else {
    lines.push("Categories: none selected");
  }

  if (config.regions.length > 0) {
    lines.push(`Regions: ${config.regions.map((r) => r.title).join(", ")}`);
  } else {
    lines.push("Regions: none selected");
  }

  if (config.tiers.length > 0) {
    lines.push(`Tiers: ${config.tiers.map((t) => t.title).join(", ")}`);
  } else {
    lines.push("Tiers: none selected");
  }

  if (config.taxonomy.length > 0) {
    lines.push(`Taxonomy: ${config.taxonomy.map((t) => t.title).join(", ")}`);
  }

  if (config.explicitProducts.length > 0) {
    lines.push(`Explicitly selected products: ${config.explicitProducts.map((p) => p.title).join(", ")}`);
  }

  if (config.excludeProducts.length > 0) {
    lines.push(`Excluded products: ${config.excludeProducts.map((p) => p.title).join(", ")}`);
  }

  lines.push(`Limit: ${config.limit}`);
  lines.push(`Order: ${config.order}`);
  lines.push(`Style: ${config.style ?? "default"}`);
  lines.push(`Layout: ${config.layout}`);

  return lines.join("\n");
}

/** Map internal step names to human-readable descriptions */
const stepLabels: Record<TraceStepName, string> = {
  resolve_categories: "Category settings",
  resolve_regions: "Region settings",
  region_to_products: "Finding listings in those regions",
  resolve_taxonomy: "Taxonomy settings",
  main_query: "Matching listings",
  merge_explicit: "Hand-picked listings",
  apply_excludes: "Excluded listings",
  sort: "Sorting",
  limit: "Display limit",
  block_config: "Component configuration",
  atdw_lookup: "ATDW product lookup",
  atdw_region_config: "Configured import regions",
  atdw_postcode_match: "Postcode vs configured regions",
  atdw_status_eval: "Record status and import state",
  atdw_category_mapping: "Category and sub-type mapping",
  atdw_entry_state: "Website entry state",
  atdw_entry_link: "Website listing",
};

function formatTrace(trace: TraceStep[]): string {
  return trace
    .map((step) => {
      const label = stepLabels[step.step] ?? step.step;
      let line = `- ${label}: ${step.description}`;

      if (step.targetPresent === true) {
        line += " (the listing in question IS in this set)";
      } else if (step.targetPresent === false) {
        line += " (the listing in question is NOT in this set)";
      }

      if (step.details) {
        const slim: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(step.details)) {
          if (Array.isArray(v) && v.length > 10) {
            slim[k] = `[${v.length} items]`;
          } else {
            slim[k] = v;
          }
        }
        const detailStr = JSON.stringify(slim);
        if (detailStr.length < 400) {
          line += `\n  (${detailStr})`;
        }
      }

      return line;
    })
    .join("\n");
}

/**
 * Generate a basic explanation without the LLM, using just trace data.
 * Used as fallback when aiSearch is unavailable.
 */
function generateFallbackExplanation(
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[]
): string {
  const lines: string[] = [];

  if (intent.domain === "atdw_import" && config && "domain" in config && config.domain === "atdw_import") {
    const atdwConfig = config as AtdwImportConfig;
    lines.push(`Here's what I found about the ATDW import for "${atdwConfig.productName}":\n`);
    lines.push(`Organisation: ${atdwConfig.organisation ?? "unknown"}`);
    lines.push(`Category: ${atdwConfig.category}`);
    lines.push(`ATDW Status: ${atdwConfig.atdwStatus}`);
    lines.push(`Location: ${atdwConfig.city ?? "unknown"} (${atdwConfig.postcode ?? "no postcode"})`);
    lines.push(`Imported: ${atdwConfig.imported ? "Yes" : "No"}`);
    lines.push(`Has website entry: ${atdwConfig.hasEntry ? "Yes" : "No"}`);

    if (trace.length > 0) {
      lines.push("\nImport trace:");
      for (const step of trace) {
        const label = stepLabels[step.step] ?? step.step;
        lines.push(`- ${label}: ${step.description}`);
      }
    }

    return lines.join("\n");
  }

  lines.push(
    `Here's what I found about the Products component on ${intent.pageUri ?? "this page"}:\n`
  );

  if (config && !("domain" in config)) {
    const compConfig = config as ComponentConfig;
    const filters: string[] = [];
    if (compConfig.categories.length > 0)
      filters.push(`categories: ${compConfig.categories.map((c: { title: string }) => c.title).join(", ")}`);
    if (compConfig.regions.length > 0)
      filters.push(`regions: ${compConfig.regions.map((r: { title: string }) => r.title).join(", ")}`);
    if (compConfig.tiers.length > 0)
      filters.push(`tiers: ${compConfig.tiers.map((t: { title: string }) => t.title).join(", ")}`);
    if (compConfig.taxonomy.length > 0)
      filters.push(`taxonomy: ${compConfig.taxonomy.map((t: { title: string }) => t.title).join(", ")}`);

    if (filters.length > 0) {
      lines.push(`The component is configured to filter by ${filters.join(" and ")}.`);
    } else {
      lines.push("The component has no category, region, or tier filters.");
    }

    if (compConfig.explicitProducts.length > 0) {
      lines.push(`${compConfig.explicitProducts.length} products were explicitly selected.`);
    }
  }

  if (trace.length > 0) {
    const finalStep = trace[trace.length - 1];
    const compConfig = config && !("domain" in config) ? config as ComponentConfig : null;
    lines.push(
      `\nAfter all filters, ${finalStep.count} products are displayed` +
        (compConfig ? ` (limit: ${compConfig.limit}, order: ${compConfig.order}).` : ".")
    );

    if (targetProductIds.length > 0) {
      const firstAbsent = trace.find((s) => s.targetPresent === false);

      if (finalStep.targetPresent) {
        lines.push("\nThe product you asked about IS in the final results.");
      } else if (firstAbsent) {
        lines.push(
          `\nThe product you asked about was excluded at the "${firstAbsent.step}" step: ${firstAbsent.description}`
        );
      } else {
        lines.push(
          "\nThe product you asked about was not found in any step of the filter chain."
        );
      }
    }
  }

  return lines.join("\n");
}
