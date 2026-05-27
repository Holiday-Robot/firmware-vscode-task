import { findNodeAtLocation, parseTree } from "jsonc-parser";
import * as vscode from "vscode";

import { InputCache } from "./input-cache";

const INPUT_VAR_RE = /\$\{input:([A-Za-z0-9_.-]+)\}/g;

interface TaskInputDef {
  id: string;
  type: string;
  description?: string;
  default?: string;
  options?: (string | { label: string; value: string })[];
  command?: string;
  args?: unknown;
  password?: boolean;
}

function collectInputIds(strings: string[]): string[] {
  const ids = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(INPUT_VAR_RE)) {
      const id = m[1];
      if (id) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

function extractCommandStrings(task: vscode.Task): string[] {
  const out: string[] = [];
  const exec = task.execution;
  if (exec instanceof vscode.ShellExecution) {
    if (exec.commandLine !== undefined) {
      out.push(exec.commandLine);
    }
    if (exec.command !== undefined) {
      out.push(typeof exec.command === "string" ? exec.command : exec.command.value);
    }
    if (exec.args) {
      for (const a of exec.args) {
        out.push(typeof a === "string" ? a : a.value);
      }
    }
  } else if (exec instanceof vscode.ProcessExecution) {
    out.push(exec.process);
    for (const a of exec.args) {
      out.push(a);
    }
  }
  return out;
}

function substitute(value: string, values: Record<string, string>): string {
  return value.replace(INPUT_VAR_RE, (match, id: string) =>
    Object.prototype.hasOwnProperty.call(values, id) ? values[id]! : match,
  );
}

function substituteShellArg(
  arg: string | vscode.ShellQuotedString,
  values: Record<string, string>,
): string | vscode.ShellQuotedString {
  if (typeof arg === "string") {
    return substitute(arg, values);
  }
  return { value: substitute(arg.value, values), quoting: arg.quoting };
}

type TaskExecution =
  | vscode.ShellExecution
  | vscode.ProcessExecution
  | vscode.CustomExecution;

function rebuildExecution(
  task: vscode.Task,
  values: Record<string, string>,
): TaskExecution | undefined {
  const exec = task.execution;
  if (exec instanceof vscode.ShellExecution) {
    const options = exec.options;
    if (exec.commandLine !== undefined) {
      return new vscode.ShellExecution(
        substitute(exec.commandLine, values),
        options,
      );
    }
    const command = exec.command ?? "";
    const newCommand = substituteShellArg(command, values);
    const newArgs = (exec.args ?? []).map((a) => substituteShellArg(a, values));
    return new vscode.ShellExecution(newCommand, newArgs, options);
  }
  if (exec instanceof vscode.ProcessExecution) {
    return new vscode.ProcessExecution(
      substitute(exec.process, values),
      exec.args.map((a) => substitute(a, values)),
      exec.options,
    );
  }
  return exec;
}

function rebuildTask(
  task: vscode.Task,
  newExecution: TaskExecution | undefined,
): vscode.Task {
  const newTask = new vscode.Task(
    task.definition,
    task.scope ?? vscode.TaskScope.Workspace,
    task.name,
    task.source,
    newExecution,
    task.problemMatchers,
  );
  newTask.group = task.group;
  newTask.presentationOptions = task.presentationOptions;
  newTask.runOptions = task.runOptions;
  newTask.detail = task.detail;
  newTask.isBackground = task.isBackground;
  return newTask;
}

async function readTasksJsonInputs(
  task: vscode.Task,
): Promise<Map<string, TaskInputDef>> {
  const inputs = new Map<string, TaskInputDef>();
  const folder =
    typeof task.scope === "object"
      ? (task.scope as vscode.WorkspaceFolder)
      : vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return inputs;
  }

  const uri = vscode.Uri.joinPath(folder.uri, ".vscode", "tasks.json");
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return inputs;
  }

  const text = new TextDecoder().decode(bytes);
  const root = parseTree(text);
  if (!root) {
    return inputs;
  }

  const inputsNode = findNodeAtLocation(root, ["inputs"]);
  if (!inputsNode || !inputsNode.children) {
    return inputs;
  }

  for (const itemNode of inputsNode.children) {
    if (!itemNode.children) {
      continue;
    }
    const obj: Record<string, unknown> = {};
    for (const prop of itemNode.children) {
      const keyNode = prop.children?.[0];
      const valueNode = prop.children?.[1];
      if (!keyNode || !valueNode) {
        continue;
      }
      obj[keyNode.value as string] = jsonNodeToValue(valueNode);
    }
    if (typeof obj["id"] === "string" && typeof obj["type"] === "string") {
      inputs.set(obj["id"], obj as unknown as TaskInputDef);
    }
  }

  return inputs;
}

function jsonNodeToValue(node: {
  type: string;
  value?: unknown;
  children?: { value?: unknown; children?: unknown[] }[];
}): unknown {
  if (node.type === "string" || node.type === "boolean" || node.type === "number" || node.type === "null") {
    return node.value;
  }
  if (node.type === "array") {
    return (node.children ?? []).map((c) =>
      jsonNodeToValue(c as Parameters<typeof jsonNodeToValue>[0]),
    );
  }
  if (node.type === "object") {
    const out: Record<string, unknown> = {};
    for (const prop of (node.children ?? []) as {
      children?: { value?: unknown }[];
    }[]) {
      const k = prop.children?.[0];
      const v = prop.children?.[1];
      if (k && v && typeof k.value === "string") {
        out[k.value] = jsonNodeToValue(
          v as Parameters<typeof jsonNodeToValue>[0],
        );
      }
    }
    return out;
  }
  return undefined;
}

