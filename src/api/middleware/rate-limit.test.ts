// Licensed under the Hungry Ghost Hive License. See LICENSE.

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { afterEach, describe, expect, it } from 'vitest';
import { response } from '../shared/types.js';
import { resetRateLimitWindows, withRateLimit } from './rate-limit.js';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/api/runs',
    resource: '/api/runs',
    headers: { 'x-api-key': 'test-key' },
    pathParameters: null,
    queryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: { sourceIp: '127.0.0.1' } as never,
      path: '/api/runs',
      stage: 'prod',
      requestId: 'req-1',
      requestTimeEpoch: Date.now(),
      resourceId: 'res',
      resourcePath: '/api/runs',
    },
    ...overrides,
  } as APIGatewayProxyEvent;
}

const okHandler = async () => response(200, { ok: true });

describe('withRateLimit', () => {
  afterEach(() => {
    resetRateLimitWindows();
  });

  it('allows requests under the limit', async () => {
    const handler = withRateLimit(okHandler, { maxRequests: 5, windowSeconds: 60 });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['X-RateLimit-Limit']).toBe('5');
    expect(result.headers?.['X-RateLimit-Remaining']).toBe('4');
  });

  it('returns 429 when limit exceeded', async () => {
    const handler = withRateLimit(okHandler, { maxRequests: 2, windowSeconds: 60 });
    const event = makeEvent();

    await handler(event);
    await handler(event);
    const result = await handler(event);

    expect(result.statusCode).toBe(429);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('Too many requests');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(result.headers?.['Retry-After']).toBeDefined();
  });

  it('tracks different clients separately', async () => {
    const handler = withRateLimit(okHandler, { maxRequests: 1, windowSeconds: 60 });

    const event1 = makeEvent({ headers: { 'x-api-key': 'client-1' } });
    const event2 = makeEvent({ headers: { 'x-api-key': 'client-2' } });

    const r1 = await handler(event1);
    const r2 = await handler(event2);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });

  it('adds rate limit headers to successful responses', async () => {
    const handler = withRateLimit(okHandler, { maxRequests: 10, windowSeconds: 60 });
    const result = await handler(makeEvent());

    expect(result.headers?.['X-RateLimit-Limit']).toBe('10');
    expect(result.headers?.['X-RateLimit-Remaining']).toBe('9');
    expect(result.headers?.['X-RateLimit-Reset']).toBeDefined();
  });

  it('resets window after expiry', async () => {
    const handler = withRateLimit(okHandler, { maxRequests: 1, windowSeconds: 0 });
    const event = makeEvent();

    await handler(event);
    // Window of 0 seconds means immediate reset
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });
});
