import * as vscode from 'vscode';

export interface StatusBarCallbacks {
	onStartRecording: () => void;
	onStopRecording: () => void;
	onSelectDevice: () => Promise<void>;
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
	isRecording: boolean,
	currentDevice?: string
): void {
	if (isRecording) {
		statusBarItem.text = "$(primitive-square) Recording";
		statusBarItem.tooltip = "Click to open recording menu";
	} else {
		if (currentDevice) {
			statusBarItem.text = `$(mic) Record (${currentDevice})`;
		} else {
			statusBarItem.text = "$(mic) Record";
		}
		statusBarItem.tooltip = "Click to open recording menu";
	}
}

export async function showStatusBarMenu(
	isRecording: boolean,
	currentDevice: string | undefined,
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
			detail: currentDevice ? `Using: ${currentDevice}` : undefined
		});
	}

	items.push({
		label: "",
		kind: vscode.QuickPickItemKind.Separator
	});

	// Add device selection option
	items.push({
		label: "$(settings-gear) Select Input Device",
		description: "Choose a different audio input device"
	});

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
	} else if (selected.label.includes("Current Device") || selected.label.includes("Select Input Device")) {
		await callbacks.onSelectDevice();
	}
}
