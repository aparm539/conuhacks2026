import * as vscode from "vscode";
import { getRepositoryRelativePath } from "./utils/filePath";

export interface RecordingContext {
  timestamp: number;
  file: string;
  cursorLine: number;
  visibleRange: [number, number];
  symbolsInView: string[];
}

export class ContextCollector {
  private recordingStartTime: number | null = null;
  private contextSnapshots: RecordingContext[] = [];
  private eventDisposables: vscode.Disposable[] = [];
  private collectContextPromise: Promise<void> = Promise.resolve();

  startRecording(): void {
    if (this.recordingStartTime !== null) {
      return;
    }

    this.recordingStartTime = Date.now();
    this.contextSnapshots = [];

    // save initial context
    this.collectContextPromise = this.collectContext();

    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(
      () => {
        this.collectContextPromise = this.collectContextPromise.then(() =>
          this.collectContext(),
        );
      },
    );

    const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(
      (e) => {
        // Only collect active editor
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.collectContextPromise = this.collectContextPromise.then(() =>
            this.collectContext(),
          );
        }
      },
    );

    const visibleRangesDisposable =
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        // Only collect if it's the active editor
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.collectContextPromise = this.collectContextPromise.then(() =>
            this.collectContext(),
          );
        }
      });

    this.eventDisposables = [
      activeEditorDisposable,
      selectionDisposable,
      visibleRangesDisposable,
    ];
  }

  stopRecording(): RecordingContext[] {
    this.eventDisposables.forEach((disposable) => disposable.dispose());
    this.eventDisposables = [];
    this.recordingStartTime = null;
    return [...this.contextSnapshots];
  }

  /**
   * Get current context snapshots without stopping recording
   * Used for real-time segment processing during recording
   */
  getCurrentContext(): RecordingContext[] {
    return [...this.contextSnapshots];
  }

  clear(): void {
    this.recordingStartTime = null;
    this.contextSnapshots = [];
    this.eventDisposables.forEach((disposable) => disposable.dispose());
    this.eventDisposables = [];
    this.collectContextPromise = Promise.resolve();
  }

  private async collectContext(): Promise<void> {
    if (this.recordingStartTime === null) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    const timestamp = (Date.now() - this.recordingStartTime) / 1000; // Convert to seconds

    // No active editor
    if (!editor) {
      this.contextSnapshots.push({
        timestamp,
        file: "",
        cursorLine: 0,
        visibleRange: [0, 0],
        symbolsInView: [],
      });
      return;
    }

    const document = editor.document;

    // Get file path (handles git: URIs from diff view)
    const filePath = getRepositoryRelativePath(document.uri) ?? "";

    const cursorLine = editor.selection.active.line;

    // Get first visible range
    let visibleRange: [number, number] = [0, 0];
    if (editor.visibleRanges.length > 0) {
      const range = editor.visibleRanges[0];
      visibleRange = [range.start.line, range.end.line];
    }

    // Get symbols in view
    let symbolsInView: string[] = [];
    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);

      if (symbols && Array.isArray(symbols)) {
        symbolsInView = this.filterSymbolsInRange(
          symbols,
          visibleRange[0],
          visibleRange[1],
        );
      }
    } catch (error) {
      console.warn("Failed to get document symbols:", error);
    }

    this.contextSnapshots.push({
      timestamp,
      file: filePath,
      cursorLine,
      visibleRange,
      symbolsInView,
    });
  }

  private filterSymbolsInRange(
    symbols: vscode.DocumentSymbol[],
    startLine: number,
    endLine: number,
  ): string[] {
    const result: string[] = [];

    for (const symbol of symbols) {
      const symbolStart = symbol.range.start.line;
      const symbolEnd = symbol.range.end.line;
      // Check if ranges overlap
      if (symbolStart <= endLine && symbolEnd >= startLine) {
        result.push(symbol.name);
      }

      // Recursively check children
      if (symbol.children && symbol.children.length > 0) {
        result.push(
          ...this.filterSymbolsInRange(symbol.children, startLine, endLine),
        );
      }
    }

    return result;
  }
}
