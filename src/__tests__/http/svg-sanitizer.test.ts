import { describe, it, expect } from "bun:test";
import { sanitizeSvg } from "../../http/svg-sanitizer.js";

describe("sanitizeSvg", () => {
  it("strips <script> tags", () => {
    const input = '<svg><script>alert("xss")</script><rect/></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("<script");
    expect(result).toContain("<rect/>");
  });

  it("strips self-closing <script/> tags", () => {
    const input = '<svg><script src="evil.js"/><rect/></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("<script");
  });

  it("strips event handlers (onclick)", () => {
    const input = '<svg><rect onclick="alert(1)" /></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toMatch(/onclick/i);
  });

  it("strips event handlers (onload)", () => {
    const input = '<svg onload="alert(1)"><rect/></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toMatch(/onload/i);
  });

  it("strips <foreignObject>", () => {
    const input = '<svg><foreignObject><div>html</div></foreignObject><rect/></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("foreignObject");
    expect(result).toContain("<rect/>");
  });

  it("strips javascript: in href", () => {
    const input = '<svg><a href="javascript:alert(1)">click</a></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("javascript:");
  });

  it("strips <iframe> tags", () => {
    const input = '<svg><iframe src="evil.html"></iframe><rect/></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("<iframe");
  });

  it("strips <embed> tags", () => {
    const input = '<svg><embed src="evil.swf"></embed><rect/></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("<embed");
  });

  it("strips <object> tags", () => {
    const input = '<svg><object data="evil.swf"></object><rect/></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("<object");
  });

  it("strips dangerous data: URIs in href", () => {
    const input = '<svg><a href="data:text/html,<script>alert(1)</script>">x</a></svg>';
    const result = sanitizeSvg(input);
    expect(result).not.toContain("data:text/html");
  });

  it("preserves valid SVG content", () => {
    const input = '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="blue"/><circle cx="50" cy="50" r="20" fill="red"/></svg>';
    const result = sanitizeSvg(input);
    expect(result).toContain('<rect x="10"');
    expect(result).toContain('<circle cx="50"');
    expect(result).toContain('fill="blue"');
  });
});
