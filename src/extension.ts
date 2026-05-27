// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";

import { registerFirmwareInputCommands } from "./firmware-inputs";
import { InputCache } from "./input-cache";
import {
  configureTaskInputs,
  copyTaskCommand,
  executeTaskWithInputs,
} from "./task-executor";
import { openTaskSourceDocument } from "./task-source";
import { createTaskStateChangeHandler } from "./task-state";
import { TaskTreeDataProvider } from "./task-tree-data-provider";
import { TaskTreeItem } from "./task-tree-item";

const restartingTasks = new Map<vscode.Task, string>();
let treeView: vscode.TreeView<TaskTreeItem>;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const inputCache = new InputCache(context);
  const taskTreeDataProvider = new TaskTreeDataProvider(inputCache);
  registerFirmwareInputCommands(context);
  const updateTreeView = () => {
    void taskTreeDataProvider.refresh();
    updateViewBadge();
  };
  const updateTreeViewAfterTaskStateChanges =
    createTaskStateChangeHandler(updateTreeView);

  const refreshTasksCommand = vscode.commands.registerCommand(
    "firmware-task.refresh",
    () => {
      taskTreeDataProvider.triggerFullRefresh();
      updateViewBadge();
    },
  );
  const configureTaskCommand = vscode.commands.registerCommand(
    "firmware-task.configure",
    () => {
      vscode.commands.executeCommand(
        "workbench.action.tasks.configureTaskRunner",
      );
    },
  );
  const terminateAllTasksCommand = vscode.commands.registerCommand(
    "firmware-task.terminateAll",
    () => {
      vscode.tasks.taskExecutions.slice().forEach((e) => e.terminate());
    },
  );
  const runTaskCommand = vscode.commands.registerCommand(
    "firmware-task.run",
    async (taskTreeItem: TaskTreeItem) => {
      if (taskTreeItem.task) {
        await executeTaskWithInputs(
          taskTreeItem.task,
          taskTreeItem.path,
          inputCache,
        );
      }
    },
  );
  const viewTaskSourceCommand = vscode.commands.registerCommand(
    "firmware-task.viewSource",
    async (taskTreeItem: TaskTreeItem) => {
      const task = taskTreeItem.task;
      if (!task) {
        return;
      }

      try {
        const sourceDocument = await openTaskSourceDocument(task);
        if (!sourceDocument) {
          await vscode.window.showInformationMessage(
            `Unsupported task source: ${task.source}`,
          );
          return;
        }

        const sourceRange = new vscode.Range(
          sourceDocument.position,
          sourceDocument.position,
        );

        const editor = await vscode.window.showTextDocument(
          sourceDocument.document,
          {
            selection: sourceRange,
          },
        );

        editor.revealRange(sourceRange, vscode.TextEditorRevealType.InCenter);
      } catch {
        await vscode.window.showWarningMessage(
          `Unable to open task source for "${task.name}".`,
        );
      }
    },
  );
  const terminateTaskCommand = vscode.commands.registerCommand(
    "firmware-task.terminate",
    (taskTreeItem: TaskTreeItem) => {
      if (taskTreeItem.execution) {
        taskTreeItem.execution.terminate();
      }
    },
  );
  const restartTaskCommand = vscode.commands.registerCommand(
    "firmware-task.restart",
    (taskTreeItem: TaskTreeItem) => {
      if (taskTreeItem.execution) {
        const task = taskTreeItem.execution.task;
        restartingTasks.set(task, taskTreeItem.path);
        taskTreeItem.execution.terminate();
      }
    },
  );
  const favoriteTaskCommand = vscode.commands.registerCommand(
    "firmware-task.favorite",
    (taskTreeItem: TaskTreeItem) =>
      taskTreeDataProvider.favoriteTask(taskTreeItem),
  );
  const unfavoriteTaskCommand = vscode.commands.registerCommand(
    "firmware-task.unfavorite",
    (taskTreeItem: TaskTreeItem) =>
      taskTreeDataProvider.unfavoriteTask(taskTreeItem),
  );
  const configureInputsCommand = vscode.commands.registerCommand(
    "firmware-task.configureInputs",
    async (taskTreeItem: TaskTreeItem) => {
      if (!taskTreeItem.task) {
        return;
      }
      const changed = await configureTaskInputs(
        taskTreeItem.task,
        taskTreeItem.path,
        inputCache,
      );
      if (changed) {
        void taskTreeDataProvider.refresh();
      }
    },
  );
  const copyCommandCommand = vscode.commands.registerCommand(
    "firmware-task.copyCommand",
    async (taskTreeItem: TaskTreeItem) => {
      if (!taskTreeItem.task) {
        return;
      }
      const copied = await copyTaskCommand(
        taskTreeItem.task,
        taskTreeItem.path,
        inputCache,
      );
      if (copied) {
        void taskTreeDataProvider.refresh();
      }
    },
  );

  context.subscriptions.push(refreshTasksCommand);
  context.subscriptions.push(configureTaskCommand);
  context.subscriptions.push(terminateAllTasksCommand);
  context.subscriptions.push(runTaskCommand);
  context.subscriptions.push(viewTaskSourceCommand);
  context.subscriptions.push(terminateTaskCommand);
  context.subscriptions.push(restartTaskCommand);
  context.subscriptions.push(favoriteTaskCommand);
  context.subscriptions.push(unfavoriteTaskCommand);
  context.subscriptions.push(configureInputsCommand);
  context.subscriptions.push(copyCommandCommand);

  treeView = vscode.window.createTreeView("firmware-task.tasks", {
    treeDataProvider: taskTreeDataProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.tasks.onDidStartTask(updateTreeViewAfterTaskStateChanges),
  );
  context.subscriptions.push(
    vscode.tasks.onDidEndTask((event) => {
      updateTreeViewAfterTaskStateChanges();
      const task = event.execution.task;
      const taskPath = restartingTasks.get(task);
      if (taskPath !== undefined) {
        restartingTasks.delete(task);
        void executeTaskWithInputs(task, taskPath, inputCache, {
          useCachedOnly: true,
        });
      }
    }),
  );
}

// this method is called when your extension is deactivated
export function deactivate() {}

function updateViewBadge() {
  const count = vscode.tasks.taskExecutions.length;
  treeView.badge = {
    value: count,
    tooltip: `${count === 0 ? "No" : count.toString()} running ${count > 1 ? "tasks" : "task"}`,
  };
}
