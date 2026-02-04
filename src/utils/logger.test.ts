import { Logger, LogLevel } from "./logger.js";

describe("Logger", () => {
  let originalEnv: string | undefined;
  let consoleSpy: {
    log: jest.SpyInstance;
    warn: jest.SpyInstance;
    error: jest.SpyInstance;
  };

  beforeEach(() => {
    originalEnv = process.env.LOG_LEVEL;
    consoleSpy = {
      log: jest.spyOn(console, "log").mockImplementation(),
      warn: jest.spyOn(console, "warn").mockImplementation(),
      error: jest.spyOn(console, "error").mockImplementation(),
    };
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalEnv;
    }
    jest.restoreAllMocks();
  });

  describe("Log Level Filtering - Requirements 9.1, 9.2, 9.3, 9.4, 9.5", () => {
    /**
     * Requirement 9.1: WHEN LOG_LEVEL is set to "debug",
     * THE MCP_Server SHALL output all log messages
     */
    it("should output all messages when LOG_LEVEL=debug", () => {
      const logger = new Logger();
      logger.setLevel("debug");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleSpy.log).toHaveBeenCalledTimes(2); // debug + info
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    /**
     * Requirement 9.2: WHEN LOG_LEVEL is set to "info",
     * THE MCP_Server SHALL output info, warn, and error messages
     */
    it("should output info, warn, error when LOG_LEVEL=info", () => {
      const logger = new Logger();
      logger.setLevel("info");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleSpy.log).toHaveBeenCalledTimes(1); // only info
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    /**
     * Requirement 9.3: WHEN LOG_LEVEL is set to "warn",
     * THE MCP_Server SHALL output warn and error messages only
     */
    it("should output warn and error only when LOG_LEVEL=warn", () => {
      const logger = new Logger();
      logger.setLevel("warn");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleSpy.log).toHaveBeenCalledTimes(0);
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    /**
     * Requirement 9.4: WHEN LOG_LEVEL is set to "error",
     * THE MCP_Server SHALL output error messages only
     */
    it("should output error only when LOG_LEVEL=error", () => {
      const logger = new Logger();
      logger.setLevel("error");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleSpy.log).toHaveBeenCalledTimes(0);
      expect(consoleSpy.warn).toHaveBeenCalledTimes(0);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    /**
     * Requirement 9.5: WHEN LOG_LEVEL is not set,
     * THE MCP_Server SHALL default to "info" level
     */
    it("should default to info level when LOG_LEVEL is not set", () => {
      delete process.env.LOG_LEVEL;
      const logger = new Logger();

      expect(logger.getLevel()).toBe("info");

      logger.debug("debug message");
      logger.info("info message");

      expect(consoleSpy.log).toHaveBeenCalledTimes(1); // only info, not debug
    });
  });

  describe("Environment Variable Parsing", () => {
    it("should handle uppercase LOG_LEVEL values", () => {
      process.env.LOG_LEVEL = "DEBUG";
      const logger = new Logger();
      expect(logger.getLevel()).toBe("debug");
    });

    it("should handle mixed case LOG_LEVEL values", () => {
      process.env.LOG_LEVEL = "WaRn";
      const logger = new Logger();
      expect(logger.getLevel()).toBe("warn");
    });

    it("should default to info for invalid LOG_LEVEL values", () => {
      process.env.LOG_LEVEL = "invalid";
      const logger = new Logger();
      expect(logger.getLevel()).toBe("info");
    });
  });

  describe("Logger Prefix", () => {
    it("should include prefix in log messages when provided", () => {
      const logger = new Logger("TestModule");
      logger.setLevel("debug");

      logger.info("test message");

      expect(consoleSpy.log).toHaveBeenCalledWith(
        "[TestModule][INFO]",
        "test message"
      );
    });

    it("should not include prefix brackets when no prefix provided", () => {
      const logger = new Logger();
      logger.setLevel("debug");

      logger.info("test message");

      expect(consoleSpy.log).toHaveBeenCalledWith("[INFO]", "test message");
    });
  });

  describe("Message Formatting", () => {
    it("should format objects as JSON", () => {
      const logger = new Logger();
      logger.setLevel("debug");

      logger.info({ key: "value" });

      expect(consoleSpy.log).toHaveBeenCalledWith(
        "[INFO]",
        '{"key":"value"}'
      );
    });

    it("should format arrays as JSON", () => {
      const logger = new Logger();
      logger.setLevel("debug");

      logger.info([1, 2, 3]);

      expect(consoleSpy.log).toHaveBeenCalledWith("[INFO]", "[1,2,3]");
    });

    it("should join multiple arguments with spaces", () => {
      const logger = new Logger();
      logger.setLevel("debug");

      logger.info("hello", "world", 123);

      expect(consoleSpy.log).toHaveBeenCalledWith("[INFO]", "hello world 123");
    });
  });

  describe("setLevel method", () => {
    it("should allow changing log level programmatically", () => {
      const logger = new Logger();
      logger.setLevel("error");

      expect(logger.getLevel()).toBe("error");

      logger.info("should not appear");
      expect(consoleSpy.log).not.toHaveBeenCalled();

      logger.setLevel("debug");
      logger.info("should appear");
      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    });

    it("should ignore invalid log levels", () => {
      const logger = new Logger();
      const originalLevel = logger.getLevel();

      logger.setLevel("invalid" as LogLevel);

      expect(logger.getLevel()).toBe(originalLevel);
    });
  });
});
