import { describe, expect, it, vi } from "vitest";
import { importPdfPreview } from "../src/services/pdf-order-import.js";

describe("PDF Auftrag import", () => {
  it("sends the PDF as an OpenAI file input and validates the structured preview", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            drafts: [
              {
                orderNumber: "PDF-4711",
                vehicleNumber: "LKW 936",
                stops: [
                  {
                    sequence: 1,
                    type: "LOAD",
                    company: "Werk Berlin",
                    address: "Alexanderplatz 1, 10178 Berlin, Deutschland",
                    appointmentLocal: "2026-10-12T08:30",
                    sourcePage: 1,
                    confidence: 0.96
                  },
                  {
                    sequence: 2,
                    type: "UNLOAD",
                    company: "Hafen Hamburg",
                    address: "Am Sandtorkai 1, 20457 Hamburg, Deutschland",
                    appointmentLocal: null,
                    sourcePage: 2,
                    confidence: 0.91
                  }
                ],
                warnings: []
              }
            ],
            warnings: []
          })
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await importPdfPreview(Buffer.from("%PDF-1.7\nauftrag"), "auftrag.pdf", {
      apiKey: "test-key",
      model: "gpt-test",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toMatchObject({
      source: "OPENAI",
      detectedLayout: "PDF",
      aiAvailable: true,
      usedAi: true,
      drafts: [
        {
          orderNumber: "PDF-4711",
          vehicleNumber: "LKW 936",
          stops: [
            { type: "LOAD", sourcePage: 1 },
            { type: "UNLOAD", sourcePage: 2, appointmentLocal: null }
          ]
        }
      ]
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      model: string;
      store: boolean;
      input: Array<{ role: string; content: unknown }>;
      text: { format: { type: string; strict: boolean } };
    };
    const userMessage = body.input.find((item) => item.role === "user");
    expect(body).toMatchObject({
      model: "gpt-test",
      store: false,
      text: { format: { type: "json_schema", strict: true } }
    });
    expect(userMessage?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "input_file",
        filename: "auftrag.pdf",
        file_data: expect.stringMatching(/^data:application\/pdf;base64,/),
        detail: "high"
      }),
      expect.objectContaining({ type: "input_text" })
    ]));
  });

  it("rejects malformed structured output", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ output_text: JSON.stringify({ drafts: [{ stops: [] }], warnings: [] }) }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as unknown as typeof fetch;

    await expect(importPdfPreview(Buffer.from("%PDF-1.7\nauftrag"), "auftrag.pdf", {
      apiKey: "test-key",
      fetchImpl
    })).rejects.toThrow();
  });
});
