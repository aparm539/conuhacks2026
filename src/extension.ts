// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import * as path from "path";
import * as readline from "readline";

import { spawn, ChildProcess } from "child_process";
import {
  createStatusBarItem,
  updateStatusBar,
  showStatusBarMenu,
  StatusBarCallbacks,
} from "./statusBar";
import {
  getSession,
  getAuthState,
  registerSessionChangeListener,
} from "./githubAuth";
import {
  getSelectedDevice,
  selectAudioDevice,
  listAudioDevices,
} from "./audioDeviceManager";
import { ContextCollector } from "./contextCollector";
import { findCommentLocationsBatch } from "./speechAlignment";
import type { SpeakerSegment, TransformedSegment, SemanticChunkingTail } from "./types";
import { getPrContext } from "./githubPrContext";
import {
  postReviewComments,
  type ReviewCommentInput,
} from "./githubPrComments";
import { getRepositoryRelativePath } from "./utils/filePath";
import {
  processSegmentsCombined,
  initializeGeminiService,
  resetGeminiClient,
} from "./services/gemini";
import { chunkTranscript } from "./semanticChunking";
import { TranscriptPanelProvider } from "./transcriptPanel";
import {
  ApprovalsPanelProvider,
  type PendingCommentDisplay,
} from "./approvalsPanel";

