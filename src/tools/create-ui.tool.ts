import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { HttpClient } from "../http/client.js";
import { textResponseSchema } from "../http/api-response.js";
import { FAILURE_MESSAGES, failureLogDetail } from "../http/failure.js";
import type { BrowserDetector } from "../browser/detector.js";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import { CallbackServer } from "../callback/callback-server.js";
import { CorsHandler } from "../callback/cors.js";
import { RateLimiter } from "../security/rate-limiter.js";
import { ShellSanitizer } from "../security/shell-sanitizer.js";
import { PathValidator } from "../security/path-validator.js";

const createUiSchema = z.object({
  message: z.string().describe("Full users message"),
  searchQuery: z
    .string()
    .describe(
      "Generate a search query for 21st.dev (library for searching UI components) to find a UI component that matches the user's message. Must be a two-four words max or phrase"
    ),
  absolutePathToCurrentFile: z
    .string()
    .describe("Absolute path to the current file to which we want to apply changes"),
  standaloneRequestQuery: z
    .string()
    .describe(
      "You need to formulate what component user wants to create, based on his message, possbile chat histroy and a place where he makes the request. Extract additional context about what should be done to create a ui component/page based on the user's message, search query, and conversation history, files. Don't halucinate and be on point."
    ),
});

/**
 * The content of the caller's file, or the reason it must not be read.
 *
 * A refusal travels as a value rather than a throw so the caller reports it as
 * itself. Routing it through the surrounding `catch` would answer a confinement
 * failure with "check your API key", and a wrong explanation is barely better
 * than the `catch {}` that used to give none at all.
 */
type FileReadOutcome =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string };

export interface CreateUiToolDeps {
  httpClient: HttpClient;
  browserDetector: BrowserDetector;
  logger: Logger;
  config: Config;
}

export class CreateUiTool extends BaseTool<typeof createUiSchema> {
  readonly name = "magic_component_builder";
  readonly description = `
"Use this tool when the user requests a new UI component\u2014e.g., mentions /ui, /21 /21st, or asks for a button, input, dialog, table, form, banner, card, or other React component.
This tool ONLY returns the text snippet for that UI component.
After calling this tool, you must edit or add files to integrate the snippet into the codebase."
`;
  readonly schema = createUiSchema;

  private readonly httpClient: HttpClient;
  private readonly browserDetector: BrowserDetector;
  private readonly logger: Logger;
  private readonly config: Config;

  constructor(deps: CreateUiToolDeps) {
    super();
    this.httpClient = deps.httpClient;
    this.browserDetector = deps.browserDetector;
    this.logger = deps.logger;
    this.config = deps.config;
  }

  async execute(args: z.infer<typeof createUiSchema>): Promise<ToolResponse> {
    const { standaloneRequestQuery, absolutePathToCurrentFile, message, searchQuery } = args;

    this.logger.info(`Creating UI component...`);
    this.logger.debug(`Query: ${standaloneRequestQuery}`);

    // Try browser + callback first
    const browserResult = await this.tryBrowserCallback(standaloneRequestQuery);

    if (browserResult) {
      // Check if it's a URL for manual opening
      if (browserResult.startsWith("BROWSER_URL:")) {
        const url = browserResult.replace("BROWSER_URL:", "");
        this.logger.warn(`Browser could not be opened automatically`);

        // Fall back to API but include the URL in case user wants to browse
        const apiResult = await this.fallbackToApi(message, searchQuery, absolutePathToCurrentFile);

        // A failure is returned as itself. Rebuilding the response by hand below
        // drops `isError`, which is how a refusal would reach the caller looking
        // like a successful result; it would also splice markdown into
        // `formatError`'s JSON payload and leave it unparseable.
        if (apiResult.isError) {
          return apiResult;
        }

        // Prepend URL info to the response
        const urlInfo = `\n\n---\n**Browse components visually:** [Open 21st.dev Magic Chat](${url})\n---\n\n`;
        return {
          content: [{
            type: "text" as const,
            text: urlInfo + apiResult.content[0].text,
          }],
        };
      }

      this.logger.info(`Got result from browser callback`);
      return {
        content: [{ type: "text" as const, text: this.formatResponse(browserResult) }],
      };
    }

    // Fallback to direct API
    this.logger.info(`Browser callback failed/timed out, using API fallback`);
    return this.fallbackToApi(message, searchQuery, absolutePathToCurrentFile);
  }

  private async tryBrowserCallback(query: string): Promise<string | null> {
    try {
      const server = new CallbackServer({
        maxBodySize: this.config.maxBodySize,
        cors: CorsHandler,
        rateLimiter: new RateLimiter(),
        logger: this.logger,
      });
      const port = await server.start();
      this.logger.debug(`Callback server started on port ${port}`);

      const rawUrl = `https://21st.dev/magic-chat?q=${encodeURIComponent(query)}&mcp=true&port=${port}`;
      let url: string;
      try {
        url = ShellSanitizer.sanitizeUrl(rawUrl);
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this.logger.debug(`URL sanitization failed: ${errorMessage}`);
        server.cancel();
        return null;
      }

      const browserOpened = await this.browserDetector.openUrl(url);

      if (!browserOpened) {
        this.logger.warn(`Could not open browser, please open manually: ${url}`);
        server.cancel();
        return `BROWSER_URL:${url}`;
      }

      this.logger.debug(`Browser opened, waiting for callback...`);
      const result = await server.waitForCallback(120000);

      if (!result.ok) {
        this.logger.debug(`Browser callback failed: ${result.reason}`);
        return null;
      }

      return result.data;
    } catch (error) {
      this.logger.error(`Browser callback error:`, error);
      return null;
    }
  }

