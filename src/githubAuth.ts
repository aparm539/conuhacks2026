/**
 * GitHub authentication helper using VS Code's built-in authentication API.
 */
import * as vscode from "vscode";

const GITHUB_PROVIDER_ID = "github";
const SCOPES = ["read:user", "repo"];

// Shared GitHub API constant
export const GITHUB_API = "https://api.github.com";

export interface AuthState {
  loggedIn: boolean;
  accountLabel?: string;
}

export type OnSessionChangeCallback = () => void;

/**
 * Get the current GitHub session.
 * @param createIfNone - If true, prompts the user to sign in when no session exists.
 */
export async function getSession(
  createIfNone?: boolean,
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
 * Register listener for VS Code's onDidChangeSessions and invoke callback when GitHub sessions change.
 * Combines registration and callback setup in a single function.
 */
export function registerSessionChangeListener(
  callback: OnSessionChangeCallback,
): vscode.Disposable {
  return vscode.authentication.onDidChangeSessions((e) => {
    if (e.provider.id === GITHUB_PROVIDER_ID) {
      callback();
    }
  });
}