async function resolveInput(
  def: TaskInputDef,
  cachedValue: string | undefined,
): Promise<string | undefined> {
  const prefill = cachedValue ?? def.default;

  if (def.type === "promptString") {
    return vscode.window.showInputBox({
      prompt: def.description,
      value: prefill,
      password: def.password ?? false,
      ignoreFocusOut: true,
    });
  }

  if (def.type === "pickString") {
    const options = def.options ?? [];
    const items = options.map((opt) =>
      typeof opt === "string"
        ? { label: opt, value: opt }
        : { label: opt.label, value: opt.value },
    );
    if (cachedValue !== undefined) {
      const idx = items.findIndex((i) => i.value === cachedValue);
      if (idx > 0) {
        const [hit] = items.splice(idx, 1);
        if (hit !== undefined) {
          items.unshift(hit);
        }
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: def.description,
      ignoreFocusOut: true,
    });
    return picked?.value;
  }

  if (def.type === "command" && def.command) {
    const result = (await vscode.commands.executeCommand(
      def.command,
      def.args,
      cachedValue,
    )) as unknown;
    return typeof result === "string" ? result : undefined;
  }

  return undefined;
}

export function extractInputIds(task: vscode.Task): string[] {
  return collectInputIds(extractCommandStrings(task));
}

async function resolveAllInputs(
  task: vscode.Task,
  taskPath: string,
  cache: InputCache,
  options: { useCachedOnly?: boolean; forcePrompt?: boolean } = {},
): Promise<Record<string, string> | undefined> {
  const inputIds = extractInputIds(task);
  if (inputIds.length === 0) {
    return {};
  }

  const inputDefs = await readTasksJsonInputs(task);
  const cached = cache.getAll(taskPath);
  const values: Record<string, string> = {};

  for (const id of inputIds) {
    if (cached[id] !== undefined && !options.forcePrompt) {
      values[id] = cached[id];
      continue;
    }

    if (options.useCachedOnly) {
      return undefined;
    }

    const def = inputDefs.get(id);
    let value: string | undefined;
    if (def) {
      value = await resolveInput(def, cached[id]);
    } else {
      value = await vscode.window.showInputBox({
        prompt: `Value for \${input:${id}}`,
        value: cached[id],
        ignoreFocusOut: true,
      });
    }

    if (value === undefined) {
      return undefined;
    }

    values[id] = value;
    await cache.set(taskPath, id, value);
  }

  return values;
}

export async function executeTaskWithInputs(
  task: vscode.Task,
  taskPath: string,
  cache: InputCache,
  options: { useCachedOnly?: boolean } = {},
): Promise<vscode.TaskExecution | undefined> {
  const values = await resolveAllInputs(task, taskPath, cache, options);
  if (values === undefined) {
    return undefined;
  }

  if (Object.keys(values).length === 0) {
    return vscode.tasks.executeTask(task);
  }

  const newExec = rebuildExecution(task, values);
  const newTask = rebuildTask(task, newExec);
  return vscode.tasks.executeTask(newTask);
}

function formatExecution(
  exec: TaskExecution | undefined,
): string | undefined {
  if (exec instanceof vscode.ShellExecution) {
    if (exec.commandLine !== undefined) {
      return exec.commandLine;
    }
    const command = exec.command;
    const commandStr =
      typeof command === "string" ? command : (command?.value ?? "");
    const parts: string[] = [commandStr];
    for (const a of exec.args ?? []) {
      parts.push(typeof a === "string" ? a : a.value);
    }
    return parts.join(" ").trim();
  }
  if (exec instanceof vscode.ProcessExecution) {
    return [exec.process, ...exec.args].join(" ").trim();
  }
  return undefined;
}

export async function copyTaskCommand(
  task: vscode.Task,
  taskPath: string,
  cache: InputCache,
): Promise<boolean> {
  const values = await resolveAllInputs(task, taskPath, cache);
  if (values === undefined) {
    return false;
  }

  const exec =
    Object.keys(values).length === 0
      ? task.execution
      : rebuildExecution(task, values);
  const commandLine = formatExecution(exec ?? undefined);
  if (!commandLine) {
    void vscode.window.showWarningMessage(
      `Task "${task.name}" has no shell/process command to copy.`,
    );
    return false;
  }

  await vscode.env.clipboard.writeText(commandLine);
  const preview =
    commandLine.length > 80 ? `${commandLine.slice(0, 77)}…` : commandLine;
  void vscode.window.showInformationMessage(`Copied: ${preview}`);
  return true;
}

export async function configureTaskInputs(
  task: vscode.Task,
  taskPath: string,
  cache: InputCache,
): Promise<boolean> {
  const inputIds = extractInputIds(task);
  if (inputIds.length === 0) {
    void vscode.window.showInformationMessage(
      `Task "${task.name}" has no \${input:...} variables to configure.`,
    );
    return false;
  }

  const values = await resolveAllInputs(task, taskPath, cache, {
    forcePrompt: true,
  });
  return values !== undefined;
}
