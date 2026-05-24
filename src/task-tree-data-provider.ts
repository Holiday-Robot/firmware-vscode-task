import * as nodePath from "node:path";

import * as vscode from "vscode";

import {
  collapseLargeTaskTreeConfigKey,
  collapseLargeTaskTreeConfigPath,
  excludeConfigKey,
  excludeConfigPath,
  favoritesConfigKey,
  favoritesConfigPath,
  firmwareTaskName,
  groupByNameSeparatorConfigKey,
  groupByNameSeparatorConfigPath,
  showOnlyWorkspaceTasksConfigKey,
  showOnlyWorkspaceTasksConfigPath,
  taskSortOrderConfigKey,
  taskSortOrderConfigPath,
} from "./configuration";
import { compareStrings, getOrAdd } from "./helpers";
import { InputCache } from "./input-cache";
import { extractInputIds } from "./task-executor";
import { TaskScope } from "./task-scope";
import {
  invalidateWorkspaceTaskSourceFileCache,
  taskFileRegExp,
} from "./task-source";
import { TaskTreeItem } from "./task-tree-item";
import { TaskTreeItemType } from "./task-tree-item-type";

const favoritesLabel = "Favorites";
const taskDiscoveryRefreshDelays = [300, 1000, 3000];
const taskGroupOrder = new Map<string, number>([
  ["build", 0],
  ["test", 1],
  ["clean", 2],
  ["rebuild", 3],
]);

function formatInputsSummary(
  inputIds: string[],
  cached: Record<string, string>,
): string {
  const truncate = (value: string, max = 30): string => {
    if (value.length <= max) {
      return value;
    }
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return `${value.slice(0, head)}…${value.slice(-tail)}`;
  };
  return inputIds
    .map((id) => {
      const value = cached[id];
      return value !== undefined ? `${id}=${truncate(value)}` : `${id}=?`;
    })
    .join(" · ");
}

type TaskSortOrder = "label" | "group" | "provider";

