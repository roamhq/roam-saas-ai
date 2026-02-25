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

// Workers AI models - cast required because @cloudflare/workers-types
// doesn't include all available model IDs in its union type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any;

/**
 * Generate a plain-language explanation using Workers AI (non-streaming).
 */
export async function generateExplanation(
  env: Env,
  question: string,
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[],
  codeContext: string = "",
  history: ChatMessage[] = []
): Promise<string> {
  const systemPrompt = buildSystemPrompt(intent.domain);
  const userPrompt = buildUserPrompt(question, intent, config, trace, targetProductIds, codeContext);
  const messages = buildMessages(systemPrompt, userPrompt, history);

  try {
    const result = await env.AI.run(TEXT_MODEL, {
      messages,
      max_tokens: 512,
      temperature: 0.3,
    });

    const text =
      typeof result === "string"
        ? result
        : "response" in result
          ? (result as { response: string }).response
          : "I wasn't able to generate an explanation. Please check the trace data for details.";

    return text;
  } catch (error) {
    console.error("Generation failed:", error);
    return generateFallbackExplanation(intent, config, trace, targetProductIds);
  }
}

/**
 * Stream a plain-language explanation using Workers AI.
 * Returns a ReadableStream of SSE-formatted text chunks.
 */
export function streamExplanation(
  env: Env,
  question: string,
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[],
  codeContext: string = "",
  history: ChatMessage[] = []
): ReadableStream {
  const systemPrompt = buildSystemPrompt(intent.domain);
  const userPrompt = buildUserPrompt(question, intent, config, trace, targetProductIds, codeContext);
  const messages = buildMessages(systemPrompt, userPrompt, history);

  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        const stream = await env.AI.run(TEXT_MODEL, {
          messages,
          max_tokens: 512,
          temperature: 0.3,
          stream: true,
        });

        // Workers AI streaming returns a ReadableStream
        const reader = (stream as ReadableStream).getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Forward the raw SSE chunks - already formatted as
          // data: {"response":"token"}\n\n
          controller.enqueue(value);
        }

        controller.close();
      } catch (error) {
        console.error("Stream generation failed:", error);
        const fallback = generateFallbackExplanation(intent, config, trace, targetProductIds);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: fallback })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Message construction (internal)
// ---------------------------------------------------------------------------

type AiMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Build the full messages array for the LLM, including conversation history.
 *
 * Structure:
 *   [system] system prompt (always first)
 *   [user]   prior turn 1 (from history)
 *   [asst]   prior turn 1 response (from history)
 *   ...
 *   [user]   current question + diagnostic data (always last)
 *
 * History is trimmed to keep total content under ~3000 chars to avoid
 * blowing the 8B model's effective attention budget.
 */
function buildMessages(
  systemPrompt: string,
  userPrompt: string,
  history: ChatMessage[]
): AiMessage[] {
  const messages: AiMessage[] = [{ role: "system", content: systemPrompt }];

  if (history.length > 0) {
    // Trim history to fit - keep recent turns, truncate long messages
    let historyBudget = 3000;
    const trimmed: AiMessage[] = [];

    for (const msg of history) {
      const content = msg.content.length > 500
        ? msg.content.slice(0, 500) + "..."
        : msg.content;
      historyBudget -= content.length;
      if (historyBudget < 0) break;
      trimmed.push({ role: msg.role, content });
    }

    messages.push(...trimmed);
  }

  messages.push({ role: "user", content: userPrompt });
  return messages;
}

// ---------------------------------------------------------------------------
// Prompt construction (internal)
// ---------------------------------------------------------------------------

