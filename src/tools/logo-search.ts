import { z } from "zod";
import { BaseTool } from "../utils/base-tool.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("LogoSearch");

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

  async execute({ queries, format }: z.infer<typeof this.schema>) {
    logger.info(`Searching: ${queries.join(", ")}`);
    const results = await Promise.all(
      queries.map(async (query) => {
        try {
          const logos = await this.fetchLogos(query);
          if (logos.length === 0) return { query, success: false, message: `No logo found: ${query}` };
          const logo = logos[0];
          const svgUrl = typeof logo.route === "string" ? logo.route : logo.route.light;
          const svg = await this.fetchSVGContent(svgUrl);
          const code = this.convertToFormat(svg, format, logo.title + "Icon");
          return { query, success: true, content: `// ${logo.title}\n${code}` };
        } catch (error) {
          return { query, success: false, message: String(error) };
        }
      })
    );

    const icons = results.filter((r) => r.success).map((r) => ({
      icon: r.query,
      code: r.content?.split("\n").slice(1).join("\n") || "",
    }));
    const notFound = results.filter((r) => !r.success).map((r) => ({ icon: r.query }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ icons, notFound }, null, 2) }],
    };
  }
}
