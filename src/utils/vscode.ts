import * as vscode from 'vscode';
import { listAudioDevices } from '../audioDeviceManager';

/**
 * Get the display name for a device ID
 */
export async function getDeviceDisplayName(deviceId: string | undefined): Promise<string | undefined> {
	if (!deviceId || deviceId === 'default') {
		return undefined;
	}
	
	const devices = await listAudioDevices();
	const device = devices.find(d => d.id === deviceId);
	return device?.name;
}

/**
 * Get the relative file path for a document
 */
export function getFileRelativePath(document: vscode.TextDocument): string {
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		return vscode.workspace.asRelativePath(document.uri, false);
	}
	return document.uri.fsPath;
}
