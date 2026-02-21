/**
 * Tool Bridge - converts MCP tools to LLM provider formats
 * and parses tool call responses from different providers
 */

import type { MCPTool } from '$lib/services/mcp/types';
import type { AIProvider, ToolDefinition, ToolCallRequest } from './types';

/**
 * Convert MCP tools to generic ToolDefinition format.
 * MCP tools already use JSON Schema for inputSchema, so mapping is direct.
 */
export function mcpToolsToToolDefs(tools: MCPTool[]): ToolDefinition[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/**
 * Format tools into the provider-specific request body fields.
 * Returns partial body object to merge into the API request.
 */
export function formatToolsForProvider(
  provider: AIProvider,
  tools: ToolDefinition[]
): Record<string, unknown> {
  if (tools.length === 0) return {};

  switch (provider) {
    case 'claude':
      // Claude API: { tools: [{ name, description, input_schema }] }
      return {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
      };

    case 'openai':
    case 'deepseek':
    case 'custom':
    case 'ollama':
      // OpenAI-compatible: { tools: [{ type: "function", function: { name, description, parameters } }] }
      return {
        tools: tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
      };

    case 'gemini':
      // Gemini: { tools: [{ functionDeclarations: [...] }] }
      return {
        tools: [{
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          })),
        }],
      };

    default:
      return {};
  }
}

/**
 * Parse tool call responses from provider-specific formats.
 * Returns null if no tool calls found.
 */
export function parseClaudeToolCalls(data: Record<string, unknown>): {
  toolCalls: ToolCallRequest[];
  textContent: string;
  stopReason: string;
} {
  const content = data.content as Array<Record<string, unknown>> | undefined;
  const stopReason = (data.stop_reason as string) || 'end_turn';
  const toolCalls: ToolCallRequest[] = [];
  let textContent = '';

  if (content) {
    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id as string,
          name: block.name as string,
          arguments: (block.input as Record<string, unknown>) || {},
        });
      } else if (block.type === 'text') {
        textContent += block.text as string;
      }
    }
  }

  return { toolCalls: toolCalls.length > 0 ? toolCalls : [], textContent, stopReason };
}

export function parseOpenAIToolCalls(data: Record<string, unknown>): {
  toolCalls: ToolCallRequest[];
  textContent: string;
  stopReason: string;
} {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) return { toolCalls: [], textContent: '', stopReason: 'stop' };

  const choice = choices[0];
  const message = choice.message as Record<string, unknown> | undefined;
  const finishReason = (choice.finish_reason as string) || 'stop';
  const textContent = (message?.content as string) || '';
  const toolCalls: ToolCallRequest[] = [];

  const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawToolCalls) {
    for (const tc of rawToolCalls) {
      const fn = tc.function as Record<string, unknown>;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn.arguments as string);
      } catch {
        console.warn(`[AI] Failed to parse tool call arguments for ${fn.name}: ${(fn.arguments as string)?.slice(0, 200)}`);
      }
      toolCalls.push({
        id: tc.id as string,
        name: fn.name as string,
        arguments: args,
      });
    }
  }

  return {
    toolCalls,
    textContent,
    stopReason: finishReason === 'tool_calls' ? 'tool_use' : finishReason,
  };
}

export function parseGeminiToolCalls(data: Record<string, unknown>): {
  toolCalls: ToolCallRequest[];
  textContent: string;
  stopReason: string;
} {
  const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates || candidates.length === 0) return { toolCalls: [], textContent: '', stopReason: 'stop' };

  const content = candidates[0].content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  const toolCalls: ToolCallRequest[] = [];
  let textContent = '';

  if (parts) {
    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        toolCalls.push({
          id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: fc.name as string,
          arguments: (fc.args as Record<string, unknown>) || {},
        });
      } else if (part.text) {
        textContent += part.text as string;
      }
    }
  }

  return {
    toolCalls,
    textContent,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
  };
}

/**
 * Build Claude tool result messages for the API.
 * Claude expects: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
 */
export function buildClaudeToolResultMessages(
  toolResults: Array<{ callId: string; content: string; isError?: boolean }>
): Record<string, unknown> {
  return {
    role: 'user',
    content: toolResults.map(r => ({
      type: 'tool_result',
      tool_use_id: r.callId,
      content: r.content,
      is_error: r.isError || false,
    })),
  };
}

/**
 * Build OpenAI tool result messages.
 * OpenAI expects: [{ role: 'tool', tool_call_id, content }]
 */
export function buildOpenAIToolResultMessages(
  toolResults: Array<{ callId: string; name: string; content: string }>
): Array<Record<string, unknown>> {
  return toolResults.map(r => ({
    role: 'tool',
    tool_call_id: r.callId,
    content: r.content,
  }));
}
