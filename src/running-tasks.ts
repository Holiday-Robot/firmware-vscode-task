import * as vscode from "vscode";

// VSCode 의 vscode.tasks.taskExecutions 는 읽기 전용이고, 터미널을 트래시로 강제 삭제하면
// onDidEndTask 가 발생하지 않아 "좀비" execution 이 목록에 남는 경우가 있다. 그러면 트리/뱃지는
// 계속 실행 중으로 보이고, 정지(terminate)도 이미 죽은 프로세스에 대한 no-op 이 된다.
//
// 이 모듈은 좀비로 판정한 execution 을 dismissed 로 표시해 UI 에서 제외하고, 백그라운드의
// 프로세스 ID 와 열린 터미널을 대조해 터미널이 사라진 execution 을 자동으로 정리한다.

const dismissedExecutions = new Set<vscode.TaskExecution>();
const executionProcessIds = new Map<vscode.TaskExecution, number>();
const changeEmitter = new vscode.EventEmitter<void>();

// dismissed 를 제외한, 실제로 살아있는 것으로 간주하는 execution 의 변화를 알린다.
export const onDidChangeRunningTasks = changeEmitter.event;

export function getActiveExecutions(): vscode.TaskExecution[] {
  return vscode.tasks.taskExecutions.filter(
    (execution) => !dismissedExecutions.has(execution),
  );
}

export function findActiveExecution(
  task: vscode.Task,
): vscode.TaskExecution | undefined {
  return getActiveExecutions().find(
    (execution) =>
      execution.task.name === task.name &&
      execution.task.source === task.source,
  );
}

// 정지/전체정지 시 호출: terminate() 가 좀비라 no-op 이어도 UI 는 즉시 정리되도록 낙관적으로 제외.
// 정상 task 는 곧이어 onDidEndTask 가 와서 bookkeeping 이 청소된다.
export function dismissExecution(execution: vscode.TaskExecution): void {
  if (!dismissedExecutions.has(execution)) {
    dismissedExecutions.add(execution);
    changeEmitter.fire();
  }
}

export function registerRunningTaskTracking(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.tasks.onDidStartTaskProcess((event) => {
      executionProcessIds.set(event.execution, event.processId);
    }),
    vscode.tasks.onDidEndTask((event) => {
      // VSCode 가 taskExecutions 에서 제거했으니 우리 bookkeeping 도 청소한다.
      dismissedExecutions.delete(event.execution);
      executionProcessIds.delete(event.execution);
    }),
    vscode.window.onDidCloseTerminal(() => {
      void reconcileClosedTerminals();
    }),
    changeEmitter,
  );
}

// 열린 터미널의 프로세스 ID 집합과 대조해, 터미널이 사라진 execution 을 좀비로 판정·정리한다.
// 프로세스 ID 를 모르는 execution(예: CustomExecution)은 건너뛴다 — 오판으로 살아있는 task 를
// 제거하지 않기 위한 보수적 처리.
async function reconcileClosedTerminals(): Promise<void> {
  const livePids = new Set<number>();
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (pid !== undefined) {
      livePids.add(pid);
    }
  }

  let changed = false;
  for (const execution of vscode.tasks.taskExecutions) {
    if (dismissedExecutions.has(execution)) {
      continue;
    }
    const pid = executionProcessIds.get(execution);
    if (pid !== undefined && !livePids.has(pid)) {
      dismissedExecutions.add(execution);
      changed = true;
      // 최선 노력: 실제 프로세스가 남아있다면 정리 시도(이미 죽었으면 no-op).
      try {
        execution.terminate();
      } catch {
        // ignore
      }
    }
  }

  if (changed) {
    changeEmitter.fire();
  }
}
