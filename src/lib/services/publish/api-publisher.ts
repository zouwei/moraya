/**
 * Custom API Publisher
 * Publishes articles to custom API endpoints.
 */

import type { CustomAPITarget, PublishResult } from './types';
import { renderTemplate } from './types';

/**
 * Publish an article to a custom API endpoint.
 */
export async function publishToCustomAPI(
  target: CustomAPITarget,
  variables: Record<string, string>,
): Promise<PublishResult> {
  try {
    // Render body template with variables
    const body = renderTemplate(target.bodyTemplate, variables);

    const res = await fetch(target.endpoint, {
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
    const res = await fetch(target.endpoint, {
      method: 'HEAD',
      headers: {
        ...target.headers,
      },
    });
    // Accept any 2xx or 405 (Method Not Allowed for HEAD)
    return res.ok || res.status === 405;
  } catch {
    return false;
  }
}
