// Licensed under the Hungry Ghost Hive License. See LICENSE.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { LambdaHandler } from '../shared/types.js';

export interface RateLimitConfig {
  /** Max requests per window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

/** Default rate limits per endpoint pattern */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  'POST /api/runs': { maxRequests: 10, windowSeconds: 60 },
  'DELETE /api/runs/{id}': { maxRequests: 20, windowSeconds: 60 },
  'POST /api/runs/{id}/message': { maxRequests: 30, windowSeconds: 60 },
  'PUT /api/settings': { maxRequests: 10, windowSeconds: 60 },
  default: { maxRequests: 100, windowSeconds: 60 },
};

/**
 * In-memory sliding window rate limiter.
 * Each Lambda instance maintains its own window. For distributed rate limiting,
 * a DynamoDB-backed counter would be needed (not implemented in V1).
 */
const windows = new Map<string, { count: number; resetAt: number }>();

function getClientId(event: APIGatewayProxyEvent): string {
  return (
    event.headers?.['x-api-key'] ||
    event.headers?.['X-Api-Key'] ||
    event.requestContext?.identity?.sourceIp ||
    'anonymous'
  );
}

function getRouteKey(event: APIGatewayProxyEvent): string {
  const method = event.httpMethod;
  const path = event.resource || event.path || '';
  return `${method} ${path}`;
}

/**
 * Wraps a Lambda handler with rate limiting.
 * Optionally accepts a custom config; otherwise uses DEFAULT_RATE_LIMITS.
 */
export function withRateLimit(handler: LambdaHandler, config?: RateLimitConfig): LambdaHandler {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const routeKey = getRouteKey(event);
    const limit = config || DEFAULT_RATE_LIMITS[routeKey] || DEFAULT_RATE_LIMITS['default'];
    const clientId = getClientId(event);
    const windowKey = `${clientId}:${routeKey}`;
    const now = Date.now();

    let window = windows.get(windowKey);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + limit.windowSeconds * 1000 };
      windows.set(windowKey, window);
    }

    window.count++;

    if (window.count > limit.maxRequests) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000);
      return {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(limit.maxRequests),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(window.resetAt / 1000)),
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Too many requests', retryAfter }),
      };
    }

    const result = await handler(event);

    // Add rate limit headers to successful responses
    result.headers = {
      ...result.headers,
      'X-RateLimit-Limit': String(limit.maxRequests),
      'X-RateLimit-Remaining': String(Math.max(0, limit.maxRequests - window.count)),
      'X-RateLimit-Reset': String(Math.ceil(window.resetAt / 1000)),
    };

    return result;
  };
}

/** Reset all rate limit windows (for testing) */
export function resetRateLimitWindows(): void {
  windows.clear();
}
