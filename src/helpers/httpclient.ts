import { logger } from "./logger";

interface RequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export class HttpClient {
  private baseURL: string;
  private defaultHeaders: Record<string, string>;

  constructor(baseURL = '', defaultHeaders: Record<string, string> = {}) {
    this.baseURL = baseURL;
    this.defaultHeaders = defaultHeaders;
  }

  // Helper method to make requests
  async request(method: string, endpoint: string, options: RequestOptions = {}) {
    const url = this.baseURL + endpoint;
    const { headers, body, query, ...rest } = options;

    // Add query parameters to the URL if present
    const queryString = query
      ? '?' +
        Object.entries(query)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
          .join('&')
      : '';
    
    try {
      const response = await fetch(url + queryString, {
        method,
        headers: { ...this.defaultHeaders, ...headers },
        body: body ? JSON.stringify(body) : undefined,
        ...rest,
      });

      // Check for HTTP errors
      if (!response.ok) {
        throw new Error(
          `HTTP Error: ${response.status} ${response.statusText}`
        );
      }

      // Parse response
      const contentType = response.headers.get('Content-Type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    } catch (error) {
      logger.error({ error, method, url }, `Error during ${method} request`);
      throw error;
    }
  }

  // Convenience methods for common HTTP verbs
  get(endpoint: string, options: RequestOptions = {}) {
    return this.request('GET', endpoint, options);
  }

  post(endpoint: string, options: RequestOptions = {}) {
    return this.request('POST', endpoint, options);
  }

  put(endpoint: string, options: RequestOptions = {}) {
    return this.request('PUT', endpoint, options);
  }

  delete(endpoint: string, options: RequestOptions = {}) {
    return this.request('DELETE', endpoint, options);
  }
}
