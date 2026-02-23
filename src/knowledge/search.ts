import type { Env } from "../types";

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
 * Currently disabled pending decision on AI Search strategy.
 * See session-cache.json pending items.
 */
export async function retrieveContext(
  env: Env,
  componentType: string
): Promise<string> {
  try {
    const autorag = env.AI.autorag(env.AUTORAG_NAME);

    const query = `How does the ${componentType} component filter and display results? Include the template source and PHP service logic.`;

    const response: AutoRAGResponse = await autorag.search({
      query,
      rewrite_query: true,
      max_num_results: 8,
      ranking_options: {
        score_threshold: 0.3,
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
    console.error("AI Search query failed:", error);
    return "";
  }
}
