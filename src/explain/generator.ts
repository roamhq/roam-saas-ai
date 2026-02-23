import type {
  Env,
  ParsedIntent,
  ComponentConfig,
  TraceStep,
  TraceStepName,
} from "../types";

// Workers AI model name - cast required because @cloudflare/workers-types
// doesn't include all available model IDs in its union type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as any;

/**
 * Generate a plain-language explanation using Workers AI (non-streaming).
 */
export async function generateExplanation(
  env: Env,
  question: string,
  intent: ParsedIntent,
  config: ComponentConfig | null,
  trace: TraceStep[],
  targetProductIds: number[]
): Promise<string> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(question, intent, config, trace, targetProductIds);

  try {
    const result = await env.AI.run(TEXT_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
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
  config: ComponentConfig | null,
  trace: TraceStep[],
  targetProductIds: number[]
): ReadableStream {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(question, intent, config, trace, targetProductIds);

  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        const stream = await env.AI.run(TEXT_MODEL, {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
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
// Prompt construction (internal)
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are a friendly, knowledgeable support person helping tourism website managers understand why their pages display certain listings.

The user manages a tourism website on the Roam platform. Pages have components like "Products" that display tourism businesses, experiences, and deals. These components have settings (categories, regions, tiers) that control what gets shown.

You have been given diagnostic data about how the component's settings produced the results on their page. Use this data to answer their question accurately - but explain it in everyday language as if you were a colleague walking them through it.

Writing style:
- Talk about "the component settings" or "how this is configured", never "the filter chain" or "step 3"
- Use the actual names of categories, regions, and products - never IDs or technical references
- Explain the WHY naturally: "Because the region setting resolved to Talbot, and no listings have a Talbot postcode..."
- If products appear from unexpected places, explain the mechanism simply: "When no listings match the region, the component falls back to showing everything in the selected category"
- If the display limit cuts results, mention it naturally: "There are actually 317 matching listings, but the component is set to show only 10"
- If order is randomised, mention that what they see will change on each page load
- Keep it to 2-3 short paragraphs. Be warm but concise - respect their time
- Never reference internal step names, trace data, or technical jargon`;
}

function buildUserPrompt(
  question: string,
  intent: ParsedIntent,
  config: ComponentConfig | null,
  trace: TraceStep[],
  targetProductIds: number[]
): string {
  const configSummary = config ? formatConfig(config) : "No configuration data available for this component.";
  const traceSummary = formatTrace(trace);

  let prompt = `The client asked: "${question}"\n\n`;
  prompt += `Page: ${intent.pageUri ?? "unknown"}\n`;

  if (targetProductIds.length > 0) {
    prompt += `They're asking about specific products (IDs: ${targetProductIds.join(", ")})\n`;
  }

  prompt += `\nHere's how this component is configured:\n${configSummary}\n`;
  prompt += `\nHere's what happened when the page loaded:\n${traceSummary}\n`;
  prompt += `\nExplain this to the client in plain, friendly language.`;

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
  config: ComponentConfig | null,
  trace: TraceStep[],
  targetProductIds: number[]
): string {
  const lines: string[] = [];

  lines.push(
    `Here's what I found about the Products component on ${intent.pageUri ?? "this page"}:\n`
  );

  if (config) {
    const filters: string[] = [];
    if (config.categories.length > 0)
      filters.push(`categories: ${config.categories.map((c) => c.title).join(", ")}`);
    if (config.regions.length > 0)
      filters.push(`regions: ${config.regions.map((r) => r.title).join(", ")}`);
    if (config.tiers.length > 0)
      filters.push(`tiers: ${config.tiers.map((t) => t.title).join(", ")}`);
    if (config.taxonomy.length > 0)
      filters.push(`taxonomy: ${config.taxonomy.map((t) => t.title).join(", ")}`);

    if (filters.length > 0) {
      lines.push(`The component is configured to filter by ${filters.join(" and ")}.`);
    } else {
      lines.push("The component has no category, region, or tier filters.");
    }

    if (config.explicitProducts.length > 0) {
      lines.push(
        `${config.explicitProducts.length} products were explicitly selected.`
      );
    }
  }

  // Final results
  if (trace.length > 0) {
    const finalStep = trace[trace.length - 1];
    lines.push(
      `\nAfter all filters, ${finalStep.count} products are displayed` +
        (config ? ` (limit: ${config.limit}, order: ${config.order}).` : ".")
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
