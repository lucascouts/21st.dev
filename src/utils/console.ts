// Override console for MCP stdio transport compatibility

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "object" || Array.isArray(arg)) {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ");
}

function createJsonRpcWrapper(
  originalFn: (...args: unknown[]) => void,
  type: number
): (...args: unknown[]) => void {
  return function (...args: unknown[]) {
    originalFn(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "window/logMessage",
        params: { type, message: formatArgs(args) },
      })
    );
  };
}

export function setupJsonConsole() {
  console.log = createJsonRpcWrapper(originalConsoleLog, 3);
  console.error = createJsonRpcWrapper(originalConsoleError, 1);
  console.warn = createJsonRpcWrapper(originalConsoleWarn, 2);
}
