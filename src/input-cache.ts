import * as vscode from "vscode";

import {
  firmwareTaskName,
  rememberInputsConfigKey,
} from "./configuration";

const STORAGE_KEY = "firmwareTask.inputCache";

type CacheMap = Record<string, Record<string, string>>;

function isRememberEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(firmwareTaskName)
    .get(rememberInputsConfigKey, true);
}

export class InputCache {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public get(taskPath: string, inputId: string): string | undefined {
    if (!isRememberEnabled()) {
      return undefined;
    }
    const all = this.context.workspaceState.get<CacheMap>(STORAGE_KEY, {});
    return all[taskPath]?.[inputId];
  }

  public getAll(taskPath: string): Record<string, string> {
    if (!isRememberEnabled()) {
      return {};
    }
    const all = this.context.workspaceState.get<CacheMap>(STORAGE_KEY, {});
    return all[taskPath] ?? {};
  }

  public async set(
    taskPath: string,
    inputId: string,
    value: string,
  ): Promise<void> {
    if (!isRememberEnabled()) {
      return;
    }
    const all = this.context.workspaceState.get<CacheMap>(STORAGE_KEY, {});
    const forTask = { ...(all[taskPath] ?? {}), [inputId]: value };
    await this.context.workspaceState.update(STORAGE_KEY, {
      ...all,
      [taskPath]: forTask,
    });
  }
}
