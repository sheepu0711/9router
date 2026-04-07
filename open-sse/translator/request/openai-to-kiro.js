/**
 * OpenAI to Kiro Request Translator
 * Converts OpenAI Chat Completions format to Kiro/AWS CodeWhisperer format
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

function uuidv4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function normalizeKiroModelId(model) {
  if (!model || typeof model !== "string") return model;

  const name = model.toLowerCase();

  const standard = name.match(/^(claude-(?:haiku|sonnet|opus)-\d+)-(\d{1,2})(?:-(?:\d{8}|latest|\d+))?$/);
  if (standard) return `${standard[1]}.${standard[2]}`;

  const noMinor = name.match(/^(claude-(?:haiku|sonnet|opus)-\d+)(?:-\d{8})?$/);
  if (noMinor) return noMinor[1];

  const legacy = name.match(/^claude-(\d+)-(\d+)-(haiku|sonnet|opus)(?:-(?:\d{8}|latest|\d+))?$/);
  if (legacy) {
    const [, major, minor, family] = legacy;
    const normalized = `claude-${major}.${minor}-${family}`;
    if (normalized === "claude-3.7-sonnet") return "CLAUDE_3_7_SONNET_20250219_V1_0";
    return normalized;
  }

  const dotWithDate = name.match(/^(claude-(?:\d+\.\d+-)?(?:haiku|sonnet|opus)(?:-\d+(?:\.\d+)?)?)-\d{8}$/);
  if (dotWithDate) return dotWithDate[1];

  const inverted = name.match(/^claude-(\d+)\.(\d+)-(haiku|sonnet|opus)-.+$/);
  if (inverted) return `claude-${inverted[3]}-${inverted[1]}.${inverted[2]}`;

  return model;
}

function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};

  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value) && value.length === 0) continue;
    if (key === "additionalProperties") continue;
    // Skip $schema and $id as Kiro doesn't support them
    if (key === "$schema" || key === "$id") continue;

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([propName, propSchema]) => [
        propName,
        propSchema && typeof propSchema === "object" && !Array.isArray(propSchema)
          ? sanitizeJsonSchema(propSchema)
          : propSchema
      ]));
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item && typeof item === "object" && !Array.isArray(item)
          ? sanitizeJsonSchema(item)
          : item
      );
    } else if (value && typeof value === "object") {
      result[key] = sanitizeJsonSchema(value);
    } else {
      result[key] = value;
    }
  }

  // Ensure type field exists for object schemas
  if (result.properties && !result.type) {
    result.type = "object";
  }

  return result;
}

function safeParseToolArguments(args) {
  if (typeof args !== "string") return args || {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/**
 * Convert OpenAI messages to Kiro format
 * Rules: system/tool/user -> user role, merge consecutive same roles
 */
