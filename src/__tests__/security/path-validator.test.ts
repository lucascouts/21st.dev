import { describe, it, expect } from "bun:test";
import { PathValidator } from "../../security/path-validator.js";

describe("PathValidator", () => {
  const validator = new PathValidator();

  it("rejects paths with .. traversal", () => {
    expect(validator.containsTraversal("../../etc/passwd")).toBe(true);
    expect(validator.containsTraversal("foo/../bar")).toBe(true);
    expect(validator.containsTraversal("../secret")).toBe(true);
  });

  it("rejects URL-encoded traversal", () => {
    expect(validator.containsTraversal("%2e%2e/etc/passwd")).toBe(true);
    expect(validator.containsTraversal("%2E%2E/secret")).toBe(true);
    expect(validator.containsTraversal("foo/%2e%2e/bar")).toBe(true);
  });

  it("rejects double-encoded traversal", () => {
    expect(validator.containsTraversal("%252e%252e/etc/passwd")).toBe(true);
  });

  it("accepts valid paths without traversal", () => {
    expect(validator.containsTraversal("foo/bar/baz.txt")).toBe(false);
    expect(validator.containsTraversal("images/logo.png")).toBe(false);
    expect(validator.containsTraversal("simple-file.txt")).toBe(false);
  });

  it("accepts paths with dots that are not traversal", () => {
    expect(validator.containsTraversal("file.test.ts")).toBe(false);
    expect(validator.containsTraversal(".hidden")).toBe(false);
  });
});
