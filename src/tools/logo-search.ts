import { z } from "zod";
import { BaseTool } from "../utils/base-tool.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("LogoSearch");

/** Concurrency limit for parallel SVG fetching (Requirement B2.2) */
const CONCURRENCY_LIMIT = 5;

interface ThemeOptions {
  dark: string;
  light: string;
}

interface SVGLogo {
  id?: number;
  title: string;
  category: string | string[];
  route: string | ThemeOptions;
  wordmark?: string | ThemeOptions;
  brandUrl?: string;
  url: string;
}

interface LogoResult {
  query: string;
  success: boolean;
  content?: string;
  error?: string;
}

const LOGO_TOOL_NAME = "magic_logo_search";
const LOGO_TOOL_DESCRIPTION = `
Search and return logos in specified format (JSX, TSX, SVG).
Supports single and multiple logo searches with category filtering.
Can return logos in different themes (light/dark) if available.

When to use this tool:
1. When user types "/logo" command (e.g., "/logo GitHub")
2. When user asks to add a company logo that's not in the local project

Format options:
- TSX: Returns TypeScript React component
- JSX: Returns JavaScript React component
- SVG: Returns raw SVG markup
`;

export class LogoSearchTool extends BaseTool {
  name = LOGO_TOOL_NAME;
  description = LOGO_TOOL_DESCRIPTION;

  schema = z.object({
    queries: z.array(z.string()).describe("List of company names to search for logos"),
    format: z.enum(["JSX", "TSX", "SVG"]).describe("Output format"),
  });

  /**
   * Split array into chunks of specified size
   */
  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Process items with concurrency limit using Promise.allSettled
   * Satisfies Requirements B2.1, B2.2, B2.3
   */
  private async processWithConcurrencyLimit<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    limit: number = CONCURRENCY_LIMIT
  ): Promise<PromiseSettledResult<R>[]> {
    const chunks = this.chunk(items, limit);
    const results: PromiseSettledResult<R>[] = [];

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(chunk.map(processor));
      results.push(...chunkResults);
    }

    return results;
  }

  private async fetchLogos(query: string): Promise<SVGLogo[]> {
    const url = `https://api.svgl.app?search=${encodeURIComponent(query)}`;
    try {
      const response = await fetch(url);
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      logger.error(`Error fetching logos:`, error);
      return [];
    }
  }

  private async fetchSVGContent(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch SVG: ${response.statusText}`);
    return await response.text();
  }

  private convertToFormat(svgContent: string, format: "JSX" | "TSX" | "SVG", name: string): string {
    if (format === "SVG") return svgContent;
    const jsx = svgContent.replace(/class=/g, "className=");
    const componentName = name.endsWith("Icon") ? name : `${name}Icon`;
    return format === "TSX"
      ? `const ${componentName}: React.FC = () => (${jsx})`
      : `function ${componentName}() { return (${jsx}) }`;
  }

  /**
   * Process a single logo query
   * Returns LogoResult with success/failure status
   */
  private async processLogoQuery(query: string, format: "JSX" | "TSX" | "SVG"): Promise<LogoResult> {
    const logos = await this.fetchLogos(query);
    if (logos.length === 0) {
      return { query, success: false, error: `No logo found for: ${query}` };
    }
    const logo = logos[0];
    const svgUrl = typeof logo.route === "string" ? logo.route : logo.route.light;
    const svg = await this.fetchSVGContent(svgUrl);
    const code = this.convertToFormat(svg, format, logo.title + "Icon");
    return { query, success: true, content: `// ${logo.title}\n${code}` };
  }

  /**
   * Execute logo search with parallel fetching and concurrency limit
   * Satisfies Requirements B2.1-B2.4 and Property B3
   */
  async execute({ queries, format }: z.infer<typeof this.schema>) {
    logger.info(`Searching: ${queries.join(", ")} (concurrency limit: ${CONCURRENCY_LIMIT})`);

    // Process all queries with concurrency limit using Promise.allSettled
    // This ensures partial failures don't affect other fetches (B2.3)
    const settledResults = await this.processWithConcurrencyLimit(
      queries,
      (query) => this.processLogoQuery(query, format),
      CONCURRENCY_LIMIT
    );

    // Map settled results to LogoResult, handling both fulfilled and rejected
    // Satisfies B2.4: Return partial results with failed items marked
    const results: LogoResult[] = settledResults.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        // Handle rejected promises (unexpected errors)
        return {
          query: queries[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      }
    });

    // Separate successful and failed results
    // Property B3: N-M successful results + M error markers
    const icons = results
      .filter((r) => r.success)
      .map((r) => ({
        icon: r.query,
        code: r.content?.split("\n").slice(1).join("\n") || "",
      }));

    const notFound = results
      .filter((r) => !r.success)
      .map((r) => ({
        icon: r.query,
        error: r.error || "Unknown error",
      }));

    logger.info(`Results: ${icons.length} found, ${notFound.length} failed`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ icons, notFound }, null, 2) }],
    };
  }
}
