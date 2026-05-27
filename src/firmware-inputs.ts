import * as vscode from "vscode";

import {
  firmwareTaskName,
  serialPortFilterConfigKey,
} from "./configuration";
import { detectSerialPorts } from "./serial-port-detect";

interface PickSerialPortArgs {
  placeholder?: string;
  filter?: string;
}

interface PromptInputArgs {
  prompt?: string;
  placeholder?: string;
  value?: string;
  password?: boolean;
  validateRegex?: string;
  validateMessage?: string;
}

interface PickFileArgs {
  title?: string;
  openLabel?: string;
  filters?: Record<string, string[]>;
  defaultUri?: string;
  canSelectMany?: boolean;
  relative?: boolean;
}

interface PickFolderArgs {
  title?: string;
  openLabel?: string;
  defaultUri?: string;
  relative?: boolean;
}

type PickFromListItem =
  | string
  | { label: string; value?: string; description?: string };

interface PickFromListArgs {
  items?: PickFromListItem[];
  placeholder?: string;
}

async function pickSerialPort(
  args?: PickSerialPortArgs,
  cachedValue?: string,
): Promise<string | undefined> {
  const configFilter = vscode.workspace
    .getConfiguration(firmwareTaskName)
    .get<string>(serialPortFilterConfigKey, "");
  const filter = args?.filter ?? (configFilter || undefined);

  const ports = await detectSerialPorts(filter);

  if (ports.length === 0) {
    return vscode.window.showInputBox({
      prompt: "No serial ports detected. Enter port path manually",
      placeHolder:
        process.platform === "win32" ? "COM3" : "/dev/tty.usbserial",
      value: cachedValue,
      ignoreFocusOut: true,
    });
  }

  const items = ports.map((p) => ({
    label: p.path,
    description: p.description,
  }));
  moveCachedToFront(items, (i) => i.label, cachedValue);

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: args?.placeholder ?? "Select serial port",
    ignoreFocusOut: true,
  });
  return picked?.label;
}

async function promptInput(
  args?: PromptInputArgs,
  cachedValue?: string,
): Promise<string | undefined> {
  let validateInput: ((value: string) => string | undefined) | undefined;
  if (args?.validateRegex) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(args.validateRegex);
    } catch {
      re = undefined;
    }
    if (re) {
      const message = args.validateMessage ?? "Invalid value";
      validateInput = (value: string) => (re.test(value) ? undefined : message);
    }
  }

  return vscode.window.showInputBox({
    prompt: args?.prompt,
    placeHolder: args?.placeholder,
    value: cachedValue ?? args?.value,
    password: args?.password ?? false,
    validateInput,
    ignoreFocusOut: true,
  });
}

function resolveDefaultUri(value?: string): vscode.Uri | undefined {
  if (!value) {
    return undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  const replaced = folder
    ? value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath)
    : value;
  try {
    if (replaced.startsWith("/") || /^[A-Za-z]:/.test(replaced)) {
      return vscode.Uri.file(replaced);
    }
    return folder ? vscode.Uri.joinPath(folder.uri, replaced) : undefined;
  } catch {
    return undefined;
  }
}

function toRelative(absolutePath: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return absolutePath;
  }
  const base = folder.uri.fsPath;
  if (absolutePath.startsWith(base + "/") || absolutePath.startsWith(base + "\\")) {
    return absolutePath.slice(base.length + 1);
  }
  return absolutePath;
}

function quoteIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

function moveCachedToFront<T>(
  items: T[],
  keyOf: (item: T) => string,
  cachedValue: string | undefined,
): void {
  if (!cachedValue) {
    return;
  }
  const idx = items.findIndex((item) => keyOf(item) === cachedValue);
  if (idx > 0) {
    const [hit] = items.splice(idx, 1);
    if (hit !== undefined) {
      items.unshift(hit);
    }
  }
}

function extractFirstCachedPath(cached: string | undefined): string | undefined {
  if (!cached) {
    return undefined;
  }
  if (cached.startsWith('"')) {
    const end = cached.indexOf('"', 1);
    if (end > 0) {
      return cached.slice(1, end);
    }
  }
  const space = cached.indexOf(" ");
  return space === -1 ? cached : cached.slice(0, space);
}

function resolveCachedFileUri(
  cachedValue: string | undefined,
  relative: boolean | undefined,
): vscode.Uri | undefined {
  const first = extractFirstCachedPath(cachedValue);
  if (!first) {
    return undefined;
  }
  if (relative) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      try {
        return vscode.Uri.joinPath(folder.uri, first);
      } catch {
        return undefined;
      }
    }
  }
  try {
    return vscode.Uri.file(first);
  } catch {
    return undefined;
  }
}

async function pickFile(
  args?: PickFileArgs,
  cachedValue?: string,
): Promise<string | undefined> {
  const defaultUri =
    resolveCachedFileUri(cachedValue, args?.relative) ??
    resolveDefaultUri(args?.defaultUri);
  const uris = await vscode.window.showOpenDialog({
    title: args?.title,
    openLabel: args?.openLabel ?? "Select",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: args?.canSelectMany ?? false,
    filters: args?.filters,
    defaultUri,
  });
  if (!uris || uris.length === 0) {
    return undefined;
  }
  const paths = uris.map((u) =>
    args?.relative ? toRelative(u.fsPath) : u.fsPath,
  );
  return paths.map(quoteIfNeeded).join(" ");
}

async function pickFolder(
  args?: PickFolderArgs,
  cachedValue?: string,
): Promise<string | undefined> {
  const defaultUri =
    resolveCachedFileUri(cachedValue, args?.relative) ??
    resolveDefaultUri(args?.defaultUri);
  const uris = await vscode.window.showOpenDialog({
    title: args?.title,
    openLabel: args?.openLabel ?? "Select Folder",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri,
  });
  const uri = uris?.[0];
  if (!uri) {
    return undefined;
  }
  const p = args?.relative ? toRelative(uri.fsPath) : uri.fsPath;
  return quoteIfNeeded(p);
}

async function pickFromList(
  args?: PickFromListArgs,
  cachedValue?: string,
): Promise<string | undefined> {
  const items = args?.items ?? [];
  if (items.length === 0) {
    return undefined;
  }
  const quickItems = items.map((item) => {
    if (typeof item === "string") {
      return { label: item, value: item };
    }
    return {
      label: item.label,
      description: item.description,
      value: item.value ?? item.label,
    };
  });
  moveCachedToFront(quickItems, (i) => i.value, cachedValue);
  const picked = await vscode.window.showQuickPick(quickItems, {
    placeHolder: args?.placeholder ?? "Select an option",
    ignoreFocusOut: true,
  });
  return picked?.value;
}

export function registerFirmwareInputCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "firmware-task.pickSerialPort",
      pickSerialPort,
    ),
    vscode.commands.registerCommand("firmware-task.promptInput", promptInput),
    vscode.commands.registerCommand("firmware-task.pickFile", pickFile),
    vscode.commands.registerCommand("firmware-task.pickFolder", pickFolder),
    vscode.commands.registerCommand(
      "firmware-task.pickFromList",
      pickFromList,
    ),
  );
}
