import { describe, it, expect } from "vitest";

import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import {
  buildKiroPayload,
  normalizeKiroModelId,
  sanitizeJsonSchema,
} from "../../open-sse/translator/request/openai-to-kiro.js";

describe("openaiToKiroRequest", () => {
  it("normalizes Claude versioned model IDs to Kiro slugs", () => {
    expect(normalizeKiroModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5");
    expect(normalizeKiroModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5");
    expect(normalizeKiroModelId("claude-sonnet-4-20250514")).toBe("claude-sonnet-4");
  });

  it("removes JSON Schema fields that make Kiro reject tool requests", () => {
    const schema = sanitizeJsonSchema({
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        query: {
          type: "string",
          additionalProperties: false,
        },
      },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
      },
    });
  });

  it("builds a Kiro payload for Anthropic /v1/messages style model names", () => {
    const payload = buildKiroPayload(
      "claude-sonnet-4-5-20250929",
      {
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
      true,
      { providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test" } },
    );

    expect(payload).not.toHaveProperty("model");
    expect(payload.profileArn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/test");
    expect(payload.inferenceConfig.maxTokens).toBe(64);
    expect(payload.conversationState.history).toBeUndefined();
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.5");
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("hello");
  });

  it("translates Claude /v1/messages requests to Kiro payloads", () => {
    const payload = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.KIRO,
      "claude-sonnet-4-5-20250929",
      {
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
      true,
      { providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test" } },
      "kiro",
    );

    expect(payload).not.toHaveProperty("model");
    expect(payload.profileArn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/test");
    expect(payload.inferenceConfig.maxTokens).toBe(64);
    expect(payload.conversationState.history).toBeUndefined();
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.5");
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("hello");
  });

  it("strips router-only top-level model before posting to Kiro", () => {
    const executor = new KiroExecutor();
    const payload = executor.transformRequest("claude-sonnet-4.5", {
      model: "claude-sonnet-4.5",
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: "hello",
            modelId: "claude-sonnet-4.5",
          },
        },
      },
    });

    expect(payload).not.toHaveProperty("model");
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.5");
  });
});
