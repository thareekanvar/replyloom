import { describe, expect, it } from "vitest";
import { normalizeModelId } from "../config";

describe("normalizeModelId", () => {
  it("maps deprecated Llama 3.1 model ids to the active support-agent model", () => {
    expect(normalizeModelId("@cf/meta/infire-llama-3.1-8b-instruct")).toBe(
      "@cf/google/gemma-4-26b-a4b-it"
    );
    expect(normalizeModelId("@cf/meta/llama-3.1-8b-instruct")).toBe(
      "@cf/google/gemma-4-26b-a4b-it"
    );
  });

  it("leaves active and unrelated model ids unchanged", () => {
    expect(normalizeModelId("@cf/meta/llama-3.2-3b-instruct")).toBe(
      "@cf/meta/llama-3.2-3b-instruct"
    );
  });
});
