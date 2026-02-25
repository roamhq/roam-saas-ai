import type { Env, ParsedIntent } from "../types";

export interface SearchResult {
  filename: string;
  score: number;
  text: string;
}

/** Shape returned by AutoRAG search() */
interface AutoRAGChunk {
  text?: string;
}

interface AutoRAGResult {
  filename?: string;
  score?: number;
  content?: AutoRAGChunk[];
}

interface AutoRAGResponse {
  data?: AutoRAGResult[];
}

/**
 * Retrieve relevant knowledge base context from AI Search (AutoRAG).
 *
 * Uses env.AI.autorag(name).search() - the retrieval-only endpoint.
 * We don't use aiSearch() here because the Worker composes its own
 * LLM prompt with trace data; we just want the raw source chunks.
 *
 * The query is domain-aware and tenant-aware: includes the theme name
 * so embeddings prefer the correct theme's templates over others.
 */
export async function retrieveContext(
  env: Env,
  intent: ParsedIntent,
  tenant?: string
): Promise<string> {
  try {
    const autorag = env.AI.autorag(env.AUTORAG_NAME);
    const query = buildRetrievalQuery(intent, tenant);

    const response: AutoRAGResponse = await autorag.search({
      query,
      rewrite_query: true,
      max_num_results: 10,
      reranking: { enabled: true },
      ranking_options: {
        score_threshold: 0.2,
      },
    });

    if (response?.data && response.data.length > 0) {
      return response.data
        .map((r) => {
          const text = r.content
            ?.map((c) => c.text ?? "")
            .join("\n") ?? "";
          return `--- ${r.filename ?? "document"} (score: ${r.score?.toFixed(2) ?? "?"}) ---\n${text}`;
        })
        .join("\n\n");
    }

    return "";
  } catch (error) {
    console.error("AutoRAG retrieval failed:", error);
    return "";
  }
}

/**
 * Build a retrieval query that combines domain context with the user's
 * actual question. Includes tenant/theme name so the embedding model
 * prefers that theme's templates over others (the .md preambles contain
 * "This Twig template is the X component for the {theme} tourism website").
 */
function buildRetrievalQuery(intent: ParsedIntent, tenant?: string): string {
  const question = intent.rawQuestion;
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
