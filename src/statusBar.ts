import * as vscode from 'vscode';

export interface AuthState {
	loggedIn: boolean;
	accountLabel?: string;
}

export interface StatusBarCallbacks {
	onStartRecording: () => void;
	onStopRecording: () => void;
	onSelectDevice: () => Promise<void>;
	onLogin?: () => Promise<void>;
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
	currentDevice?: string,
	accountLabel?: string
): void {
	let tooltip = "Click to open recording menu";
	if (accountLabel) {
		tooltip = `Signed in as ${accountLabel} • ${tooltip}`;
	}
	if (isRecording) {
		statusBarItem.text = "$(primitive-square) Recording";
		statusBarItem.tooltip = tooltip;
	} else {
		if (currentDevice) {
			statusBarItem.text = `$(mic) Record (${currentDevice})`;
		} else {
			statusBarItem.text = "$(mic) Record";
		}
		statusBarItem.tooltip = tooltip;
	}
}

export async function showStatusBarMenu(
	isRecording: boolean,
	currentDevice: string | undefined,
	callbacks: StatusBarCallbacks,
	authState?: AuthState
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

	items.push({
		label: "",
		kind: vscode.QuickPickItemKind.Separator
	});

	// Add device selection option
	items.push({
		label: "$(settings-gear) Select Input Device",
		description: "Choose a different audio input device"
	});

	// Auth section
	items.push({
		label: "",
		kind: vscode.QuickPickItemKind.Separator
	});

	if (authState?.loggedIn && authState.accountLabel) {
		items.push({
			label: "$(account) Signed in as " + authState.accountLabel,
			description: "GitHub account"
		});
	} else {
		items.push({
			label: "$(github) Sign in with GitHub",
			description: "Sign in to use GitHub features"
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
	} else if (selected.label.includes("Current Device") || selected.label.includes("Select Input Device")) {
		await callbacks.onSelectDevice();
	} else if (selected.label.includes("Sign in with GitHub") && callbacks.onLogin) {
		await callbacks.onLogin();
	}
}
