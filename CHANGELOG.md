# Changelog

## [1.1.1] - 2026-05-27

### Added

- New inline action **Copy Command Line** (📋) on each task. Resolves
  `${input:...}` variables (cached or prompted just like ▶ Run) and copies the
  fully substituted command line to the clipboard instead of executing it.

### Changed

- Configure (⚙️) and Run now pre-fill / preselect the previously used value
  for every input type:
  - `pickFile` / `pickFolder` open at the previously chosen path
  - `pickSerialPort` and `pickFromList` move the previous choice to the top
  - `promptInput` pre-fills the input box
  - Native `pickString` also moves the previous choice to the top

## [1.1.0] - 2026-05-24

### Added

- Inline gear icon (⚙️) on tasks that contain `${input:...}` variables.
  Clicking it opens the input UI **without running the task**, letting you
  pre-configure values that will be used by the next ▶ run.
- Task tree items now show currently cached input values as a description
  (e.g. `flash  port=/dev/cu.usbserial · cfg=debug`). Unset values appear as
  `id=?`.

## [1.0.0] - 2026-05-24

Initial release.

- Activity bar view that lists tasks defined in `.vscode/tasks.json`
- Run / terminate / restart / favorite tasks from the tree
- Input commands for use in the `inputs` array of `tasks.json`:
  - `firmware-task.pickSerialPort` — OS-level serial port auto-detection
  - `firmware-task.promptInput` — validated text input
  - `firmware-task.pickFile` / `firmware-task.pickFolder` — file/folder dialogs
  - `firmware-task.pickFromList` — dynamic list picker
- `${input:varName}` variable substitution when running tasks from the tree
- Per-task remembered input values
- `firmwareTask.showOnlyWorkspaceTasks` setting (default `true`) to hide
  auto-detected tasks (CMake, npm, tsc, etc.)
