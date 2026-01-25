/**
 * GitHub authentication helper using VS Code's built-in authentication API.
 */
import * as vscode from 'vscode';

const GITHUB_PROVIDER_ID = 'github';
const SCOPES = ['read:user', 'repo'];

export interface AuthState {
	loggedIn: boolean;
	accountLabel?: string;
}

export type OnSessionChangeCallback = () => void;

let sessionChangeCallback: OnSessionChangeCallback | undefined;

/**
 * Subscribe to session changes (e.g. sign in/out from Accounts menu).
 * The callback is invoked when GitHub sessions change so the UI can refresh.
 */
export function onSessionChange(callback: OnSessionChangeCallback): vscode.Disposable {
	sessionChangeCallback = callback;
	return new vscode.Disposable(() => {
		sessionChangeCallback = undefined;
	});
}

function notifySessionChange(): void {
	sessionChangeCallback?.();
}

/**
 * Get the current GitHub session.
 * @param createIfNone - If true, prompts the user to sign in when no session exists.
 */
export async function getSession(
	createIfNone?: boolean
): Promise<vscode.AuthenticationSession | undefined> {
	const options = createIfNone ? { createIfNone: true } : undefined;
	return vscode.authentication.getSession(GITHUB_PROVIDER_ID, SCOPES, options);
}

/**
 * Get auth state for UI (logged in, account label).
 */
export async function getAuthState(): Promise<AuthState> {
	const session = await getSession(false);
	if (!session) {
		return { loggedIn: false };
	}
	return {
		loggedIn: true,
		accountLabel: session.account.label,
	};
}

/**
 * Register listener for VS Code's onDidChangeSessions and invoke our callback when GitHub sessions change.
 */
export function registerSessionChangeListener(): vscode.Disposable {
	return vscode.authentication.onDidChangeSessions((e) => {
		if (e.provider.id === GITHUB_PROVIDER_ID) {
			notifySessionChange();
		}
	});
}