let transcriptPanel: TranscriptPanelProvider;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log("PR Notes extension is now active!");

  // Initialize Gemini service with secret storage access
  const GEMINI_API_KEY_SECRET = "pr-notes.geminiApiKey";
  initializeGeminiService(async () => {
    return await context.secrets.get(GEMINI_API_KEY_SECRET);
  });

  // Recording functionality setup
  let isRecording = false;
  const contextCollector = new ContextCollector();

  const commentController = vscode.comments.createCommentController(
    "pr-notes-comments",
    "PR Notes",
  );

  // Create transcript panel for sidebar
  transcriptPanel = new TranscriptPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TranscriptPanelProvider.viewType,
      transcriptPanel,
    ),
  );

  // Approvals panel will be created after postPendingGitHubComments and discard are defined
  let approvalsPanel: ApprovalsPanelProvider;

  // Create status bar item
  const statusBarItem = createStatusBarItem();
  statusBarItem.command = "pr-notes.showMenu";

  async function getDeviceDisplayName(): Promise<string | undefined> {
    const deviceId = getSelectedDevice();
    if (!deviceId || deviceId === "default") {
      return undefined;
    }
    const devices = await listAudioDevices();
    return devices.find((d) => d.id === deviceId)?.name;
  }

  async function refreshStatusBar() {
    const deviceDisplayName = await getDeviceDisplayName();
    const authState = await getAuthState();
    updateStatusBar(
      statusBarItem,
      isRecording,
      deviceDisplayName,
      authState.accountLabel,
    );
  }

  // Initial status bar update
  refreshStatusBar().catch((err) =>
    console.error("Error refreshing status bar:", err),
  );

  // Auth: refresh status bar when GitHub sessions change (e.g. sign in/out from Accounts menu)
  context.subscriptions.push(
    registerSessionChangeListener(() => {
      refreshStatusBar().catch((err) =>
        console.error("Error refreshing status bar:", err),
      );
    }),
  );

  // Fluid helper process for transcription/diarization
  let fluidHelper: ChildProcess | null = null;
  let fluidHelperReady = false;

  // Real-time processing state
  let processedSegmentCount = 0;
  interface PendingCommentEntry {
    input: ReviewCommentInput;
    thread: vscode.CommentThread;
  }
  let pendingCommentEntries: PendingCommentEntry[] = [];

  // Batch processing: collect segments and process with Gemini + comment location in one go (500ms debounce)
  const SEGMENT_BATCH_DEBOUNCE_MS = 500;
  let pendingSegmentsQueue: SpeakerSegment[] = [];
  let segmentBatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Cross-batch semantic chunking: last chunk's units + embeddings, cleared on recording start
  let semanticChunkingTail: SemanticChunkingTail | null = null;

  // Model download timeout: 15 minutes for first-run downloads (~650MB)
  const MODEL_DOWNLOAD_TIMEOUT_MS = 900000;

  /**
   * Start the fluid-helper process for transcription and diarization
   * @param showSuccessMessage - Whether to show a success message when models are ready
   */
  async function startFluidHelper(
    showSuccessMessage: boolean = false,
  ): Promise<void> {
    if (fluidHelper && fluidHelperReady) {
      if (showSuccessMessage) {
        vscode.window.showInformationMessage(
          "Speech models are already downloaded and ready!",
        );
      }
      return;
    }

    // Show progress while loading models (can take a while on first run)
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Loading Speech Models",
        cancellable: false,
      },
      async (progress) => {
        modelDownloadProgress = progress;

        return new Promise<void>((resolve, reject) => {
          const helperPath = path.join(
            context.extensionPath,
            "bin",
            "fluid-helper",
          );
          console.log(`[FluidHelper] Starting helper at: ${helperPath}`);

          progress.report({ message: "Starting speech recognition engine..." });

          fluidHelper = spawn(helperPath, [], {
            stdio: ["pipe", "pipe", "pipe"],
          });

          // Parse JSON lines from stdout
          const rl = readline.createInterface({ input: fluidHelper.stdout! });
          rl.on("line", (line) => {
            try {
              const msg = JSON.parse(line);
              handleFluidHelperMessage(msg, showSuccessMessage);
              if (msg.type === "ready") {
                fluidHelperReady = true;
                modelDownloadProgress = null;
                resolve();
              }
            } catch (e) {
              console.error("[FluidHelper] Invalid JSON:", line);
            }
          });

          fluidHelper.stderr?.on("data", (data) => {
            console.error(`[FluidHelper] stderr: ${data.toString().trim()}`);
          });

          fluidHelper.on("close", (code) => {
            console.log(`[FluidHelper] Process exited with code ${code}`);
            fluidHelper = null;
            fluidHelperReady = false;
            modelDownloadProgress = null;
          });

          fluidHelper.on("error", (err) => {
            console.error("[FluidHelper] Process error:", err);
            fluidHelper = null;
            fluidHelperReady = false;
            modelDownloadProgress = null;
            reject(err);
          });

          // Send init command
          fluidHelper.stdin!.write(JSON.stringify({ type: "init" }) + "\n");

          // Set timeout for initialization (model download can take a while)
          setTimeout(() => {
            if (!fluidHelperReady) {
              modelDownloadProgress = null;
              reject(
                new Error(
                  "Speech model initialization timed out. First run downloads ~650MB of models - please try again with a stable internet connection.",
                ),
              );
            }
          }, MODEL_DOWNLOAD_TIMEOUT_MS);
        });
      },
    );
  }

  // Track model download progress notification
  let modelDownloadProgress: vscode.Progress<{
    message?: string;
    increment?: number;
  }> | null = null;

  /**
   * Handle messages from fluid-helper
   * @param showSuccessMessage - Whether to show a success message when models are ready
   */
  async function handleFluidHelperMessage(
    msg: { type: string; [key: string]: unknown },
    showSuccessMessage: boolean = false,
  ) {
    switch (msg.type) {
      case "ready":
        console.log("[FluidHelper] Models loaded and ready");
        if (showSuccessMessage) {
          vscode.window.showInformationMessage(
            "Speech models downloaded and ready! You can now start recording.",
          );
        }
        break;
      case "progress":
        // Model download progress or post-stop processing (Detecting speakers... / Transcribing...)
        console.log(
          `[FluidHelper] Progress: ${msg.stage} - ${msg.message} (${msg.percent ?? "..."}%)`,
        );
        if (modelDownloadProgress) {
          // Format stage name for display
          const stageName =
            msg.stage === "asr"
              ? "Speech Recognition"
              : msg.stage === "diarization"
                ? "Speaker Detection"
                : String(msg.stage);
          const percent = msg.percent ? ` (${msg.percent}%)` : "";
          modelDownloadProgress.report({
            message: `${stageName}: ${msg.message}${percent}`,
            increment: msg.percent ? 5 : 0,
          });
        }
        // Show "Processing..." in transcript panel when processing after stop (not during initial model download)
        if (
          !isRecording &&
          (msg.message === "Detecting speakers..." || msg.message === "Transcribing...")
        ) {
          transcriptPanel.setProcessing(true);
        }
        break;
      case "recordingStatus":
        if (msg.status === "started") {
          console.log("[FluidHelper] Recording started");
          processedSegmentCount = 0;
          for (const entry of pendingCommentEntries) {
            entry.thread.dispose();
          }
          pendingCommentEntries = [];
          pendingSegmentsQueue = [];
          semanticChunkingTail = null;
          if (segmentBatchDebounceTimer !== null) {
            clearTimeout(segmentBatchDebounceTimer);
            segmentBatchDebounceTimer = null;
          }
          transcriptPanel.clear();
          transcriptPanel.setProcessing(false);
          transcriptPanel.setRecording(true);
        } else if (msg.status === "stopped") {
          console.log("[FluidHelper] Recording stopped");
          transcriptPanel.setRecording(false);
        } else if (msg.status === "error") {
          vscode.window.showErrorMessage(`Recording error: ${msg.error}`);
          isRecording = false;
          transcriptPanel.setRecording(false);
          refreshStatusBar().catch((err) =>
            console.error("Error refreshing status bar:", err),
          );
        }
        break;
      case "confirmed":
        console.log(
          `[FluidHelper] Confirmed: ${msg.text} (confidence: ${msg.confidence})`,
        );
        break;
      case "segment":
        // Batched segment processing: add to queue and process after debounce
        if (msg.isFinal) {
          console.log(
            `[FluidHelper] Final segment: Speaker ${msg.speakerId}: "${msg.text}"`,
          );
          const segment: SpeakerSegment = {
            speakerTag: msg.speakerId as number,
            text: msg.text as string,
            startTime: msg.start as number,
            endTime: msg.end as number,
          };
          transcriptPanel.addSegment({
            speakerId: segment.speakerTag,
            text: segment.text,
            startTime: segment.startTime,
            endTime: segment.endTime,
          });
          pendingSegmentsQueue.push(segment);
          processedSegmentCount++;

          if (segmentBatchDebounceTimer !== null) {
            clearTimeout(segmentBatchDebounceTimer);
          }
          segmentBatchDebounceTimer = setTimeout(() => {
            segmentBatchDebounceTimer = null;
            flushPendingSegments().catch((err) => {
              console.error("Batch segment processing failed:", err);
            });
          }, SEGMENT_BATCH_DEBOUNCE_MS);
        }
        break;
      case "done":
        // Recording finished - flush any pending segment batch, then post GitHub comments
        console.log(
          `[FluidHelper] Done: ${msg.totalSegments} segments, ${msg.totalSpeakers} speakers`,
        );
        isRecording = false;
        transcriptPanel.setProcessing(false);
        refreshStatusBar().catch((err) =>
          console.error("Error refreshing status bar:", err),
        );
        if (segmentBatchDebounceTimer !== null) {
          clearTimeout(segmentBatchDebounceTimer);
          segmentBatchDebounceTimer = null;
        }
        flushPendingSegments()
          .then(async () => {
            if (semanticChunkingTail !== null) {
              const tailResult = await chunkTranscript([], {
                previousTail: semanticChunkingTail,
                flushTail: true,
              });
              semanticChunkingTail = null;
              if (tailResult.chunks.length > 0) {
                await processChunksToComments(tailResult.chunks);
              }
            }
            if (pendingCommentEntries.length > 0) {
              approvalsPanel.refresh();
              approvalsPanel.show();
            }
          })
          .catch((err) => {
            console.error("Failed to flush pending segments:", err);
          });

        vscode.window.showInformationMessage(
          `Created ${processedSegmentCount} comment(s) from ${msg.totalSpeakers} speaker(s)`,
        );
        break;
      case "speaker":
        // Real-time speaker detection
        console.log(
          `[FluidHelper] Speaker ${msg.id}: ${msg.start}s - ${msg.end}s`,
        );
        transcriptPanel.updateCurrentSpeaker(msg.id as number);
        break;
      case "error":
        console.error(`[FluidHelper] Error: ${msg.message}`);
        vscode.window.showErrorMessage(`Transcription error: ${msg.message}`);
        break;
      case "debug":
        console.log(`[FluidHelper] Debug: ${msg.message}`);
        break;
    }
  }

  /**
   * Flush pending segments: take current queue and process in one batch (Gemini + comment locations)
   */
  async function flushPendingSegments(): Promise<void> {
    if (pendingSegmentsQueue.length === 0) {
      return;
    }
    const batch = pendingSegmentsQueue.splice(0);
    await processSegmentsBatch(batch);
  }

  /**
   * Run chunks through Gemini classify+transform, find locations, create comment threads and pending GitHub comments.
   */
  async function processChunksToComments(chunks: SpeakerSegment[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const contexts = contextCollector.getCurrentContext();
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const document = editor.document;
    const currentFile = getRepositoryRelativePath(document.uri) ?? "";

    const transformed = await processSegmentsCombined(chunks);
    const toComment = transformed.filter(
      (t) =>
        t.classification !== "Ignore" && t.transformedText.trim().length > 0,
    );
    if (toComment.length === 0) {
      return;
    }

    const ranges = await findCommentLocationsBatch(
      toComment,
      contexts,
      document,
      currentFile,
    );
    for (let i = 0; i < toComment.length; i++) {
      const transformedSegment = toComment[i];
      const commentText = transformedSegment.transformedText;
      const range = ranges[i];
      const thread = commentController.createCommentThread(
        document.uri,
        range,
        [
          {
            body: new vscode.MarkdownString(commentText),
            mode: vscode.CommentMode.Preview,
            author: { name: "PR Notes" },
          },
        ],
      );
      pendingCommentEntries.push({
        input: {
          path: currentFile,
          line: range.start.line + 1,
          body: commentText,
        },
        thread,
      });
      console.log(`[Batch] Created comment: "${commentText.slice(0, 50)}..."`);
    }
  }

  /**
   * Process multiple segments in one batch: semantic chunking (with cross-batch tail), then run chunks to comments.
   */
  async function processSegmentsBatch(
    segments: SpeakerSegment[],
  ): Promise<void> {
    if (segments.length === 0) {
      return;
    }
    const result = await chunkTranscript(segments, {
      previousTail: semanticChunkingTail,
    });
    semanticChunkingTail = result.pendingTail;
    if (result.chunks.length === 0) {
      return;
    }
    await processChunksToComments(result.chunks);
  }

  /**
   * Post a subset of pending comments to GitHub (from approvals panel).
   * After success, removes only the posted entries from pendingCommentEntries and disposes their threads.
   */
  async function postPendingGitHubComments(
    entriesToPost: { entry: PendingCommentEntry; body: string }[],
  ): Promise<void> {
    if (entriesToPost.length === 0) {
      return;
    }

    const postToGitHub =
      vscode.workspace
        .getConfiguration("pr-notes")
        .get<boolean>("postToGitHub") ?? true;
    if (!postToGitHub) {
      vscode.window.showInformationMessage(
        "Posting to GitHub is disabled in settings.",
      );
      return;
    }

    const session = await getSession(false);
    if (!session) {
      vscode.window.showWarningMessage(
        "Sign in with GitHub to post comments.",
      );
      return;
    }

    const prContext = await getPrContext(session.accessToken);
    if (!prContext) {
      vscode.window.showWarningMessage(
        "Could not resolve PR context (owner, repo, pull number). Check you're on a PR branch or set overrides.",
      );
      return;
    }

    const comments: ReviewCommentInput[] = entriesToPost.map(
      ({ entry, body }) => ({
        path: entry.input.path,
        line: entry.input.line,
        body,
      }),
    );
    const result = await postReviewComments(
      comments,
      prContext,
      session.accessToken,
    );
    if (result.success) {
      const postedSet = new Set(entriesToPost.map(({ entry }) => entry));
      for (let i = pendingCommentEntries.length - 1; i >= 0; i--) {
        if (postedSet.has(pendingCommentEntries[i])) {
          pendingCommentEntries[i].thread.dispose();
          pendingCommentEntries.splice(i, 1);
        }
      }
      vscode.window.showInformationMessage(
        `Posted ${comments.length} comment(s) to GitHub`,
      );
      approvalsPanel.refresh();
    } else {
      vscode.window.showErrorMessage(
        `Failed to post to GitHub: ${result.error}`,
      );
    }
  }

  function handleDiscardPendingComments(): void {
    for (const entry of pendingCommentEntries) {
      try {
        entry.thread.dispose();
      } catch {
        // Thread may already be disposed (e.g. user unchecked it)
      }
    }
    pendingCommentEntries = [];
    approvalsPanel.refresh();
  }

  const getPendingEntriesForPanel = (): PendingCommentDisplay[] =>
    pendingCommentEntries.map((e, i) => ({
      index: i,
      path: e.input.path,
      line: e.input.line,
      body: e.input.body,
    }));

  approvalsPanel = new ApprovalsPanelProvider(context.extensionUri, {
    getPendingEntries: getPendingEntriesForPanel,
    onPostToGitHub: async (
      selectedIndices: number[],
      bodiesByIndex: Record<number, string>,
    ) => {
      const entriesToPost = selectedIndices.map((i) => ({
        entry: pendingCommentEntries[i],
        body: bodiesByIndex[i] ?? pendingCommentEntries[i].input.body,
      }));
      await postPendingGitHubComments(entriesToPost);
    },
    onDiscard: handleDiscardPendingComments,
    onBodyChanged(index: number, body: string) {
      const entry = pendingCommentEntries[index];
      if (!entry) return;
      entry.input.body = body;
      const thread = entry.thread as vscode.CommentThread & {
        comments: vscode.Comment[];
      };
      thread.comments = [
        {
          body: new vscode.MarkdownString(body),
          mode: vscode.CommentMode.Preview,
          author: { name: "PR Notes" },
        },
      ];
    },
    onCommentUnselected(index: number) {
      const entry = pendingCommentEntries[index];
      if (!entry) return;
      entry.thread.dispose();
      // Keep entry in pendingCommentEntries so it stays in the approvals UI (unchecked)
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ApprovalsPanelProvider.viewType,
      approvalsPanel,
    ),
  );

  function handleStartRecording() {
    if (isRecording) {
      return;
    }

    const selectedDevice = getSelectedDevice();
    contextCollector.startRecording();

    // Start fluid-helper if not running, then send recording command with device
    startFluidHelper()
      .then(() => {
        if (fluidHelper?.stdin) {
          const msg = {
            type: "startRecording",
            deviceId: selectedDevice !== "default" ? selectedDevice : undefined,
          };
          fluidHelper.stdin.write(JSON.stringify(msg) + "\n");
          isRecording = true;
          refreshStatusBar().catch((err) =>
            console.error("Error refreshing status bar:", err),
          );
        }
      })
      .catch((err) => {
        vscode.window.showErrorMessage(
          `Failed to start recording: ${err.message}`,
        );
      });
  }

  function handleStopRecording() {
    if (!isRecording || !fluidHelper?.stdin) {
      return; // Not recording
    }

    // Stop context collection
    contextCollector.stopRecording();

    fluidHelper.stdin.write(JSON.stringify({ type: "stopRecording" }) + "\n");
    // isRecording will be set to false when 'done' message arrives
  }

  async function handleSelectDevice(): Promise<void> {
    const selectedDeviceId = await selectAudioDevice();
    if (selectedDeviceId) {
      await refreshStatusBar();
      // Look up device name for the message
      const devices = await listAudioDevices();
      const device = devices.find((d) => d.id === selectedDeviceId);
      const deviceName = device?.name || selectedDeviceId;
      vscode.window.showInformationMessage(
        `Audio input device set to: ${deviceName}`,
      );
    }
  }

  async function handleLogin(): Promise<void> {
    try {
      const session = await getSession(true);
      await refreshStatusBar();
      if (session?.account.label) {
        vscode.window.showInformationMessage(
          `Signed in as ${session.account.label}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      vscode.window.showErrorMessage(`GitHub sign-in failed: ${msg}`);
    }
  }

  // Status bar menu command (recording)
  const showMenuDisposable = vscode.commands.registerCommand(
    "pr-notes.showMenu",
    async () => {
      const deviceDisplayName = await getDeviceDisplayName();
      const authState = await getAuthState();
      const callbacks: StatusBarCallbacks = {
        onStartRecording: handleStartRecording,
        onStopRecording: handleStopRecording,
        onSelectDevice: handleSelectDevice,
        onLogin: handleLogin,
      };

      await showStatusBarMenu(
        isRecording,
        deviceDisplayName,
        callbacks,
        authState,
      );
      await refreshStatusBar();
    },
  );

  const loginDisposable = vscode.commands.registerCommand(
    "pr-notes.login",
    handleLogin,
  );

  // Download speech models command - allows users to pre-download models before first recording
  const downloadModelsDisposable = vscode.commands.registerCommand(
    "pr-notes.downloadModels",
    async () => {
      try {
        await startFluidHelper(true); // Show success message when complete
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        vscode.window.showErrorMessage(
          `Failed to download speech models: ${errorMessage}`,
        );
      }
    },
  );

  // Set Gemini API key command - prompts user to enter their API key (stored securely)
  const setGeminiApiKeyDisposable = vscode.commands.registerCommand(
    "pr-notes.setGeminiApiKey",
    async () => {
      const currentKey = await context.secrets.get(GEMINI_API_KEY_SECRET);

      const apiKey = await vscode.window.showInputBox({
        prompt:
          "Enter your Gemini API key (get one at https://aistudio.google.com/app/apikey)",
        placeHolder: "AIza...",
        value: currentKey ? "••••••••" + currentKey.slice(-4) : "",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return "API key cannot be empty";
          }
          if (value.startsWith("••••")) {
            return "Please enter a new API key or press Escape to cancel";
          }
          return null;
        },
      });

      if (apiKey && !apiKey.startsWith("••••")) {
        try {
          await context.secrets.store(GEMINI_API_KEY_SECRET, apiKey.trim());
          // Reset the Gemini client so it picks up the new key
          resetGeminiClient();
          vscode.window.showInformationMessage(
            "Gemini API key saved securely!",
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          vscode.window.showErrorMessage(
            `Failed to save API key: ${errorMessage}`,
          );
        }
      }
    },
  );

  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(commentController);
  context.subscriptions.push(showMenuDisposable);
  context.subscriptions.push(loginDisposable);
  context.subscriptions.push(downloadModelsDisposable);
  context.subscriptions.push(setGeminiApiKeyDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
  // Cleanup if needed
}
