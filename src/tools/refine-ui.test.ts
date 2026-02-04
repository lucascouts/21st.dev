import { RefineUiTool } from "./refine-ui.js";
import { twentyFirstClient } from "../utils/http-client.js";
import { getContentOfFile } from "../utils/get-content-of-file.js";

// Mock the http-client module
jest.mock("../utils/http-client.js", () => ({
  twentyFirstClient: {
    post: jest.fn(),
  },
}));

// Mock the get-content-of-file module
jest.mock("../utils/get-content-of-file.js", () => ({
  getContentOfFile: jest.fn(),
}));

const mockedPost = twentyFirstClient.post as jest.MockedFunction<
  typeof twentyFirstClient.post
>;
const mockedGetContentOfFile = getContentOfFile as jest.MockedFunction<
  typeof getContentOfFile
>;

describe("RefineUiTool", () => {
  let tool: RefineUiTool;

  beforeEach(() => {
    tool = new RefineUiTool();
    jest.clearAllMocks();
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

    /**
     * Test successful refinement scenario
     * Requirements: FR-3.2, FR-3.3, FR-3.4
     */
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
        content: [
          {
            type: "text",
            text: mockResponse.text,
          },
        ],
      });
    });

    /**
     * Test file read error handling
     * Requirements: FR-3.2, FR-3.3, FR-3.4
     */
    it("should throw error when file cannot be read", async () => {
      const fileError = new Error("File not found");
      mockedGetContentOfFile.mockRejectedValueOnce(fileError);

      await expect(tool.execute(validInput)).rejects.toThrow("File not found");

      expect(mockedGetContentOfFile).toHaveBeenCalledWith(
        validInput.absolutePathToRefiningFile
      );
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it("should throw error when file path is invalid", async () => {
      const invalidPathError = new Error("Invalid file path");
      mockedGetContentOfFile.mockRejectedValueOnce(invalidPathError);

      await expect(tool.execute(validInput)).rejects.toThrow(
        "Invalid file path"
      );
    });

    /**
     * Test API error handling
     * Requirements: FR-3.2, FR-3.3, FR-3.4
     */
    it("should throw error on non-200 status", async () => {
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 500,
        data: { error: "Internal server error" },
      });

      await expect(tool.execute(validInput)).rejects.toThrow(
        "API returned status 500"
      );
    });

    it("should throw error on 404 status", async () => {
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 404,
        data: { error: "Not found" },
      });

      await expect(tool.execute(validInput)).rejects.toThrow(
        "API returned status 404"
      );
    });

    it("should throw error on 400 status", async () => {
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 400,
        data: { error: "Bad request" },
      });

      await expect(tool.execute(validInput)).rejects.toThrow(
        "API returned status 400"
      );
    });

    /**
     * Test network error handling
     * Requirements: FR-3.2, FR-3.3, FR-3.4
     */
    it("should propagate network errors", async () => {
      const networkError = new Error("Network connection failed");
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockRejectedValueOnce(networkError);

      await expect(tool.execute(validInput)).rejects.toThrow(
        "Network connection failed"
      );
    });

    it("should propagate timeout errors", async () => {
      const timeoutError = new Error("Request timed out");
      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockRejectedValueOnce(timeoutError);

      await expect(tool.execute(validInput)).rejects.toThrow(
        "Request timed out"
      );
    });

    /**
     * Test empty context handling
     * Requirements: FR-3.2, FR-3.3, FR-3.4
     */
    it("should handle empty context string", async () => {
      const inputWithEmptyContext = {
        ...validInput,
        context: "",
      };

      const mockResponse = {
        text: "Refined component without specific context...",
      };

      mockedGetContentOfFile.mockResolvedValueOnce(mockFileContent);
      mockedPost.mockResolvedValueOnce({
        status: 200,
        data: mockResponse,
      });

      const result = await tool.execute(inputWithEmptyContext);

      expect(mockedPost).toHaveBeenCalledWith("/api/refine-ui", {
        userMessage: inputWithEmptyContext.userMessage,
        fileContent: mockFileContent,
        context: "",
      });

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: mockResponse.text,
          },
        ],
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
