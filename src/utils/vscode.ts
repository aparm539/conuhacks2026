import * as vscode from 'vscode';

/**
 * Get the relative file path for a document
 */
export function getFileRelativePath(document: vscode.TextDocument): string {
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		return vscode.workspace.asRelativePath(document.uri, false);
	}
	return document.uri.fsPath;
}
