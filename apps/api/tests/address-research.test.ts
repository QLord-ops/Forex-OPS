import { describe, expect, it, vi } from "vitest";
import { OpenAiAddressResearcher } from "../src/services/address-research.js";

describe("OpenAI address research", () => {
  it("requests bounded web search and parses at most evidence-based candidates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            candidates: [{
              address: "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde",
              rationale: "Официальная страница площадки.",
              sourceUrls: ["https://example.com/location"]
            }]
          })
        }]
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const researcher = new OpenAiAddressResearcher({ apiKey: "test-key", fetchImpl });
    const candidates = await researcher.research({ address: "Brose Lager", city: "Ludwigsfelde" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.address).toContain("Rudolf-Diesel-Straße");
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      store: boolean;
      tools: Array<{ type: string; search_context_size: string }>;
      max_output_tokens: number;
    };
    expect(request).toMatchObject({
      store: false,
      max_output_tokens: 1500,
      tools: [{ type: "web_search", search_context_size: "low" }]
    });
  });
});
