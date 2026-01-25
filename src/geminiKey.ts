/**
 * Gemini API key storage using VS Code SecretStorage.
 * Must call initializeGeminiKeyStorage() from activate() before using.
 */
import * as vscode from 'vscode';

const SECRET_KEY = 'pr-notes.geminiApiKey';

let secrets: vscode.SecretStorage | undefined;

/**
 * Initialize storage. Call once from extension activate with context.secrets.
 */
export function initializeGeminiKeyStorage(context: vscode.ExtensionContext): void {
	secrets = context.secrets;
}

/**
 * Get the stored Gemini API key, or undefined if not set.
 */
export async function getGeminiApiKey(): Promise<string | undefined> {
	if (!secrets) {
		return undefined;
	}
	const key = await secrets.get(SECRET_KEY);
	return key && key.trim().length > 0 ? key.trim() : undefined;
}

/**
 * Store the Gemini API key.
 */
export async function setGeminiApiKey(key: string): Promise<void> {
	if (!secrets) {
		throw new Error('Gemini key storage not initialized');
	}
	const trimmed = key.trim();
	if (!trimmed) {
		throw new Error('API key cannot be empty');
	}
	await secrets.store(SECRET_KEY, trimmed);
}

/**
 * Clear the stored Gemini API key.
 */
export async function clearGeminiApiKey(): Promise<void> {
	if (!secrets) {
		return;
	}
	await secrets.delete(SECRET_KEY);
}
