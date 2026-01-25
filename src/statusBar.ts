import * as vscode from 'vscode';

export interface StatusBarCallbacks {
	onStartRecording: () => void;
	onStopRecording: () => void;
}

export function createStatusBarItem(): vscode.StatusBarItem {
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBarItem.text = "$(mic) Record";
	statusBarItem.tooltip = "Click to open recording menu";
	statusBarItem.show();
	return statusBarItem;
}

export function updateStatusBar(
	statusBarItem: vscode.StatusBarItem,
	isRecording: boolean
): void {
	if (isRecording) {
		statusBarItem.text = "$(primitive-square) Recording";
		statusBarItem.tooltip = "Click to open recording menu";
	} else {
		statusBarItem.text = "$(mic) Record";
		statusBarItem.tooltip = "Click to open recording menu";
	}
}

export async function showStatusBarMenu(
	isRecording: boolean,
	callbacks: StatusBarCallbacks
): Promise<void> {
	const items: vscode.QuickPickItem[] = [];

	// Add start/stop recording option
	if (isRecording) {
		items.push({
			label: "$(primitive-square) Stop Recording",
			description: "Stop the current recording",
			detail: "Recording is in progress"
		});
	} else {
		items.push({
			label: "$(mic) Start Recording",
			description: "Start a new recording",
			detail: "Using default audio input device"
		});
	}

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: "Recording Options"
	});

	if (!selected) {
		return;
	}

	// Handle selection
	if (selected.label.includes("Start Recording")) {
		callbacks.onStartRecording();
	} else if (selected.label.includes("Stop Recording")) {
		callbacks.onStopRecording();
	}
}
