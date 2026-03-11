import { useCallback, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const get = useCallback(async <T>(path: string): Promise<T> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await request<T>('GET', path, undefined, controller.signal);
      return data;
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const post = useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    setLoading(true);
    setError(null);
    try {
      return await request<T>('POST', path, body);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const del = useCallback(async <T>(path: string): Promise<T> => {
    setLoading(true);
    setError(null);
    try {
      return await request<T>('DELETE', path);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { get, post, del, loading, error };
}
