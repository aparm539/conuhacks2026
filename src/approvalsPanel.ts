/**
 * Approvals panel: list pending PR comments with checkboxes and editable body,
 * then Post to GitHub (selected subset) or Discard.
 */
import * as vscode from "vscode";

export interface PendingCommentDisplay {
  index: number;
  path: string;
  line: number;
  body: string;
}

export interface ApprovalsPanelCallbacks {
  getPendingEntries(): PendingCommentDisplay[];
  onPostToGitHub(
    selectedIndices: number[],
    bodiesByIndex: Record<number, string>,
  ): Promise<void>;
  onDiscard(): void;
  /** Sync edited body from the approvals UI into the in-editor comment thread. */
  onBodyChanged(index: number, body: string): void;
  /** Unselect/remove this comment: dispose its in-editor thread and remove from pending list. */
  onCommentUnselected(index: number): void;
}

export class ApprovalsPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pr-notes.approvalsPanel";

  private _view?: vscode.WebviewView;
  private _callbacks: ApprovalsPanelCallbacks;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    callbacks: ApprovalsPanelCallbacks,
  ) {
    this._callbacks = callbacks;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data: { type: string }) => {
      switch (data.type) {
        case "getInitialData": {
          const entries = this._callbacks.getPendingEntries();
          this._view?.webview.postMessage({
            type: "initialData",
            entries,
          });
          break;
        }
        case "postToGitHub": {
          const payload = data as unknown as {
            selectedIndices: number[];
            bodiesByIndex: Record<number, string>;
          };
          const selectedIndices = payload.selectedIndices ?? [];
          const bodiesByIndex = payload.bodiesByIndex ?? {};
          this._callbacks
            .onPostToGitHub(selectedIndices, bodiesByIndex)
            .then(() => this._sendRefresh())
            .catch((err) => {
              console.error("Failed to post to GitHub:", err);
            });
          break;
        }
        case "discard": {
          this._callbacks.onDiscard();
          this._sendRefresh();
          break;
        }
        case "bodyChanged": {
          const payload = data as unknown as { index: number; body: string };
          if (
            typeof payload.index === "number" &&
            typeof payload.body === "string"
          ) {
            this._callbacks.onBodyChanged(payload.index, payload.body);
          }
          break;
        }
        case "commentUnselected": {
          const payload = data as unknown as { index: number };
          if (typeof payload.index === "number") {
            this._callbacks.onCommentUnselected(payload.index);
            // Don't refresh: keep the comment in the list with checkbox unchecked
          }
          break;
        }
        default:
          break;
      }
    });
  }

  /**
   * Send current pending entries to the webview (e.g. after done or after partial post).
   */
  public refresh() {
    this._sendRefresh();
  }

  /**
   * Reveal the approvals view in the sidebar (e.g. after recording stops with pending comments).
   */
  public show(preserveFocus?: boolean) {
    this._view?.show(preserveFocus);
  }

  private _sendRefresh() {
    if (this._view) {
      const entries = this._callbacks.getPendingEntries();
      this._view.webview.postMessage({
        type: "initialData",
        entries,
      });
    }
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pending comments</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 12px;
            min-height: 100%;
            display: flex;
            flex-direction: column;
        }
        .header {
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header h3 {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
            opacity: 0.8;
        }
        .list {
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 12px;
        }
        .comment-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .comment-card .meta {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .comment-card .meta .path {
            font-family: var(--vscode-editor-font-family);
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .comment-card .meta .line {
            flex-shrink: 0;
        }
        .comment-card textarea {
            width: 100%;
            min-height: 60px;
            padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-input-foreground);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            resize: vertical;
        }
        .comment-card textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .comment-card .row {
            display: flex;
            align-items: flex-start;
            gap: 8px;
        }
        .comment-card input[type="checkbox"] {
            margin-top: 4px;
            flex-shrink: 0;
        }
        .comment-card .body-wrap {
            flex: 1;
            min-width: 0;
        }
        .actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover:not(:disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            gap: 8px;
        }
        .select-all {
            margin-bottom: 8px;
            font-size: 11px;
        }
        .select-all a {
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            margin-right: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h3>Pending comments</h3>
    </div>
    <div class="select-all" id="selectAll" style="display: none;">
        <a id="selectAllLink">Select all</a>
        <a id="deselectAllLink">Deselect all</a>
    </div>
    <div class="list" id="list"></div>
    <div class="empty-state" id="emptyState">
        <div>No pending comments</div>
        <div style="font-size: 11px;">Record and stop to generate comments, then approve here.</div>
    </div>
    <div class="actions" id="actions" style="display: none;">
        <button class="btn btn-primary" id="postBtn">Post to GitHub</button>
        <button class="btn btn-secondary" id="discardBtn">Discard</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let entries = [];
        const listEl = document.getElementById('list');
        const emptyState = document.getElementById('emptyState');
        const actionsEl = document.getElementById('actions');
        const selectAllEl = document.getElementById('selectAll');
        const postBtn = document.getElementById('postBtn');
        const discardBtn = document.getElementById('discardBtn');

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function renderEntry(entry, isChecked) {
            const card = document.createElement('div');
            card.className = 'comment-card';
            card.dataset.index = String(entry.index);
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = isChecked;
            cb.dataset.index = String(entry.index);
            cb.addEventListener('change', function() {
                if (!cb.checked) {
                    vscode.postMessage({ type: 'commentUnselected', index: entry.index });
                }
            });
            const textarea = document.createElement('textarea');
            textarea.value = entry.body;
            textarea.dataset.index = String(entry.index);
            textarea.rows = 3;
            card.innerHTML = '<div class="row"><div class="body-wrap"></div></div>';
            const row = card.querySelector('.row');
            row.insertBefore(cb, row.firstChild);
            const wrap = row.querySelector('.body-wrap');
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.innerHTML = '<span class="path" title="' + escapeHtml(entry.path) + '">' + escapeHtml(entry.path) + '</span><span class="line">L' + entry.line + '</span>';
            wrap.appendChild(meta);
            wrap.appendChild(textarea);
            function syncBody(idx, value) {
                vscode.postMessage({ type: 'bodyChanged', index: idx, body: value });
            }
            (function(idx) {
                let debounce = null;
                textarea.addEventListener('input', function() {
                    if (debounce) clearTimeout(debounce);
                    debounce = setTimeout(function() {
                        syncBody(idx, textarea.value);
                        debounce = null;
                    }, 300);
                });
                textarea.addEventListener('blur', function() {
                    if (debounce) { clearTimeout(debounce); debounce = null; }
                    syncBody(idx, textarea.value);
                });
            })(entry.index);
            return card;
        }

        function updateUI(entriesData) {
            entries = entriesData || [];
            listEl.innerHTML = '';
            if (entries.length === 0) {
                emptyState.style.display = 'flex';
                actionsEl.style.display = 'none';
                selectAllEl.style.display = 'none';
                return;
            }
            emptyState.style.display = 'none';
            actionsEl.style.display = 'flex';
            selectAllEl.style.display = 'block';
            entries.forEach(entry => {
                const card = renderEntry(entry, true);
                listEl.appendChild(card);
            });
        }

        function getBodiesByIndex() {
            const out = {};
            listEl.querySelectorAll('textarea[data-index]').forEach(ta => {
                const i = parseInt(ta.dataset.index, 10);
                out[i] = ta.value;
            });
            return out;
        }

        function getSelectedIndices() {
            const out = [];
            listEl.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                out.push(parseInt(cb.dataset.index, 10));
            });
            return out;
        }

        postBtn.addEventListener('click', () => {
            const selectedIndices = getSelectedIndices();
            if (selectedIndices.length === 0) {
                return;
            }
            const bodiesByIndex = getBodiesByIndex();
            vscode.postMessage({ type: 'postToGitHub', selectedIndices, bodiesByIndex });
        });

        discardBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'discard' });
        });

        document.getElementById('selectAllLink').addEventListener('click', () => {
            listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
        });
        document.getElementById('deselectAllLink').addEventListener('click', () => {
            listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'initialData') {
                updateUI(msg.entries);
            }
        });

        vscode.postMessage({ type: 'getInitialData' });
    </script>
</body>
</html>`;
  }
}
