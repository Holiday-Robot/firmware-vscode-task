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

interface TaskTerminalFlags {
  runInActiveTerminal: boolean;
  terminalName?: string;
}

// tasks.json 의 해당 task(label 매칭)에서 커스텀 플래그를 직접 읽는다.
// VSCode 는 빌트인 task 타입(shell/process)의 definition 에서 미정의 키를 떼어내므로
// task.definition 대신 원본 파일을 jsonc-parser 로 파싱한다 (readTasksJsonInputs 와 동일 패턴).
async function readTaskFlagsFromTasksJson(
  task: vscode.Task,
): Promise<TaskTerminalFlags> {
  const flags: TaskTerminalFlags = { runInActiveTerminal: false };
  const folder =
    typeof task.scope === "object"
      ? (task.scope as vscode.WorkspaceFolder)
      : vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return flags;
  }

  const uri = vscode.Uri.joinPath(folder.uri, ".vscode", "tasks.json");
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return flags;
  }

  const root = parseTree(new TextDecoder().decode(bytes));
  if (!root) {
    return flags;
  }

  const tasksNode = findNodeAtLocation(root, ["tasks"]);
  if (!tasksNode || !tasksNode.children) {
    return flags;
  }

  for (const itemNode of tasksNode.children) {
    const obj = jsonNodeToValue(
      itemNode as Parameters<typeof jsonNodeToValue>[0],
    ) as Record<string, unknown> | undefined;
    if (!obj || obj["label"] !== task.name) {
      continue;
    }
    if (obj["runInActiveTerminal"] === true) {
      flags.runInActiveTerminal = true;
    }
    if (typeof obj["terminalName"] === "string" && obj["terminalName"]) {
      flags.terminalName = obj["terminalName"];
    }
    break;
  }

  return flags;
}

// 전송 대상 터미널 선택: 이름 지정 시 그 터미널(없으면 생성) → 활성 터미널 → 없으면 생성.
// reload 후 터미널 객체 참조는 사라지므로 항상 이름으로 재탐색한다.
function getTargetTerminal(
  terminalName: string | undefined,
  cwd: string | undefined,
): vscode.Terminal {
  if (terminalName) {
    const existing = vscode.window.terminals.find(
      (t) => t.name === terminalName,
    );
    return existing ?? vscode.window.createTerminal({ name: terminalName, cwd });
  }
  return (
    vscode.window.activeTerminal ??
    vscode.window.createTerminal({ name: "Firmware Task", cwd })
  );
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

function taskCwd(task: vscode.Task): string | undefined {
  const exec = task.execution;
  const cwd =
    exec instanceof vscode.ShellExecution ||
    exec instanceof vscode.ProcessExecution
      ? exec.options?.cwd
      : undefined;
  if (cwd) {
    return cwd;
  }
  return typeof task.scope === "object"
    ? (task.scope as vscode.WorkspaceFolder).uri.fsPath
    : undefined;
}

// task 의 명령줄을 새 task 터미널 대신 (지정/활성/신규) 터미널에 입력·실행한다.
// IDF export 등 환경이 이미 잡힌 인터랙티브 터미널을 재사용하기 위한 경로.
async function runTaskInActiveTerminal(
  task: vscode.Task,
  taskPath: string,
  cache: InputCache,
  flags: TaskTerminalFlags,
  options: { useCachedOnly?: boolean } = {},
): Promise<void> {
  const values = await resolveAllInputs(task, taskPath, cache, options);
  if (values === undefined) {
    return;
  }

  const exec =
    Object.keys(values).length === 0
      ? task.execution
      : rebuildExecution(task, values);
  const commandLine = formatExecution(exec ?? undefined);
  if (!commandLine) {
    void vscode.window.showWarningMessage(
      `Task "${task.name}" has no shell/process command to send to a terminal.`,
    );
    return;
  }

  const terminal = getTargetTerminal(flags.terminalName, taskCwd(task));
  terminal.show();
  terminal.sendText(commandLine, true);
}

export async function executeTaskWithInputs(
  task: vscode.Task,
  taskPath: string,
  cache: InputCache,
  options: { useCachedOnly?: boolean } = {},
): Promise<vscode.TaskExecution | undefined> {
  const flags = await readTaskFlagsFromTasksJson(task);
  if (flags.runInActiveTerminal) {
    await runTaskInActiveTerminal(task, taskPath, cache, flags, options);
    return undefined;
  }

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

interface DefaultBuildTaskInfo {
  label: string;
  runInActiveTerminal: boolean;
}

// 모든 워크스페이스 폴더의 tasks.json 에서 group {kind:"build", isDefault:true} 인 task 를 찾는다.
// (VSCode 의 "Run Build Task" 가 고르는 디폴트 빌드 task 와 동일 기준.)
async function findDefaultBuildTasks(): Promise<DefaultBuildTaskInfo[]> {
  const result: DefaultBuildTaskInfo[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(folder.uri, ".vscode", "tasks.json");
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    const root = parseTree(new TextDecoder().decode(bytes));
    if (!root) {
      continue;
    }
    const tasksNode = findNodeAtLocation(root, ["tasks"]);
    if (!tasksNode || !tasksNode.children) {
      continue;
    }
    for (const itemNode of tasksNode.children) {
      const obj = jsonNodeToValue(
        itemNode as Parameters<typeof jsonNodeToValue>[0],
      ) as Record<string, unknown> | undefined;
      if (!obj || typeof obj["label"] !== "string") {
        continue;
      }
      const group = obj["group"];
      const isDefaultBuild =
        typeof group === "object" &&
        group !== null &&
        (group as Record<string, unknown>)["kind"] === "build" &&
        (group as Record<string, unknown>)["isDefault"] === true;
      if (isDefaultBuild) {
        result.push({
          label: obj["label"],
          runInActiveTerminal: obj["runInActiveTerminal"] === true,
        });
      }
    }
  }
  return result;
}

// context-key 용: runInActiveTerminal 인 디폴트 빌드 task 가 하나라도 있는지.
export async function hasDefaultBuildInActiveTerminal(): Promise<boolean> {
  const infos = await findDefaultBuildTasks();
  return infos.some((i) => i.runInActiveTerminal);
}

// 디폴트 빌드 task 를 확장 경로(executeTaskWithInputs)로 실행한다.
// 네이티브 "Run Build Task" 단축키가 확장을 우회하는 문제를 피하기 위해, 단축키를 이 명령으로
// 라우팅하면 runInActiveTerminal 플래그가 그대로 적용된다.
export async function runDefaultBuildTask(cache: InputCache): Promise<void> {
  const infos = await findDefaultBuildTasks();
  const target = infos.find((i) => i.runInActiveTerminal) ?? infos[0];
  if (!target) {
    void vscode.window.showInformationMessage(
      "No default build task (group.kind=build, isDefault=true) found in tasks.json.",
    );
    return;
  }

  const tasks = await vscode.tasks.fetchTasks();
  const task = tasks.find((t) => t.name === target.label);
  if (!task) {
    void vscode.window.showWarningMessage(
      `Default build task "${target.label}" not found.`,
    );
    return;
  }

  await executeTaskWithInputs(task, task.name, cache);
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
