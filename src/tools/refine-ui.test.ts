import { RefineUiTool } from "./refine-ui.js";
import * as httpClient from "../utils/http-client.js";
import * as fileReader from "../utils/get-content-of-file.js";

describe("RefineUiTool", () => {
  let tool: RefineUiTool;
  let mockedPost: ReturnType<typeof jest.spyOn>;
  let mockedGetContentOfFile: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    tool = new RefineUiTool();
    // Use spyOn instead of jest.mock to avoid module-level pollution
    mockedPost = jest.spyOn(httpClient.twentyFirstClient, "post");
    mockedGetContentOfFile = jest.spyOn(fileReader, "getContentOfFile");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("execute", () => {
    const validInput = {
      userMessage: "Make the button more modern",
      absolutePathToRefiningFile: "/path/to/component.tsx",
      context: "Update button styling to use rounded corners and shadows",
    };

    const mockFileContent = `
      export const Button = () => {
        return <button>Click me</button>;
      };
    `;

    it("should return refined component on successful refinement", async () => {
      const mockResponse = {
        text: "Here is your refined button component with modern styling...",
      };

      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 200,
        data: mockResponse,
      });

      const result = await tool.execute(validInput);

      expect(mockedGetContentOfFile).toHaveBeenCalledWith(
        validInput.absolutePathToRefiningFile
      );

      expect(mockedPost).toHaveBeenCalledWith("/api/refine-ui", {
        userMessage: validInput.userMessage,
        fileContent: mockFileContent,
        context: validInput.context,
      });

      expect(result).toEqual({
        content: [{ type: "text", text: mockResponse.text }],
      });
    });

    it("should call API even when file returns empty content", async () => {
      // getContentOfFile returns empty string on error, doesn't throw
      mockedGetContentOfFile.mockResolvedValueOnce("");
      mockedPost.mockResolvedValueOnce({
        status: 200,
        data: { text: "Refined without file content" },
      });

      const result = await tool.execute(validInput);

      expect(mockedPost).toHaveBeenCalledWith("/api/refine-ui", {
        userMessage: validInput.userMessage,
        fileContent: "",
        context: validInput.context,
      });
      expect(result.content[0].text).toBe("Refined without file content");
    });

    it("should handle file read returning empty string", async () => {
      mockedGetContentOfFile.mockResolvedValueOnce("");
      mockedPost.mockResolvedValueOnce({
        status: 200,
        data: { text: "Refined" },
      });

      const result = await tool.execute(validInput);
      expect(result.content[0].text).toBe("Refined");
    });

    it("should return formatted error on non-200 status", async () => {
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 500,
        data: { error: "Internal server error" },
      });

      const result = await tool.execute(validInput);
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to refine UI component. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_REFINER_API_ERROR");
      expect(errorObj.details).toBeDefined();
    });

    it("should return formatted error on 404 status", async () => {
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 404,
        data: { error: "Not found" },
      });

      const result = await tool.execute(validInput);
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to refine UI component. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_REFINER_API_ERROR");
    });

    it("should return formatted error on 400 status", async () => {
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 400,
        data: { error: "Bad request" },
      });

      const result = await tool.execute(validInput);
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to refine UI component. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_REFINER_API_ERROR");
    });

    it("should return formatted error on network errors", async () => {
      const networkError = new Error("Network connection failed");
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockRejectedValueOnce(networkError);

      const result = await tool.execute(validInput);
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to refine UI component. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_REFINER_API_ERROR");
      expect(errorObj.details?.originalError).toBe("Network connection failed");
    });

    it("should return formatted error on timeout errors", async () => {
      const timeoutError = new Error("Request timed out");
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockRejectedValueOnce(timeoutError);

      const result = await tool.execute(validInput);
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to refine UI component. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_REFINER_API_ERROR");
      expect(errorObj.details?.originalError).toBe("Request timed out");
    });

    it("should handle empty context string", async () => {
      const inputWithEmptyContext = { ...validInput, context: "" };
      const mockResponse = { text: "Refined component without specific context..." };

      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({ status: 200, data: mockResponse });

      const result = await tool.execute(inputWithEmptyContext);

      expect(mockedPost).toHaveBeenCalledWith("/api/refine-ui", {
        userMessage: inputWithEmptyContext.userMessage,
        fileContent: mockFileContent,
        context: "",
      });

      expect(result).toEqual({
        content: [{ type: "text", text: mockResponse.text }],
      });
    });
  });

  describe("tool metadata", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("magic_component_refiner");
    });

    it("should have a description", () => {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(0);
    });
  });
});