function buildSystemPrompt(domain: string = "page_component"): string {
  // Shared conversational rules for all domains
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

You have been given diagnostic data about a specific product's import journey. Use this data to answer their question accurately - but explain it in everyday language as if you were a colleague walking them through it.

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

You have been given diagnostic data (which may be partial or empty). Use whatever data you have to answer their question accurately - but explain it in everyday language as if you were a colleague walking them through it.

Writing style:
- Talk about "the component settings" or "how this is configured", never "the filter chain" or "step 3"
- Use the actual names of categories, regions, and products - never IDs or technical references
- Explain the WHY naturally: "Because the region setting resolved to Talbot, and no listings have a Talbot postcode..."
- If products appear from unexpected places, explain the mechanism simply
- If the display limit cuts results, mention it naturally
- If order is randomised, mention that what they see will change on each page load` + conversationalRules;
}

function buildUserPrompt(
  question: string,
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[],
  codeContext: string = ""
): string {
  const traceSummary = formatTrace(trace);
  const codeSection = codeContext
    ? `\nRelevant source code (for your understanding - NEVER reference code, filenames, or function names in your response):\n${codeContext}\n`
    : "";

  if (intent.domain === "atdw_import" && config && "domain" in config && config.domain === "atdw_import") {
    const atdwConfig = config as AtdwImportConfig;
    let prompt = `The client asked: "${question}"\n\n`;
    prompt += `ATDW Product: ${atdwConfig.productName}\n`;
    prompt += `Organisation: ${atdwConfig.organisation ?? "unknown"}\n`;
    prompt += `Category: ${atdwConfig.category}\n`;
    prompt += `ATDW Status: ${atdwConfig.atdwStatus}\n`;
    prompt += `Location: ${atdwConfig.city ?? "unknown"} (postcode: ${atdwConfig.postcode ?? "unknown"})\n`;
    prompt += `Imported: ${atdwConfig.imported ? "Yes" : "No"}\n`;
    prompt += `Has website entry: ${atdwConfig.hasEntry ? "Yes" : "No"}\n`;
    prompt += `\nHere's what we found in the data:\n${traceSummary}\n`;
    prompt += codeSection;
    prompt += `\nUsing the data above (and the source code for context on how the system works), explain this to the client in plain, friendly language. Do NOT mention code, files, functions, or variables.`;
    return prompt;
  }

  const configSummary = config ? formatConfig(config as ComponentConfig) : null;

  let prompt = `The client asked: "${question}"\n\n`;
  prompt += `Page URL: ${intent.pageUri ?? "not provided"}\n`;

  if (targetProductIds.length > 0) {
    prompt += `They're asking about specific products (IDs: ${targetProductIds.join(", ")})\n`;
  }

  if (configSummary) {
    prompt += `\nHere's how this component is configured:\n${configSummary}\n`;
  }

  if (traceSummary) {
    prompt += `\nHere's what the data shows:\n${traceSummary}\n`;
  } else {
    prompt += `\nNo diagnostic data was collected. This might mean the page URL doesn't match a page-builder page, or the question is about something we need more context for.\n`;
  }

  prompt += codeSection;
  prompt += `\nUsing whatever data you have above, respond to the client in plain, friendly language. If you don't have enough data to answer their question, ask a helpful clarifying question. Do NOT mention code, files, functions, or variables.`;

  return prompt;
}

function formatConfig(config: ComponentConfig): string {
  const lines: string[] = [];

  if (config.categories.length > 0) {
    lines.push(
      `Categories: ${config.categories.map((c) => c.title).join(", ")}`
    );
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
    lines.push(
      `Taxonomy: ${config.taxonomy.map((t) => t.title).join(", ")}`
    );
  }

  if (config.explicitProducts.length > 0) {
    lines.push(
      `Explicitly selected products: ${config.explicitProducts.map((p) => p.title).join(", ")}`
    );
  }

  if (config.excludeProducts.length > 0) {
    lines.push(
      `Excluded products: ${config.excludeProducts.map((p) => p.title).join(", ")}`
    );
  }

  lines.push(`Limit: ${config.limit}`);
  lines.push(`Order: ${config.order}`);
  lines.push(`Style: ${config.style ?? "default"}`);
  lines.push(`Layout: ${config.layout}`);

  return lines.join("\n");
}

/** Map internal step names to human-readable descriptions */
const stepLabels: Record<TraceStepName, string> = {
  // Page-builder steps
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
  // ATDW import steps - data collection
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
 * Used as fallback when Workers AI is unavailable.
 */
function generateFallbackExplanation(
  intent: ParsedIntent,
  config: DomainConfig | null,
  trace: TraceStep[],
  targetProductIds: number[]
): string {
  const lines: string[] = [];

  // ATDW domain fallback
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
      lines.push(
        `${compConfig.explicitProducts.length} products were explicitly selected.`
      );
    }
  }

  // Final results
  if (trace.length > 0) {
    const finalStep = trace[trace.length - 1];
    const compConfig = config && !("domain" in config) ? config as ComponentConfig : null;
    lines.push(
      `\nAfter all filters, ${finalStep.count} products are displayed` +
        (compConfig ? ` (limit: ${compConfig.limit}, order: ${compConfig.order}).` : ".")
    );

    // Target product status
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
