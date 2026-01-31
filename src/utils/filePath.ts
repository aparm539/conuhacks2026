import * as vscode from "vscode";

/**
 * Extract the repository-relative file path from a VS Code URI.
 * Handles special URI schemes like `git:` used in diff views by extracting
 * the actual file path from the query parameter.
 *
 * @param uri - The VS Code URI (may be file:, git:, or other schemes)
 * @returns Repository-relative path (e.g., "src/file.ts") or null if extraction fails
 */
export function getRepositoryRelativePath(uri: vscode.Uri): string | null {
  // Handle git: URI scheme used in diff views
  if (uri.scheme === "git") {
    try {
      // Parse the query parameter which contains JSON with the actual file path
      const query = uri.query;
      if (!query) {
        console.warn("git: URI has no query parameter");
        return null;
      }

      const queryData = JSON.parse(query) as { path?: string; ref?: string };
      if (!queryData.path) {
        console.warn("git: URI query does not contain path field");
        return null;
      }

      // Convert the extracted path to a URI and get repository-relative path
      const actualPathUri = vscode.Uri.file(queryData.path);

      if (
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
      ) {
        return vscode.workspace.asRelativePath(actualPathUri, false);
      } else {
        // No workspace folder, return the file system path
        return actualPathUri.fsPath;
      }
    } catch (error) {
      console.warn("Failed to parse git: URI query:", error);
      return null;
    }
  }

  // Handle normal file: URIs and other schemes
  if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    try {
      return vscode.workspace.asRelativePath(uri, false);
    } catch (error) {
      console.warn("Failed to get relative path:", error);
      // Fallback to fsPath if asRelativePath fails
      return uri.fsPath;
    }
  } else {
    // No workspace folder, return the file system path
    return uri.fsPath;
  }
}
