import * as vscode from 'vscode';

export interface TranscriptEntry {
    speakerId: number;
    text: string;
    startTime: number;
    endTime: number;
    isVolatile?: boolean; // true = interim, may change
}

export class TranscriptPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'pr-notes.transcriptPanel';
    
    private _view?: vscode.WebviewView;
    private _entries: TranscriptEntry[] = [];
    private _volatileText: string = '';
    private _isRecording: boolean = false;
    private _currentSpeaker: number = 0;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'clear':
                    this.clear();
                    break;
            }
        });
    }

    /**
     * Update recording state
     */
    public setRecording(isRecording: boolean) {
        this._isRecording = isRecording;
        if (!isRecording) {
            this._volatileText = '';
        }
        this._updateView();
    }

    /**
     * Update volatile (interim) transcription text
     */
    public updateVolatile(text: string) {
        this._volatileText = text;
        this._updateView();
    }

    /**
     * Update current speaker from diarization
     */
    public updateCurrentSpeaker(speakerId: number) {
        this._currentSpeaker = speakerId;
    }

    /**
     * Add a final segment
     */
    public addSegment(entry: TranscriptEntry) {
        this._entries.push(entry);
        this._volatileText = ''; // Clear volatile when we get a final segment
        this._updateView();
    }

    /**
     * Clear all entries
     */
    public clear() {
        this._entries = [];
        this._volatileText = '';
        this._currentSpeaker = 0;
        this._updateView();
    }

    private _updateView() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'update',
                entries: this._entries,
                volatileText: this._volatileText,
                volatileSpeaker: this._currentSpeaker,
                isRecording: this._isRecording
            });
        }
    }

    private _getHtmlForWebview(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live Transcript</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 12px;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
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
        
        .status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
        }
        
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--vscode-testing-iconUnset);
        }
        
        .status-dot.recording {
            background-color: var(--vscode-testing-iconFailed);
            animation: pulse 1.5s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .transcript-container {
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .segment {
            padding: 8px 10px;
            border-radius: 6px;
            background-color: var(--vscode-editor-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        
        .segment.volatile {
            opacity: 0.7;
            border-left-color: var(--vscode-editorWarning-foreground);
            font-style: italic;
        }
        
        .segment-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }
        
        .speaker-tag {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            padding: 2px 6px;
            border-radius: 3px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        
        .speaker-0 { background-color: #3b82f6; }
        .speaker-1 { background-color: #10b981; }
        .speaker-2 { background-color: #f59e0b; }
        .speaker-3 { background-color: #ef4444; }
        .speaker-4 { background-color: #8b5cf6; }
        
        .timestamp {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        
        .segment-text {
            font-size: 13px;
            line-height: 1.5;
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
        
        .empty-state .icon {
            font-size: 32px;
            opacity: 0.5;
        }
        
        .clear-btn {
            margin-top: 12px;
            padding: 6px 12px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .clear-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h3>Live Transcript</h3>
        <div class="status">
            <span class="status-dot" id="statusDot"></span>
            <span id="statusText">Idle</span>
        </div>
    </div>
    
    <div class="transcript-container" id="transcriptContainer">
        <div class="empty-state" id="emptyState">
            <div class="icon">🎙️</div>
            <div>Start recording to see live transcript</div>
        </div>
    </div>
    
    <button class="clear-btn" id="clearBtn" style="display: none;">Clear Transcript</button>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        const transcriptContainer = document.getElementById('transcriptContainer');
        const emptyState = document.getElementById('emptyState');
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const clearBtn = document.getElementById('clearBtn');
        
        let currentEntries = [];
        
        function formatTime(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return mins + ':' + secs.toString().padStart(2, '0');
        }
        
        function getSpeakerColor(id) {
            const colors = ['speaker-0', 'speaker-1', 'speaker-2', 'speaker-3', 'speaker-4'];
            return colors[id % colors.length];
        }
        
        function renderSegment(entry, isVolatile = false) {
            const segment = document.createElement('div');
            segment.className = 'segment' + (isVolatile ? ' volatile' : '');
            
            const speakerLabel = isVolatile ? 'Speaking...' : 'Speaker ' + (entry.speakerId + 1);
            const timeLabel = isVolatile ? '' : formatTime(entry.startTime) + ' - ' + formatTime(entry.endTime);
            
            segment.innerHTML = \`
                <div class="segment-header">
                    <span class="speaker-tag \${getSpeakerColor(entry.speakerId)}">\${speakerLabel}</span>
                    \${timeLabel ? '<span class="timestamp">' + timeLabel + '</span>' : ''}
                </div>
                <div class="segment-text">\${escapeHtml(entry.text)}</div>
            \`;
            
            return segment;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function updateUI(data) {
            const { entries, volatileText, volatileSpeaker, isRecording } = data;
            currentEntries = entries;
            
            // Update status
            if (isRecording) {
                statusDot.classList.add('recording');
                statusText.textContent = 'Recording';
            } else {
                statusDot.classList.remove('recording');
                statusText.textContent = entries.length > 0 ? entries.length + ' segment(s)' : 'Idle';
            }
            
            // Clear and rebuild transcript
            transcriptContainer.innerHTML = '';
            
            if (entries.length === 0 && !volatileText) {
                transcriptContainer.appendChild(emptyState.cloneNode(true));
                clearBtn.style.display = 'none';
                return;
            }
            
            // Render final segments
            entries.forEach(entry => {
                transcriptContainer.appendChild(renderSegment(entry));
            });
            
            // Render volatile text if present
            if (volatileText && isRecording) {
                transcriptContainer.appendChild(renderSegment({
                    speakerId: volatileSpeaker,
                    text: volatileText,
                    startTime: 0,
                    endTime: 0
                }, true));
            }
            
            // Show clear button if we have entries
            clearBtn.style.display = entries.length > 0 ? 'block' : 'none';
            
            // Scroll to bottom
            transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                updateUI(message);
            }
        });
        
        // Clear button handler
        clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
        });
    </script>
</body>
</html>`;
    }
}
