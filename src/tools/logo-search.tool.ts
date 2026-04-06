import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { Logger } from "../logger.js";
import { sanitizeSvg } from "../http/svg-sanitizer.js";

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

const logoSearchSchema = z.object({
  queries: z.array(z.string()).describe("List of company names to search for logos"),
  format: z.enum(["JSX", "TSX", "SVG"]).describe("Output format"),
});

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const idx = i;
    const p = fn(items[idx])
      .then(value => { results[idx] = { status: "fulfilled", value }; })
      .catch(reason => { results[idx] = { status: "rejected", reason }; })
      .finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

export interface LogoSearchToolDeps {
  logger: Logger;
}

export class LogoSearchTool extends BaseTool<typeof logoSearchSchema> {
  readonly name = "magic_logo_search";
  readonly description = `
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
  readonly schema = logoSearchSchema;

  private readonly logger: Logger;

  constructor(deps: LogoSearchToolDeps) {
    super();
    this.logger = deps.logger;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchLogos(query: string): Promise<SVGLogo[]> {
    const url = `https://api.svgl.app?search=${encodeURIComponent(query)}`;
    try {
      const response = await this.fetchWithTimeout(url);
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      this.logger.error(`Error fetching logos:`, error);
      return [];
    }
  }

  private async fetchSVGContent(url: string): Promise<string> {
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) throw new Error(`Failed to fetch SVG: ${response.statusText}`);
    const rawSvg = await response.text();
    return sanitizeSvg(rawSvg);
  }

  private convertToFormat(svgContent: string, format: "JSX" | "TSX" | "SVG", name: string): string {
    if (format === "SVG") return svgContent;
    const jsx = svgContent.replace(/class=/g, "className=");
    const componentName = name.endsWith("Icon") ? name : `${name}Icon`;
    return format === "TSX"
      ? `const ${componentName}: React.FC = () => (${jsx})`
      : `function ${componentName}() { return (${jsx}) }`;
  }

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

  async execute(args: z.infer<typeof logoSearchSchema>): Promise<ToolResponse> {
    const { queries, format } = args;

    try {
      this.logger.info(`Searching: ${queries.join(", ")} (concurrency limit: ${CONCURRENCY_LIMIT})`);

      const settledResults = await pool(
        queries,
        (query) => this.processLogoQuery(query, format),
        CONCURRENCY_LIMIT
      );

      const results: LogoResult[] = settledResults.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        } else {
          return {
            query: queries[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        }
      });

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

      this.logger.info(`Results: ${icons.length} found, ${notFound.length} failed`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ icons, notFound }, null, 2) }],
      };
    } catch (error) {
      this.logger.error(`Logo search error:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.formatError(
        "Failed to search for logos. Please try again.",
        this.errorCode("SEARCH_ERROR"),
        { originalError: errorMessage }
      );
    }
  }
}
