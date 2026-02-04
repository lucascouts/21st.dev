import { FetchUiTool } from "./fetch-ui.js";
import { twentyFirstClient } from "../utils/http-client.js";

// Mock the http-client module
jest.mock("../utils/http-client.js", () => ({
  twentyFirstClient: {
    post: jest.fn(),
  },
}));

const mockedPost = twentyFirstClient.post as jest.MockedFunction<
  typeof twentyFirstClient.post
>;

describe("FetchUiTool", () => {
  let tool: FetchUiTool;

  beforeEach(() => {
    tool = new FetchUiTool();
    jest.clearAllMocks();
  });

  describe("execute", () => {
    const validInput = {
      message: "I need a button component",
      searchQuery: "button primary",
    };

    /**
     * Test successful fetch scenario (200 status)
     * Requirements: FR-3.1, FR-3.3, FR-3.4
     */
    it("should return component data on successful fetch", async () => {
      const mockResponse = {
        text: "Here is your button component code...",
      };

      mockedPost.mockResolvedValueOnce({
        status: 200,
        data: mockResponse,
      });

      const result = await tool.execute(validInput);

      expect(mockedPost).toHaveBeenCalledWith("/api/fetch-ui", {
        message: validInput.message,
        searchQuery: validInput.searchQuery,
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
     * Test API error handling (non-200 status)
     * Requirements: FR-3.1, FR-3.3, FR-3.4, C2.1, C2.2
     */
    it("should return formatted error on non-200 status", async () => {
      mockedPost.mockResolvedValueOnce({
        status: 500,
        data: { error: "Internal server error" },
      });

      const result = await tool.execute(validInput);
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to fetch UI inspiration. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_INSPIRATION_API_ERROR");
      expect(errorObj.details).toBeDefined();
    });

    it("should return formatted error on 404 status", async () => {
      mockedPost.mockResolvedValueOnce({
        status: 404,
        data: { error: "Not found" },
      });

      const result = await tool.execute(validInput);
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to fetch UI inspiration. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_INSPIRATION_API_ERROR");
    });

    /**
     * Test network error handling
     * Requirements: FR-3.1, FR-3.3, FR-3.4, C2.1, C2.2
     */
    it("should return formatted error on network errors", async () => {
      const networkError = new Error("Network connection failed");
      mockedPost.mockRejectedValueOnce(networkError);

      const result = await tool.execute(validInput);
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to fetch UI inspiration. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_INSPIRATION_API_ERROR");
      expect(errorObj.details?.originalError).toBe("Network connection failed");
    });

    it("should return formatted error on timeout errors", async () => {
      const timeoutError = new Error("Request timed out");
      mockedPost.mockRejectedValueOnce(timeoutError);

      const result = await tool.execute(validInput);
      
      const errorObj = JSON.parse(result.content[0].text);
      expect(errorObj.error).toBe("Failed to fetch UI inspiration. Please try again or check your API key.");
      expect(errorObj.code).toBe("COMPONENT_INSPIRATION_API_ERROR");
      expect(errorObj.details?.originalError).toBe("Request timed out");
    });
  });

  describe("tool metadata", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("magic_component_inspiration");
    });

    it("should have a description", () => {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(0);
    });
  });
});
