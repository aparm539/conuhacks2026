import * as vscode from "vscode";
import { exec } from "child_process";

export interface AudioDevice {
  id: string;
  name: string;
}

/**
 * Get the selected input device from VS Code settings
 */
export function getSelectedDevice(): string | undefined {
  const config = vscode.workspace.getConfiguration("pr-notes");
  return config.get<string>("inputDevice");
}

/**
 * Save the selected input device to VS Code settings
 */
export async function setSelectedDevice(deviceId: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("pr-notes");
  await config.update(
    "inputDevice",
    deviceId,
    vscode.ConfigurationTarget.Global,
  );
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  return new Promise<AudioDevice[]>((resolve, reject) => {
    // Use system_profiler to get audio devices
    exec("system_profiler SPAudioDataType -json", (error, stdout, stderr) => {
      if (error) {
        console.error("Error listing audio devices:", error);
        reject(error);
        return;
      }

      if (stderr) {
        console.warn("stderr from system_profiler:", stderr);
      }

      try {
        const data = JSON.parse(stdout);
        const devices: AudioDevice[] = [];

        if (data.SPAudioDataType && Array.isArray(data.SPAudioDataType)) {
          for (const device of data.SPAudioDataType) {
            if (device._name) {
              devices.push({
                id: device._name,
                name: device._name,
              });
            }
          }
        }

        // Always include default as first option
        resolve([{ id: "default", name: "Default Device" }, ...devices]);
      } catch (parseError) {
        console.error("Error parsing system_profiler output:", parseError);
        reject(parseError);
      }
    });
  });
}

/**
 * Show a quick pick menu to select input device
 */
export async function selectAudioDevice(): Promise<string | undefined> {
  const devices = await listAudioDevices();
  const currentDevice = getSelectedDevice();

  const items: vscode.QuickPickItem[] = devices.map((device) => ({
    label: device.name,
    description: device.id === currentDevice ? "Currently selected" : undefined,
    detail:
      device.id === "default"
        ? "System default audio input"
        : `Device ID: ${device.id}`,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select an audio input device",
  });

  if (!selected) {
    return undefined;
  }

  const selectedDevice = devices.find((d) => d.name === selected.label);
  if (selectedDevice) {
    await setSelectedDevice(selectedDevice.id);
    return selectedDevice.id;
  }

  return undefined;
}