export class TaskTreeDataProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private _tree: TaskTreeItem[] | undefined;
  private _treeSignature: string | undefined;
  private _refreshVersion = 0;
  private _watchers: { [key: string]: vscode.FileSystemWatcher[] } = {};
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TaskTreeItem | undefined
  >();

  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly inputCache: InputCache) {
    this.setupWatchers();
    this.refreshAfterTaskDiscovery();
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      void this.refresh();
      this.refreshAfterTaskDiscovery();
      this.setupWatchers(e.added, e.removed);
    });
    vscode.workspace.onDidChangeConfiguration(
      (event: vscode.ConfigurationChangeEvent) => {
        if (
          event.affectsConfiguration(excludeConfigPath) ||
          event.affectsConfiguration(collapseLargeTaskTreeConfigPath) ||
          event.affectsConfiguration(taskSortOrderConfigPath) ||
          event.affectsConfiguration(favoritesConfigPath) ||
          event.affectsConfiguration(showOnlyWorkspaceTasksConfigPath) ||
          event.affectsConfiguration(groupByNameSeparatorConfigPath)
        ) {
          void this.refresh();
        }
      },
    );
  }

  public refresh = async (fileUri?: vscode.Uri): Promise<void> => {
    if (!fileUri || taskFileRegExp.test(fileUri.path)) {
      if (fileUri) {
        invalidateWorkspaceTaskSourceFileCache(fileUri);
      }

      const refreshVersion = ++this._refreshVersion;
      const tree = await TaskTreeDataProvider.generateTree(this.inputCache);
      if (refreshVersion !== this._refreshVersion) {
        return;
      }

      const treeSignature = TaskTreeDataProvider.getTreeSignature(tree);
      if (treeSignature === this._treeSignature) {
        return;
      }

      this._tree = tree;
      this._treeSignature = treeSignature;
      this._onDidChangeTreeData.fire(undefined);
    }
  };

  public getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (element) {
      return element.children;
    } else {
      const treeItems = await this.getTree();
      return treeItems;
    }
  }

  public findTreeItem(task: vscode.Task): TaskTreeItem | undefined {
    if (!this._tree) {
      return undefined;
    }

    return TaskTreeDataProvider.findTreeItem(task, this._tree);
  }

  public async favoriteTask(taskTreeItem: TaskTreeItem): Promise<void> {
    await TaskTreeDataProvider.updateFavoriteTaskIds((favoriteTaskIds) => {
      if (taskTreeItem.task) {
        favoriteTaskIds.add(taskTreeItem.path);
      }
    });
  }

  public async unfavoriteTask(taskTreeItem: TaskTreeItem): Promise<void> {
    await TaskTreeDataProvider.updateFavoriteTaskIds((favoriteTaskIds) => {
      if (taskTreeItem.task) {
        favoriteTaskIds.delete(taskTreeItem.path);
      }
    });
  }

  private static findTreeItem(
    task: vscode.Task,
    items: TaskTreeItem[],
  ): TaskTreeItem | undefined {
    for (const child of items) {
      const match = TaskTreeDataProvider.findItemInSubtree(task, child);
      if (match) {
        return match;
      }
    }

    return undefined;
  }

  private static findItemInSubtree(
    task: vscode.Task,
    root: TaskTreeItem,
  ): TaskTreeItem | undefined {
    if (root.task === task) {
      return root;
    }

    return TaskTreeDataProvider.findTreeItem(task, root.children);
  }

  private static async getTasks(): Promise<vscode.Task[]> {
    const allTasks = await vscode.tasks.fetchTasks();
    const config = vscode.workspace.getConfiguration(firmwareTaskName);

    const showOnlyWorkspaceTasks = config.get(
      showOnlyWorkspaceTasksConfigKey,
      true,
    );
    const sourceFiltered = showOnlyWorkspaceTasks
      ? allTasks.filter((task) => task.source === "Workspace")
      : allTasks;

    const excludePattern = config.get(excludeConfigKey) as string | null;
    if (!excludePattern) {
      return sourceFiltered;
    }

    const excludeRegExp = new RegExp(excludePattern);
    return sourceFiltered.filter((task) => !excludeRegExp.test(task.name));
  }

  private static async generateTree(
    inputCache: InputCache,
  ): Promise<TaskTreeItem[]> {
    const treeItemMap = new Map<string, TaskTreeItem>();
    const tasks = await TaskTreeDataProvider.getTasks();
    const favoriteTaskIds = new Set(TaskTreeDataProvider.getFavoriteTaskIds());
    const taskSortOrder = TaskTreeDataProvider.getTaskSortOrder();
    const separator = TaskTreeDataProvider.getGroupSeparator();

    // Bucket tasks by their source-level tree node path
    const tasksBySource = new Map<
      string,
      { parent: TaskTreeItem; basePath: string; tasks: vscode.Task[] }
    >();

    for (const task of tasks) {
      const scope = task.scope ?? vscode.TaskScope.Global;
      let treeKey = TaskScope.getScopeName(scope);
      let parent = getOrAdd(
        treeItemMap,
        treeKey,
        () =>
          new TaskTreeItem(
            new TaskScope(scope),
            TaskTreeItemType.scope,
            treeKey,
          ),
      );

      const folderPath = task.definition["path"] as string | undefined;
      if (folderPath) {
        treeKey = `${treeKey}/${folderPath}`;
        parent = getOrAdd(
          treeItemMap,
          treeKey,
          () =>
            new TaskTreeItem(
              folderPath,
              TaskTreeItemType.folder,
              treeKey,
              parent,
            ),
        );
      }

      treeKey = `${treeKey}/${task.source}`;
      const sourceLabel = TaskTreeDataProvider.getSourceLabel(task);
      const sourceParent = getOrAdd(treeItemMap, treeKey, () => {
        const item = new TaskTreeItem(
          sourceLabel,
          TaskTreeItemType.source,
          treeKey,
          parent,
        );
        if (task.source === "Workspace") {
          item.iconPath = vscode.Uri.file(
            nodePath.join(__dirname, "..", "images", "logo.png"),
          );
          item.resourceUri = undefined;
        }
        return item;
      });

      let bucket = tasksBySource.get(treeKey);
      if (!bucket) {
        bucket = { parent: sourceParent, basePath: treeKey, tasks: [] };
        tasksBySource.set(treeKey, bucket);
      }
      bucket.tasks.push(task);
    }

    for (const { parent, basePath, tasks: sourceTasks } of tasksBySource.values()) {
      TaskTreeDataProvider.buildTaskNodes(
        sourceTasks,
        parent,
        basePath,
        favoriteTaskIds,
        separator,
        inputCache,
      );
    }

    const treeItems = Array.from(treeItemMap.values()).filter(
      (item) => item.type === TaskTreeItemType.scope,
    );
    TaskTreeDataProvider.sortTree(treeItems, taskSortOrder);

    // If only one scope, lift its children to top level to reduce nesting
    const rootItems =
      treeItems.length === 1 ? treeItems[0]!.children : treeItems;
    const shouldCollapseRootItems =
      TaskTreeDataProvider.shouldCollapseRootItems(rootItems, tasks.length);
    TaskTreeDataProvider.addFavoritesGroup(rootItems, tasks, favoriteTaskIds);
    if (shouldCollapseRootItems) {
      for (const item of rootItems) {
        if (
          item.type !== TaskTreeItemType.favorites &&
          item.collapsibleState !== vscode.TreeItemCollapsibleState.None
        ) {
          item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        }
      }
    }

    return rootItems;
  }

  private static addFavoritesGroup(
    rootItems: TaskTreeItem[],
    tasks: vscode.Task[],
    favoriteTaskIds: Set<string>,
  ): void {
    if (favoriteTaskIds.size === 0) {
      return;
    }

    const favoritesItem = new TaskTreeItem(
      favoritesLabel,
      TaskTreeItemType.favorites,
      favoritesLabel,
    );
    const omitRootScope = TaskTreeDataProvider.hasSingleTaskScope(tasks);
    const taskOriginsByLabel = TaskTreeDataProvider.getTaskOriginsByLabel(
      tasks,
      omitRootScope,
    );

    for (const task of tasks) {
      const taskPath = TaskTreeDataProvider.getTaskPath(task);
      if (favoriteTaskIds.has(taskPath)) {
        const inputIds = extractInputIds(task);
        const hasInputs = inputIds.length > 0;
        new TaskTreeItem(task, TaskTreeItemType.task, taskPath, favoritesItem, {
          description: TaskTreeDataProvider.getShortestTaskOrigin(
            task,
            taskOriginsByLabel,
            omitRootScope,
          ),
          isFavorite: true,
          hasInputs,
          tooltip: TaskTreeDataProvider.getTaskDisplayPath(task, omitRootScope),
        });
      }
    }

    if (favoritesItem.children.length > 0) {
      favoritesItem.children.sort((x, y) =>
        TaskTreeDataProvider.compareFavoriteTasks(x, y),
      );
      rootItems.unshift(favoritesItem);
    }
  }

  private static compareFavoriteTasks(
    x: TaskTreeItem,
    y: TaskTreeItem,
  ): number {
    return (
      compareStrings(
        TaskTreeDataProvider.getTreeItemLabel(x),
        TaskTreeDataProvider.getTreeItemLabel(y),
      ) ||
      compareStrings(
        TaskTreeDataProvider.getTreeItemDescription(x),
        TaskTreeDataProvider.getTreeItemDescription(y),
      ) ||
      compareStrings(
        TaskTreeDataProvider.getTreeItemTooltip(x),
        TaskTreeDataProvider.getTreeItemTooltip(y),
      ) ||
      compareStrings(x.path, y.path)
    );
  }

  private static getGroupSeparator(): string {
    const value = vscode.workspace
      .getConfiguration(firmwareTaskName)
      .get<string>(groupByNameSeparatorConfigKey, "-");
    return value ?? "";
  }

  private static getSourceLabel(task: vscode.Task): string {
    if (task.source === "Workspace") {
      if (
        task.scope !== undefined &&
        typeof task.scope === "object" &&
        "name" in task.scope
      ) {
        return task.scope.name;
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) {
        return folder.name;
      }
    }
    return task.source;
  }

  private static buildTaskNodes(
    tasks: vscode.Task[],
    parent: TaskTreeItem,
    basePath: string,
    favoriteTaskIds: Set<string>,
    separator: string,
    inputCache: InputCache,
  ): void {
    if (!separator) {
      for (const task of tasks) {
        const taskPath = `${basePath}/${task.name}`;
        const inputIds = extractInputIds(task);
        const hasInputs = inputIds.length > 0;
        new TaskTreeItem(task, TaskTreeItemType.task, taskPath, parent, {
          isFavorite: favoriteTaskIds.has(taskPath),
          hasInputs,
          description: hasInputs
            ? formatInputsSummary(inputIds, inputCache.getAll(taskPath))
            : undefined,
        });
      }
      return;
    }

    TaskTreeDataProvider.appendGroupedNodes(
      tasks,
      parent,
      basePath,
      favoriteTaskIds,
      separator,
      0,
      inputCache,
    );
  }

  private static appendGroupedNodes(
    tasks: vscode.Task[],
    parent: TaskTreeItem,
    basePath: string,
    favoriteTaskIds: Set<string>,
    separator: string,
    depth: number,
    inputCache: InputCache,
  ): void {
    const byPrefix = new Map<string, vscode.Task[]>();
    const directLeaves: vscode.Task[] = [];

    for (const task of tasks) {
      const tokens = TaskTreeItem.getTaskLabel(task).split(separator);
      if (depth >= tokens.length - 1) {
        directLeaves.push(task);
      } else {
        const key = tokens[depth] ?? "";
        let arr = byPrefix.get(key);
        if (!arr) {
          arr = [];
          byPrefix.set(key, arr);
        }
        arr.push(task);
      }
    }

    for (const task of directLeaves) {
      TaskTreeDataProvider.createTaskLeaf(
        task,
        parent,
        basePath,
        favoriteTaskIds,
        separator,
        depth,
        inputCache,
      );
    }

    for (const [prefix, groupTasks] of byPrefix) {
      if (groupTasks.length === 1) {
        TaskTreeDataProvider.createTaskLeaf(
          groupTasks[0]!,
          parent,
          basePath,
          favoriteTaskIds,
          separator,
          depth,
          inputCache,
        );
      } else {
        const groupPath = `${basePath}/__group__/${depth}/${prefix}`;
        const groupItem = new TaskTreeItem(
          prefix,
          TaskTreeItemType.folder,
          groupPath,
          parent,
        );
        TaskTreeDataProvider.appendGroupedNodes(
          groupTasks,
          groupItem,
          basePath,
          favoriteTaskIds,
          separator,
          depth + 1,
          inputCache,
        );
      }
    }
  }

  private static createTaskLeaf(
    task: vscode.Task,
    parent: TaskTreeItem,
    basePath: string,
    favoriteTaskIds: Set<string>,
    separator: string,
    depth: number,
    inputCache: InputCache,
  ): void {
    const taskPath = `${basePath}/${task.name}`;
    const tokens = TaskTreeItem.getTaskLabel(task).split(separator);
    const leafLabel = tokens.slice(depth).join(separator);
    const inputIds = extractInputIds(task);
    const hasInputs = inputIds.length > 0;
    new TaskTreeItem(task, TaskTreeItemType.task, taskPath, parent, {
      isFavorite: favoriteTaskIds.has(taskPath),
      displayLabel: leafLabel || task.name,
      hasInputs,
      description: hasInputs
        ? formatInputsSummary(inputIds, inputCache.getAll(taskPath))
        : undefined,
    });
  }

  private static getTaskSortOrder(): TaskSortOrder {
    const taskSortOrder = vscode.workspace
      .getConfiguration(firmwareTaskName)
      .get(taskSortOrderConfigKey);

    return taskSortOrder === "group" || taskSortOrder === "provider"
      ? taskSortOrder
      : "label";
  }

  private static compareTaskGroups(
    x: vscode.Task | undefined,
    y: vscode.Task | undefined,
  ): number {
    const xGroup = x?.group;
    const yGroup = y?.group;
    if (!xGroup && !yGroup) {
      return 0;
    }

    if (!xGroup) {
      return 1;
    }

    if (!yGroup) {
      return -1;
    }

    return (
      TaskTreeDataProvider.getTaskGroupRank(xGroup) -
        TaskTreeDataProvider.getTaskGroupRank(yGroup) ||
      compareStrings(xGroup.id, yGroup.id)
    );
  }

  private static getTaskGroupRank(group: vscode.TaskGroup): number {
    return taskGroupOrder.get(group.id) ?? taskGroupOrder.size;
  }

  private static getTreeItemLabel(item: vscode.TreeItem): string {
    return typeof item.label === "string"
      ? item.label
      : (item.label?.label ?? "");
  }

  private static getTreeItemDescription(item: vscode.TreeItem): string {
    return typeof item.description === "string" ? item.description : "";
  }

  private static getTreeItemTooltip(item: vscode.TreeItem): string {
    return typeof item.tooltip === "string" ? item.tooltip : "";
  }

  private static getFavoriteTaskIds(): string[] {
    const favoriteTaskIds = vscode.workspace
      .getConfiguration(firmwareTaskName)
      .get(favoritesConfigKey, []);

    return Array.isArray(favoriteTaskIds)
      ? favoriteTaskIds.filter(
          (favoriteTaskId) => typeof favoriteTaskId === "string",
        )
      : [];
  }

  private static getTaskPath(task: vscode.Task): string {
    return TaskTreeDataProvider.getTaskPathParts(task).join("/");
  }

  private static getTaskOriginsByLabel(
    tasks: vscode.Task[],
    omitRootScope: boolean,
  ): Map<string, string[][]> {
    const taskOriginsByLabel = new Map<string, string[][]>();
    for (const task of tasks) {
      const label = TaskTreeItem.getTaskLabel(task);
      const origins = getOrAdd(taskOriginsByLabel, label, () => []);
      origins.push(
        TaskTreeDataProvider.getTaskOriginParts(task, omitRootScope),
      );
    }

    return taskOriginsByLabel;
  }

  private static getShortestTaskOrigin(
    task: vscode.Task,
    taskOriginsByLabel: Map<string, string[][]>,
    omitRootScope: boolean,
  ): string {
    const taskOriginParts = TaskTreeDataProvider.getTaskOriginParts(
      task,
      omitRootScope,
    );
    const sameLabelOrigins =
      taskOriginsByLabel.get(TaskTreeItem.getTaskLabel(task)) ?? [];

    for (let length = 1; length < taskOriginParts.length; length++) {
      const taskOriginPrefix = TaskTreeDataProvider.getTaskOriginPrefix(
        taskOriginParts,
        length,
      );
      const matchingOriginCount = sameLabelOrigins.filter(
        (originParts) =>
          TaskTreeDataProvider.getTaskOriginPrefix(originParts, length) ===
          taskOriginPrefix,
      ).length;

      if (matchingOriginCount === 1) {
        return TaskTreeDataProvider.getTaskOriginPrefix(
          taskOriginParts,
          length,
        );
      }
    }

    return TaskTreeDataProvider.getTaskOriginPrefix(
      taskOriginParts,
      taskOriginParts.length,
    );
  }

  private static getTaskDisplayPath(
    task: vscode.Task,
    omitRootScope: boolean,
  ): string {
    return [
      ...TaskTreeDataProvider.getTaskOriginParts(task, omitRootScope),
      TaskTreeItem.getTaskLabel(task),
    ].join("/");
  }

  private static getTaskOriginParts(
    task: vscode.Task,
    omitRootScope: boolean,
  ): string[] {
    const originParts = TaskTreeDataProvider.getTaskPathParts(task).slice(
      0,
      -1,
    );
    return omitRootScope ? originParts.slice(1) : originParts;
  }

  private static getTaskOriginPrefix(
    taskOriginParts: string[],
    length: number,
  ): string {
    return taskOriginParts.slice(0, length).join(" / ");
  }

  private static getTaskPathParts(task: vscode.Task): string[] {
    const scope = task.scope ?? vscode.TaskScope.Global;
    const pathParts = [TaskScope.getScopeName(scope)];
    const folderPath = task.definition["path"] as string | undefined;
    if (folderPath) {
      pathParts.push(folderPath);
    }

    pathParts.push(task.source, task.name);
    return pathParts;
  }

  private static hasSingleTaskScope(tasks: vscode.Task[]): boolean {
    const scopeNames = new Set(
      tasks.map((task) =>
        TaskScope.getScopeName(task.scope ?? vscode.TaskScope.Global),
      ),
    );

    return scopeNames.size === 1;
  }

  private static async updateFavoriteTaskIds(
    update: (favoriteTaskIds: Set<string>) => void,
  ): Promise<void> {
    const favoriteTaskIds = new Set(TaskTreeDataProvider.getFavoriteTaskIds());
    update(favoriteTaskIds);
    await vscode.workspace
      .getConfiguration(firmwareTaskName)
      .update(
        favoritesConfigKey,
        Array.from(favoriteTaskIds).sort(),
        vscode.ConfigurationTarget.Workspace,
      );
  }

  private static shouldCollapseRootItems(
    rootItems: TaskTreeItem[],
    taskCount: number,
  ): boolean {
    const collapseLargeTaskTree = vscode.workspace
      .getConfiguration(firmwareTaskName)
      .get(collapseLargeTaskTreeConfigKey) as boolean;

    return collapseLargeTaskTree && rootItems.length > 3 && taskCount > 30;
  }

  private static compareTreeItems(
    x: TaskTreeItem,
    y: TaskTreeItem,
    taskSortOrder: TaskSortOrder,
  ): number {
    if (x.type === TaskTreeItemType.task && y.type === TaskTreeItemType.task) {
      if (taskSortOrder === "provider") {
        return 0;
      }

      if (taskSortOrder === "group") {
        return (
          TaskTreeDataProvider.compareTaskGroups(x.task, y.task) ||
          TaskTreeItem.compare(x, y)
        );
      }
    }

    return TaskTreeItem.compare(x, y);
  }

  private static sortTree(
    tree: TaskTreeItem[],
    taskSortOrder: TaskSortOrder,
  ): void {
    tree.sort((x, y) =>
      TaskTreeDataProvider.compareTreeItems(x, y, taskSortOrder),
    );
    for (const item of tree) {
      if (item.children.length > 0) {
        this.sortTree(item.children, taskSortOrder);
      }
    }
  }

  private static getTreeSignature(items: TaskTreeItem[]): string {
    return JSON.stringify(items.map((item) => this.getItemSignature(item)));
  }

  private static getItemSignature(item: TaskTreeItem): object {
    return {
      type: item.type,
      path: item.path,
      label: TaskTreeDataProvider.getTreeItemLabel(item),
      description: TaskTreeDataProvider.getTreeItemDescription(item),
      tooltip: TaskTreeDataProvider.getTreeItemTooltip(item),
      contextValue: item.contextValue,
      collapsibleState: item.collapsibleState,
      children: item.children.map((child) => this.getItemSignature(child)),
    };
  }

  private async getTree(): Promise<TaskTreeItem[]> {
    if (!this._tree) {
      this._tree = await TaskTreeDataProvider.generateTree(this.inputCache);
      this._treeSignature = TaskTreeDataProvider.getTreeSignature(this._tree);
    }

    return this._tree;
  }

  public triggerFullRefresh = (): void => {
    void this.refresh();
    this.refreshAfterTaskDiscovery();
  };

  private refreshAfterTaskDiscovery(): void {
    for (const delay of taskDiscoveryRefreshDelays) {
      setTimeout(this.refresh, delay);
    }
  }

  private setupWatchers(
    added?: readonly vscode.WorkspaceFolder[],
    removed?: readonly vscode.WorkspaceFolder[],
  ) {
    if (!added && !removed) {
      added = vscode.workspace.workspaceFolders;
    }

    if (added) {
      for (const workspaceFolder of added) {
        const tasksJsonWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workspaceFolder, "**/.vscode/tasks.json"),
        );
        tasksJsonWatcher.onDidChange(this.triggerFullRefresh);
        tasksJsonWatcher.onDidCreate(this.triggerFullRefresh);
        tasksJsonWatcher.onDidDelete(this.triggerFullRefresh);
        const otherWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workspaceFolder, "*.*"),
        );
        otherWatcher.onDidChange(this.refresh);
        otherWatcher.onDidCreate(this.refresh);
        otherWatcher.onDidDelete(this.refresh);
        this._watchers[workspaceFolder.uri.toString(true)] = [
          tasksJsonWatcher,
          otherWatcher,
        ];
      }
    }

    if (removed) {
      for (const workspaceFolder of removed) {
        invalidateWorkspaceTaskSourceFileCache(workspaceFolder.uri);
        const key = workspaceFolder.uri.toString(true);
        const watchers = this._watchers[key];
        if (watchers) {
          watchers.forEach((watcher) => watcher.dispose());
          delete this._watchers[key];
        }
      }
    }
  }
}
