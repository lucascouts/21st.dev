import { describe, it, expect, mock } from "bun:test";
import { z } from "zod";
import { BaseTool } from "../../tools/base-tool.js";
import type { ToolResponse } from "../../tools/base-tool.js";

class TestTool extends BaseTool {
  readonly name = "magic_test-tool";
  readonly description = "A test tool";
  readonly schema = z.object({
    input: z.string(),
  });

  async execute(args: { input: string }): Promise<ToolResponse> {
    return {
      content: [{ type: "text", text: args.input }],
    };
  }
}

describe("BaseTool", () => {
  it("formatError returns correct structure with isError: true", () => {
    const tool = new TestTool();
    const result = (tool as any).formatError("Something went wrong", "TEST_ERROR", { detail: "info" });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Something went wrong");
    expect(parsed.code).toBe("TEST_ERROR");
    expect(parsed.details.detail).toBe("info");
  });

  it("errorCode returns TOOLNAME_ERRORTYPE format", () => {
    const tool = new TestTool();
    const code = (tool as any).errorCode("INVALID_INPUT");
    // magic_test-tool -> TEST_TOOL (strip magic_, uppercase, replace -)
    expect(code).toBe("TEST_TOOL_INVALID_INPUT");
  });

  it("register calls server.tool with schema.shape", () => {
    const tool = new TestTool();
    const toolFn = mock(() => {});
    const fakeServer = { tool: toolFn } as any;

    tool.register(fakeServer);

    expect(toolFn).toHaveBeenCalledTimes(1);
    const callArgs = toolFn.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe("magic_test-tool");
    expect(callArgs[1]).toBe("A test tool");
    // Third arg should be the schema shape
    expect(callArgs[2]).toHaveProperty("input");
  });
});
