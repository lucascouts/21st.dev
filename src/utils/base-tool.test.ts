import * as fc from "fast-check";
import { describe, it, expect } from "bun:test";
import { BaseTool, ToolError, ToolResponse } from "./base-tool.js";
import { z } from "zod";

// Concrete implementation for testing
class TestTool extends BaseTool {
  name = "magic_test_tool";
  description = "Test tool for error formatting";
  schema = z.object({
    input: z.string(),
  });

  async execute(args: z.infer<typeof this.schema>): Promise<ToolResponse> {
    return {
      content: [{ type: "text", text: `Processed: ${args.input}` }],
    };
  }
}

describe("BaseTool", () => {
  /**
   * Property C1: Error Format Consistency
   * For any error returned by any tool, the response SHALL contain
   * `error` (string) and `code` (string matching pattern `[A-Z_]+`).
   *
   * **Validates: Requirements C2.1, C2.2**
   */
  describe("Property C1: Error Format Consistency", () => {
    it("should always return errors with required fields", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => /^[A-Z_]+$/.test(s)),
          fc.option(
            fc.dictionary(
              fc.string({ minLength: 1, maxLength: 20 }),
              fc.oneof(fc.string(), fc.integer(), fc.boolean())
            ),
            { nil: undefined }
          ),
          (message, code, details) => {
            const tool = new TestTool();
            const result = tool["formatError"](message, code, details);

            // Response must have content array
            if (!result.content || !Array.isArray(result.content)) {
              return false;
            }

            // Must have at least one content item
            if (result.content.length === 0) {
              return false;
            }

            // First content item must be text type
            const firstContent = result.content[0];
            if (firstContent.type !== "text") {
              return false;
            }

            // Parse the JSON text
            let errorObj: ToolError;
            try {
              errorObj = JSON.parse(firstContent.text);
            } catch {
              return false;
            }

            // Must have error field (string)
            if (typeof errorObj.error !== "string") {
              return false;
            }

            // Must have code field (string matching pattern)
            if (typeof errorObj.code !== "string" || !/^[A-Z_]+$/.test(errorObj.code)) {
              return false;
            }

            // Error message must match input
            if (errorObj.error !== message) {
              return false;
            }

            // Code must match input
            if (errorObj.code !== code) {
              return false;
            }

            // If details provided, must be present in output
            if (details !== undefined) {
              if (!errorObj.details) {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should maintain error format consistency across different tools", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[A-Z_]+$/.test(s)),
          (message, errorType) => {
            const tool1 = new TestTool();
            const tool2 = new TestTool();

            const result1 = tool1["formatError"](message, errorType);
            const result2 = tool2["formatError"](message, errorType);

            // Both should produce identical output
            return JSON.stringify(result1) === JSON.stringify(result2);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Unit Tests - formatError() (Requirements C2.1, C2.2, C2.3)", () => {
    it("should format error with message and code", () => {
      const tool = new TestTool();
      const result = tool["formatError"]("Test error", "TEST_ERROR");

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const errorObj: ToolError = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Test error");
      expect(errorObj.code).toBe("TEST_ERROR");
      expect(errorObj.details).toBeUndefined();
    });

    it("should format error with details", () => {
      const tool = new TestTool();
      const details = { originalError: "Network timeout", statusCode: 500 };
      const result = tool["formatError"]("API request failed", "API_ERROR", details);

      const errorObj: ToolError = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("API request failed");
      expect(errorObj.code).toBe("API_ERROR");
      expect(errorObj.details).toEqual(details);
    });

    it("should format error without details when not provided", () => {
      const tool = new TestTool();
      const result = tool["formatError"]("Simple error", "SIMPLE_ERROR", undefined);

      const errorObj: ToolError = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Simple error");
      expect(errorObj.code).toBe("SIMPLE_ERROR");
      expect(errorObj.details).toBeUndefined();
    });

    it("should produce valid JSON", () => {
      const tool = new TestTool();
      const result = tool["formatError"]("Test", "TEST");

      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    });
  });

  describe("Unit Tests - generateErrorCode() (Requirement C2.2)", () => {
    it("should generate error code from tool name", () => {
      const tool = new TestTool();
      const code = tool["generateErrorCode"]("API_TIMEOUT");

      expect(code).toBe("TEST_TOOL_API_TIMEOUT");
    });

    it("should strip magic_ prefix from tool name", () => {
      const tool = new TestTool();
      const code = tool["generateErrorCode"]("INVALID_INPUT");

      expect(code).toBe("TEST_TOOL_INVALID_INPUT");
    });

    it("should convert hyphens to underscores", () => {
      class HyphenatedTool extends BaseTool {
        name = "magic_my-hyphenated-tool";
        description = "Test";
        schema = z.object({});
        async execute(): Promise<ToolResponse> {
          return { content: [] };
        }
      }

      const tool = new HyphenatedTool();
      const code = tool["generateErrorCode"]("ERROR");

      expect(code).toBe("MY_HYPHENATED_TOOL_ERROR");
    });

    it("should uppercase tool name", () => {
      class LowercaseTool extends BaseTool {
        name = "magic_lowercase";
        description = "Test";
        schema = z.object({});
        async execute(): Promise<ToolResponse> {
          return { content: [] };
        }
      }

      const tool = new LowercaseTool();
      const code = tool["generateErrorCode"]("ERROR");

      expect(code).toBe("LOWERCASE_ERROR");
    });

    it("should follow TOOL_ERROR_TYPE pattern", () => {
      const tool = new TestTool();
      const code = tool["generateErrorCode"]("NETWORK_ERROR");

      expect(code).toMatch(/^[A-Z_]+$/);
      expect(code).toContain("_");
    });
  });

  describe("Unit Tests - Error Code Pattern Validation (Requirement C2.2)", () => {
    it("should generate codes matching [A-Z_]+ pattern", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[A-Z_]+$/.test(s)),
          (errorType) => {
            const tool = new TestTool();
            const code = tool["generateErrorCode"](errorType);

            return /^[A-Z_]+$/.test(code);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
