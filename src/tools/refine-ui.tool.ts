import { z } from "zod";
import { BaseTool, type ToolResponse } from "./base-tool.js";
import type { HttpClient } from "../http/client.js";
import { textResponseSchema } from "../http/api-response.js";
import { FAILURE_MESSAGES, failureLogDetail } from "../http/failure.js";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import { PathValidator } from "../security/path-validator.js";

const refineUiSchema = z.object({
  userMessage: z.string().describe("Full user's message about UI refinement"),
  absolutePathToRefiningFile: z
    .string()
    .describe("Absolute path to the file that needs to be refined"),
  context: z
    .string()
    .describe(
      "Extract the specific UI elements and aspects that need improvement based on user messages, code, and conversation history. Identify exactly which components (buttons, forms, modals, etc.) the user is referring to and what aspects (styling, layout, responsiveness, etc.) they want to enhance. Do not include generic improvements - focus only on what the user explicitly mentions or what can be reasonably inferred from the available context. If nothing specific is mentioned or you cannot determine what needs improvement, return an empty string."
    ),
});

/**
 * The content of the file to refine, or the reason it must not be read.
 *
 * A refusal travels as a VALUE rather than a throw, the shape `create-ui`
 * already uses. Routing it through a `catch` is how a path problem came to be
 * reported as "check your API key", and it is also what forced an engine string
 * into the client-facing payload: a `catch` cannot tell a message this tool
 * wrote from one a JavaScript runtime wrote, so it either forwards both or
 * neither.
 */
type FileReadOutcome =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string };

export interface RefineUiToolDeps {
  httpClient: HttpClient;
  logger: Logger;
  config: Config;
}

export class RefineUiTool extends BaseTool<typeof refineUiSchema> {
  readonly name = "magic_component_refiner";
  readonly description = `
"Use this tool when the user requests to re-design/refine/improve current UI component with /ui or /21 commands,
or when context is about improving, or refining UI for a React component or molecule (NOT for big pages).
This tool improves UI of components and returns redesigned version of the component and instructions on how to implement it."
`;
  readonly schema = refineUiSchema;

  private readonly httpClient: HttpClient;
  private readonly logger: Logger;
  private readonly config: Config;

  constructor(deps: RefineUiToolDeps) {
    super();
    this.httpClient = deps.httpClient;
    this.logger = deps.logger;
    this.config = deps.config;
  }

  async execute(args: z.infer<typeof refineUiSchema>): Promise<ToolResponse> {
    const { userMessage, absolutePathToRefiningFile, context } = args;

    this.logger.info(`Refining UI component...`);
    this.logger.debug(`File: ${absolutePathToRefiningFile}`);

    // Outside the `try` on purpose: a file this tool refuses to read is reported
    // as itself, with the reason it was refused, and never as an API problem.
    const currentFile = await this.readRefiningFile(absolutePathToRefiningFile);
    if (!currentFile.ok) {
      return this.formatError(
        `Cannot read the file at the given path: ${currentFile.reason}`,
        this.errorCode("FILE_ACCESS_ERROR"),
        { path: absolutePathToRefiningFile }
      );
    }

    try {
      const result = await this.httpClient.post(
        "/api/refine-ui",
        { userMessage, fileContent: currentFile.content, context },
        textResponseSchema
      );

      if (!result.ok) {
        // Two audiences, per failure.ts. The log gets which call ended and its
        // remote-chosen status; the client gets the constant for the kind, plus
        // the kind itself — a name from a closed set an agent can branch on
        // (R2.1). Nothing remote is interpolated into either (R2.2).
        this.logger.error(
          failureLogDetail(result.kind, `POST /api/refine-ui (status ${result.status})`)
        );
        return this.formatError(FAILURE_MESSAGES[result.kind], this.errorCode("API_ERROR"), {
          kind: result.kind,
        });
      }

      this.logger.info(`Successfully refined component`);

      return {
        content: [
          {
            type: "text" as const,
            text: result.data.text,
          },
        ],
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
      this.logger.error(`magic_component_refiner failed unexpectedly:`, error);
      return this.formatError(
        "the tool failed unexpectedly; the server log has the detail",
        this.errorCode("UNEXPECTED_ERROR")
      );
    }
  }

  /**
   * The file the caller wants refined, confined to `config.allowedRoots`
   * (R3.1-R3.4).
   *
   * The checks are the ones this tool already made — validate, exist, size,
   * read — with the outcome returned instead of thrown. Unlike `create-ui`,
   * a missing file IS a refusal here: there is nothing to refine.
   *
   * The bound is `config.maxFileSize`, the setting the operator already has,
   * and an oversize file is refused rather than truncated: half a file is still
   * bytes on the wire the operator capped.
   */
  private async readRefiningFile(absolutePath: string): Promise<FileReadOutcome> {
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
        return this.refuseFile(absolutePath, "no file exists at that path");
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
      // A LOCAL filesystem error (`EACCES`, `EISDIR`). It is not remote text,
      // so R2.2 does not reach it, and it is the one string that tells the
      // caller which of their own paths is unusable and why.
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.refuseFile(absolutePath, errorMessage);
    }
  }

  /**
   * R3.3, both halves: the refusal is logged at `warn` NAMING the path, and
   * returned so the caller is told. The path is what makes the line actionable
   * — a warning that says only "invalid path" cannot be acted on.
   */
  private refuseFile(
    absolutePath: string,
    reason: string
  ): { readonly ok: false; readonly reason: string } {
    this.logger.warn(`Refusing to read ${absolutePath}: ${reason}`);
    return { ok: false, reason };
  }
}