function convertMessages(messages, tools, model) {
  let history = [];
  let currentMessage = null;
  
  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages = [];
  let currentRole = null;

  // Image support is pre-filtered by caps in translateRequest before reaching here
  const supportsImages = true;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || "continue";
      const userMsg = {
        userInputMessage: {
          content: content,
          modelId: model,
          origin: "AI_EDITOR"
        }
      };

      // Attach images if present (Kiro API supports images field)
      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults
        };
      }
      
      // Add tools to first user message
      if (tools && tools.length > 0 && history.length === 0) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        userMsg.userInputMessage.userInputMessageContext.tools = tools.map(t => {
          const name = t.function?.name || t.name;
          let description = t.function?.description || t.description || "";

          if (!description.trim()) {
            description = `Tool: ${name}`;
          }

          const schema = t.function?.parameters || t.parameters || t.input_schema || {};
          const normalizedSchema = sanitizeJsonSchema(schema);

          // Validate tool has required fields
          if (!name) {
            console.error(`[KIRO] Tool missing name:`, JSON.stringify(t).slice(0, 200));
          }
          if (!normalizedSchema || typeof normalizedSchema !== 'object') {
            console.error(`[KIRO] Tool "${name}" has invalid schema:`, typeof normalizedSchema);
          }

          return {
            toolSpecification: {
              name,
              description,
              inputSchema: { json: normalizedSchema }
            }
          };
        });
      }
      
      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "...";
      const assistantMsg = {
        assistantResponseMessage: {
          content: content
        }
      };
      history.push(assistantMsg);
      pendingAssistantContent = [];
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let role = msg.role;
    
    // Normalize: system/tool -> user
    if (role === "system" || role === "tool") {
      role = "user";
    }
    
    // If role changes, flush pending
    if (role !== currentRole && currentRole !== null) {
      flushPending();
    }
    currentRole = role;
    
    if (role === "user") {
      // Extract content
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        for (const c of msg.content) {
          if (c.type === "text" || c.text) {
            textParts.push(c.text || "");
          } else if (supportsImages && c.type === "image_url") {
            // OpenAI format: image_url.url with data URI
            const url = c.image_url?.url || "";
            const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              const mediaType = base64Match[1];
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: base64Match[2] } });
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
              // Kiro only supports base64 — fallback to URL text
              textParts.push(`[Image: ${url}]`);
            }
          } else if (supportsImages && c.type === "image") {
            // Claude format: source.type = "base64", source.media_type, source.data
            if (c.source?.type === "base64" && c.source?.data) {
              const mediaType = c.source.media_type || "image/png";
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: c.source.data } });
            }
          }
        }
        content = textParts.join("\n");
        
        // Check for tool_result blocks
        const toolResultBlocks = msg.content.filter(c => c.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          toolResultBlocks.forEach(block => {
            const text = Array.isArray(block.content) 
              ? block.content.map(c => c.text || "").join("\n")
              : (typeof block.content === "string" ? block.content : "");
            
            pendingToolResults.push({
              toolUseId: block.tool_use_id,
              status: "success",
              content: [{ text: text }]
            });
          });
        }
      }
      
      // Handle tool role (from normalized)
      if (msg.role === "tool") {
        const toolContent = typeof msg.content === "string" ? msg.content : "";
        pendingToolResults.push({
          toolUseId: msg.tool_call_id,
          status: "success",
          content: [{ text: toolContent }]
        });
      } else if (content) {
        pendingUserContent.push(content);
      }
    } else if (role === "assistant") {
      // Extract text content and tool uses
      let textContent = "";
      let toolUses = [];
      
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(c => c.type === "text");
        textContent = textBlocks.map(b => b.text).join("\n").trim();
        
        const toolUseBlocks = msg.content.filter(c => c.type === "tool_use");
        toolUses = toolUseBlocks;
      } else if (typeof msg.content === "string") {
        textContent = msg.content.trim();
      }
      
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls;
      }
      
      if (textContent) {
        pendingAssistantContent.push(textContent);
      }
      
      // Store tool uses in last assistant message
      if (toolUses.length > 0) {
        if (pendingAssistantContent.length === 0) {
          // pendingAssistantContent.push("Call tools");
        }
        
        // Flush to create assistant message with toolUses
        flushPending();
        
        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses.map(tc => {
            if (tc.function) {
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.function.name,
                input: safeParseToolArguments(tc.function.arguments)
              };
            } else {
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.name,
                input: tc.input || {}
              };
            }
          });
        }
        
        currentRole = null;
      }
    }
  }
  
  // Flush remaining
  if (currentRole !== null) {
    flushPending();
  }
  
  // Pop last userInputMessage as currentMessage (search from end, skip trailing assistant messages)
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].userInputMessage) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  // Grab tools from first history item BEFORE cleanup removes them
  const firstHistoryTools = history[0]?.userInputMessage?.userInputMessageContext?.tools;

  // Clean up history for Kiro API compatibility
  history.forEach(item => {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }
    if (item.userInputMessage?.userInputMessageContext &&
        Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
      delete item.userInputMessage.userInputMessageContext;
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }
  });

  // Inject tools into currentMessage AFTER cleanup
  if (firstHistoryTools && currentMessage?.userInputMessage &&
      !currentMessage.userInputMessage.userInputMessageContext?.tools) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = firstHistoryTools;
  }

  return { history, currentMessage };
}

/**
 * Build Kiro payload from OpenAI format
 */
export function buildKiroPayload(model, body, stream, credentials) {
  const messages = body.messages || [];
  let tools = body.tools || [];
  const modelId = normalizeKiroModelId(model);
  const maxTokens = body.max_tokens;
  const temperature = body.temperature;
  const topP = body.top_p;

  // Kiro has a hard limit of ~20-40 tools - enforce a limit of 20 to be safe
  const KIRO_MAX_TOOLS = 20;
  if (tools.length > KIRO_MAX_TOOLS) {
    console.warn(`[KIRO] Limiting ${tools.length} tools to ${KIRO_MAX_TOOLS} (Kiro's maximum)`);
    // Keep the first N tools - in practice, the most important tools are usually listed first
    tools = tools.slice(0, KIRO_MAX_TOOLS);
  }

  const { history, currentMessage } = convertMessages(messages, tools, modelId);

  const profileArn = credentials?.providerSpecificData?.profileArn || "";

  let finalContent = currentMessage?.userInputMessage?.content || "";
  const timestamp = new Date().toISOString();
  finalContent = `[Context: Current time is ${timestamp}]\n\n${finalContent}`;
  
  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidv4(),
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.images && {
            images: currentMessage.userInputMessage.images
          }),
          ...(currentMessage?.userInputMessage?.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext
          })
        }
      },
    }
  };

  if (history.length > 0) {
    payload.conversationState.history = history;
  }

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature;
    if (topP !== undefined) payload.inferenceConfig.topP = topP;
  }

  // Debug: log payload size and tool count
  const payloadStr = JSON.stringify(payload);
  const payloadSizeKB = (payloadStr.length / 1024).toFixed(2);
  const toolCount = currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0;
  console.log(`[KIRO] Payload size: ${payloadSizeKB}KB, tools: ${toolCount}`);

  // Kiro has a limit of ~20 tools - if we have more, we need to handle it
  if (toolCount > 20) {
    console.warn(`[KIRO] Warning: ${toolCount} tools exceeds Kiro's limit of ~20. Request will likely fail.`);
  }

  return payload;
}

register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload, null);

export { normalizeKiroModelId, sanitizeJsonSchema };
