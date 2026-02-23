import type { Env, ParsedIntent, QuestionType } from "../types";

// Workers AI model name - cast required because @cloudflare/workers-types
// doesn't include all available model IDs in its union type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as any;

/**
 * Use Workers AI to extract structured intent from a natural language question.
 *
 * Extracts: page URI/name, component type, product names, question type.
 */
export async function parseIntent(
  question: string,
  hintPageUri: string | null | undefined,
  env: Env
): Promise<ParsedIntent> {
  const systemPrompt = `You are an intent parser for a CMS explainability bot. Given a user question about why certain content appears on their website, extract structured information.

The website is a tourism destination marketing site built on Craft CMS. Pages contain "page builder" components like:
- Products (listings of tourism products/businesses)
- Hero (hero banners)
- Featured (featured content)
- Text (text blocks)
- Images (image galleries)

Respond with valid JSON only, no markdown:
{
  "pageUri": "/the-page-path" or null,
  "pageName": "human readable page name" or null,
  "componentType": "products" (lowercase, the component being asked about),
  "productNames": ["Product Name 1", "Product Name 2"] (business/product names mentioned),
  "questionType": "why_included" | "why_excluded" | "what_shows" | "why_order" | "general"
}

Question types:
- "why_included": asking why a specific product/item appears
- "why_excluded": asking why a specific product/item does NOT appear
- "what_shows": asking what products/items show on a page
- "why_order": asking about the ordering/sorting of results
- "general": general question about how page rendering works`;

  const userPrompt = hintPageUri
    ? `Page context: ${hintPageUri}\n\nQuestion: ${question}`
    : `Question: ${question}`;

  try {
    const result = await env.AI.run(TEXT_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 256,
      temperature: 0.1,
    });

    const text =
      typeof result === "string"
        ? result
        : "response" in result
          ? (result as { response: string }).response
          : JSON.stringify(result);

    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fallbackIntent(question, hintPageUri);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      pageUri: parsed.pageUri ?? hintPageUri ?? null,
      pageName: parsed.pageName ?? null,
      componentType: (parsed.componentType ?? "products").toLowerCase(),
      productNames: Array.isArray(parsed.productNames)
        ? parsed.productNames
        : [],
      questionType: validateQuestionType(parsed.questionType),
      rawQuestion: question,
    };
  } catch (error) {
    console.error("Intent parsing failed, using fallback:", error);
    return fallbackIntent(question, hintPageUri);
  }
}

function fallbackIntent(
  question: string,
  hintPageUri: string | null | undefined
): ParsedIntent {
  return {
    pageUri: hintPageUri ?? null,
    pageName: null,
    componentType: "products",
    productNames: [],
    questionType: "general",
    rawQuestion: question,
  };
}

function validateQuestionType(type: unknown): QuestionType {
  const valid: readonly string[] = [
    "why_included",
    "why_excluded",
    "what_shows",
    "why_order",
    "general",
  ];
  return typeof type === "string" && valid.includes(type)
    ? (type as QuestionType)
    : "general";
}
