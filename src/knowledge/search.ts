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
 * The query is domain-aware: ATDW import questions retrieve PHP services
 * and import logic; page-component questions retrieve template code
 * and VariableService methods.
 */
export async function retrieveContext(
  env: Env,
  intent: ParsedIntent
): Promise<string> {
  try {
    const autorag = env.AI.autorag(env.AUTORAG_NAME);
    const query = buildRetrievalQuery(intent);

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
 * actual question. This ensures AutoRAG finds code relevant to what
 * was asked - not just generic import/component code every time.
 *
 * The query is phrased to find relevant source code - not to answer
 * the user's question directly. AutoRAG retrieves code chunks;
 * the LLM uses those chunks plus data facts to generate the answer.
 */
function buildRetrievalQuery(intent: ParsedIntent): string {
  // The user's question drives retrieval - it's the strongest signal
  // for what code is relevant. We add domain context as a fallback
  // so we still get useful results for vague questions.
  const question = intent.rawQuestion;

  if (intent.domain === "atdw_import") {
    return (
      `${question} ` +
      `ATDW product import: how does the Roam platform handle this? ` +
      `Include relevant formatters, services, and import logic.`
    );
  }

  const componentType = intent.componentType || "products";
  return (
    `${question} ` +
    `How does the ${componentType} component work on the Roam platform? ` +
    `Include template source, VariableService methods, and filter logic.`
  );
}