  private async fallbackToApi(
    message: string,
    searchQuery: string,
    absolutePathToCurrentFile: string
  ): Promise<ToolResponse> {
    const currentFile = await this.readCurrentFile(absolutePathToCurrentFile);
    if (!currentFile.ok) {
      return this.formatError(
        `Cannot read the file at the given path: ${currentFile.reason}`,
        this.errorCode("FILE_ACCESS_ERROR"),
        { path: absolutePathToCurrentFile }
      );
    }

    try {
      const result = await this.httpClient.post(
        "/api/fetch-ui",
        { message, searchQuery, fileContent: currentFile.content },
        textResponseSchema
      );

      // `!data?.text` is gone from this condition because the schema now decides
      // it: `ok` cannot be true unless `text` is a string. That also ends the
      // measured coercion — `{text:123}` reaching the agent as `"123"`.
      if (!result.ok) {
        // Two audiences, per failure.ts. The log gets which call ended and its
        // remote-chosen status; the client gets the constant for the kind, plus
        // the kind itself — a name from a closed set an agent can branch on
        // (R2.1). Nothing remote is interpolated into either (R2.2).
        this.logger.error(
          failureLogDetail(result.kind, `POST /api/fetch-ui (status ${result.status})`)
        );
        return this.formatError(FAILURE_MESSAGES[result.kind], this.errorCode("API_ERROR"), {
          kind: result.kind,
        });
      }

      this.logger.info(`Got result from API fallback`);
      return {
        content: [{ type: "text" as const, text: this.formatResponse(result.data.text) }],
      };
    } catch (error) {
      // Unreachable by `HttpClient`'s contract: it RETURNS its failures rather
      // than throwing them, and the file read above has already returned. Kept
      // so a local fault is still REPORTED — an error escaping `execute`
      // reaches the agent as a JSON-RPC error with no `isError` and no tool
      // content, the same class of defect as the -32602 this sub-task closes,
      // arriving by a different door. The engine string is logged and never
      // returned: `FailureKind` names REMOTE-call failures, and none of them is
      // "our own defect".
      this.logger.error(`magic_component_builder failed unexpectedly:`, error);
      return this.formatError(
        "the tool failed unexpectedly; the server log has the detail",
        this.errorCode("UNEXPECTED_ERROR")
      );
    }
  }

  /**
   * The file the caller wants changed, confined to `config.allowedRoots`.
   *
   * Shaped after the read in `refine-ui.tool.ts`: validate, refuse an invalid
   * path, check existence, check `config.maxFileSize`, read. The size bound is
   * that existing setting rather than a second one, so both tools stay on one
   * knob (R3.4). Over the bound the file is refused, never truncated: half a
   * file is still bytes on the wire the operator capped.
   *
   * One deliberate difference from `refine-ui`: a path INSIDE a root that does
   * not exist yet is not a failure here. This tool builds a NEW component, so
   * the file the snippet lands in may not exist; the call proceeds without file
   * context and says so at `warn`. That is not the swallowed case — nothing
   * left the boundary. Everything the boundary refuses (outside every root,
   * traversal, a symlink leaving a root, over the size bound, an unreadable
   * file) stops the call instead of shipping an empty `fileContent` in silence.
   */
  private async readCurrentFile(absolutePath: string): Promise<FileReadOutcome> {
    try {
      const pathValidator = new PathValidator();
      const validation = await pathValidator.validate(absolutePath, this.config.allowedRoots);
      if (!validation.valid || !validation.normalizedPath) {
        // The validator names every refusal it makes; the fallback covers only a
        // result with neither a reason nor a path, and must not invent a cause.
        return this.refuseFile(absolutePath, validation.error ?? "the path could not be validated");
      }

      const file = Bun.file(validation.normalizedPath);
      const exists = await file.exists();
      if (!exists) {
        // Empty content HERE is a confined path with nothing at it yet, announced
        // — not the swallowed refusal this sub-task removes. Every refusal below
        // returns `ok: false`, never an empty string.
        this.logger.warn(
          `No file at ${absolutePath}; building the component without file context`
        );
        return { ok: true, content: "" };
      }

      const fileSize = file.size;
      if (fileSize > this.config.maxFileSize) {
        return this.refuseFile(
          absolutePath,
          `file size (${fileSize} bytes) exceeds maximum allowed size (${this.config.maxFileSize} bytes)`
        );
      }

      return { ok: true, content: await file.text() };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.refuseFile(absolutePath, errorMessage);
    }
  }

  /**
   * R3.3, both halves: the refusal is logged at `warn` NAMING the path, and
   * returned so the caller is told. The path is what makes the line actionable
   * — a warning that says only "invalid path" cannot be acted on, and this tool
   * spent every released 2.x version proving that silence is worse still.
   */
  private refuseFile(
    absolutePath: string,
    reason: string
  ): { readonly ok: false; readonly reason: string } {
    this.logger.warn(`Refusing to read ${absolutePath}: ${reason}`);
    return { ok: false, reason };
  }

  private formatResponse(prompt: string): string {
    return `${prompt}

## Shadcn/ui instructions
After you add the component, make sure to add the component to the project. If you can't resolve components from demo code,
Make sure to install shadcn/ui components from the demo code missing imports

Examples of importing shadcn/ui components:
if these imports can't be resolved:
\`\`\`tsx
import {
  Table
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
\`\`\`

then run this command:
\`\`\`bash
npx shadcn@latest add table textarea
\`\`\``;
  }
}
