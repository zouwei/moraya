/**
 * Custom API Publisher
 * Publishes articles to custom API endpoints.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { CustomAPITarget, PublishResult } from './types';

/**
 * Replace {{variable}} placeholders in all string values of a parsed JSON object.
 */
function replaceVarsInObject(obj: unknown, vars: Record<string, string>): unknown {
  if (typeof obj === 'string') {
    let result = obj;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
  }
  if (Array.isArray(obj)) return obj.map(item => replaceVarsInObject(item, vars));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = replaceVarsInObject(value, vars);
    }
    return out;
  }
  return obj;
}

/**
 * Publish an article to a custom API endpoint.
 */
export async function publishToCustomAPI(
  target: CustomAPITarget,
  variables: Record<string, string>,
): Promise<PublishResult> {
  try {
    // Parse template as JSON, replace variables in object values, then re-serialize.
    // This lets JSON.stringify handle all escaping (newlines, quotes, etc.) correctly.
    const templateObj = JSON.parse(target.bodyTemplate);
    const bodyObj = replaceVarsInObject(templateObj, variables);
    const body = JSON.stringify(bodyObj);
    const res = await tauriFetch(target.endpoint, {
      method: target.method,
      headers: {
        ...target.headers,
      },
      body,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`API error (${res.status}): ${errBody}`);
    }

    return {
      success: true,
      targetId: target.id,
      targetName: target.name,
      message: `Published to ${target.name}`,
    };
  } catch (error) {
    return {
      success: false,
      targetId: target.id,
      targetName: target.name,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Test connection to a custom API endpoint.
 */
export async function testCustomAPIConnection(target: CustomAPITarget): Promise<boolean> {
  try {
    const { 'Content-Type': _, ...headHeaders } = target.headers;
    const res = await tauriFetch(target.endpoint, {
      method: 'HEAD',
      headers: headHeaders,
    });
    return res.ok || res.status === 405;
  } catch {
    return false;
  }
}
