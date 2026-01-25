/**
 * Generic HTTP client for API calls with timeout and error handling
 */
export class HttpClient {
	constructor(
		private baseUrl: string,
		private defaultTimeout?: number
	) {}

	/**
	 * Make a POST request
	 */
	async post<TRequest, TResponse>(
		path: string,
		body: TRequest,
		options?: {
			timeout?: number;
			headers?: Record<string, string>;
			errorContext?: string;
		}
	): Promise<TResponse> {
		const timeout = options?.timeout || this.defaultTimeout;
		const url = `${this.baseUrl}${path}`;
		
		try {
			const controller = timeout ? new AbortController() : undefined;
			const timeoutId = timeout ? setTimeout(() => controller!.abort(), timeout) : undefined;

			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...options?.headers,
					},
					body: JSON.stringify(body),
					signal: controller?.signal,
				});

				if (timeoutId) {
					clearTimeout(timeoutId);
				}

				if (!response.ok) {
					const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
					const errorContext = options?.errorContext || 'Request';
					throw new Error(errorData.error || `${errorContext} failed: HTTP ${response.status}`);
				}

				return response.json() as Promise<TResponse>;
			} catch (error) {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				if (error instanceof Error && error.name === 'AbortError') {
					throw new Error(`Request timeout: ${options?.errorContext || 'Request'} took too long`);
				}
				throw error;
			}
		} catch (error) {
			if (error instanceof TypeError && error.message.includes('fetch')) {
				throw new Error(`Failed to connect to ${this.baseUrl}. Make sure the service is running.`);
			}
			if (error instanceof Error) {
				throw new Error(`${options?.errorContext || 'Request'} failed: ${error.message}`);
			}
			throw error;
		}
	}

	/**
	 * Make a POST request with FormData (for file uploads)
	 */
	async postFormData<TResponse>(
		path: string,
		formData: FormData,
		options?: {
			timeout?: number;
			errorContext?: string;
		}
	): Promise<TResponse> {
		const timeout = options?.timeout || this.defaultTimeout;
		const url = `${this.baseUrl}${path}`;
		
		try {
			const controller = timeout ? new AbortController() : undefined;
			const timeoutId = timeout ? setTimeout(() => controller!.abort(), timeout) : undefined;

			try {
				const response = await fetch(url, {
					method: 'POST',
					body: formData,
					signal: controller?.signal,
				});

				if (timeoutId) {
					clearTimeout(timeoutId);
				}

				if (!response.ok) {
					const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string; message?: string };
					const errorContext = options?.errorContext || 'Request';
					throw new Error(errorData.error || errorData.message || `${errorContext} failed: HTTP ${response.status}`);
				}

				const result = await response.json() as TResponse;
				return result;
			} catch (error) {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				if (error instanceof Error && error.name === 'AbortError') {
					throw new Error(`Request timeout: ${options?.errorContext || 'Request'} took too long`);
				}
				throw error;
			}
		} catch (error) {
			if (error instanceof TypeError && error.message.includes('fetch')) {
				throw new Error(`Failed to connect to ${this.baseUrl}. Make sure the service is running.`);
			}
			if (error instanceof Error) {
				throw new Error(`${options?.errorContext || 'Request'} failed: ${error.message}`);
			}
			throw error;
		}
	}

	/**
	 * Get the base URL
	 */
	getBaseUrl(): string {
		return this.baseUrl;
	}
}
