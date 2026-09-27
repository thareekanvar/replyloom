import { describe, it, expect } from "vitest";
import { chunkText } from "../rag";

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n  \t")).toEqual([]);
  });

  it("packs short paragraphs into a single chunk", () => {
    const chunks = chunkText("This is a short intro.\n\nAnd a follow up.\n\nExample.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("This is a short intro.");
    expect(chunks[0]).toContain("Example.");
  });

  it("normalizes CRLF to LF before chunking", () => {
    const chunks = chunkText("Hello\r\nworld\r\n\r\nNext section");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Hello\nworld");
    expect(chunks[0]).not.toContain("\r");
  });

  it("flushes a chunk once the size boundary is crossed", () => {
    const chunks = chunkText(`${"x".repeat(60)}\n\n${"y".repeat(60)}\n\n${"z".repeat(20)}`, 100);
    expect(chunks).toEqual(["x".repeat(60), `${"y".repeat(60)}\n${"z".repeat(20)}`]);
  });

  it("hard-slices an oversize paragraph", () => {
    const chunks = chunkText("a".repeat(2000), 500);
    expect(chunks).toHaveLength(4);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
  });
});