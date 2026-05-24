# Firmware Task Manager

A VSCode extension that runs tasks defined in `.vscode/tasks.json` with
interactive parameter prompts — serial port pickers, file dialogs, and
validated text input — tailored for firmware development workflows.

## Features

- Activity bar view that lists tasks defined in the workspace (`.vscode/tasks.json`)
- Run / terminate / restart tasks directly from the tree
- Favorite frequently used tasks
- **Interactive input commands** usable from the standard `inputs` array of
  `tasks.json`:
  - Auto-detected serial port picker (`pickSerialPort`)
  - Validated text prompt (`promptInput`)
  - File / folder pickers (`pickFile`, `pickFolder`)
  - Dynamic list picker (`pickFromList`)
- **Pre-configure inputs without running**: a gear icon ⚙️ next to tasks with
  `${input:...}` variables opens the input UI without launching the task; the
  selected values are stored and reused on the next ▶ run (no re-prompt).
  Current values appear as a description next to the task name
  (e.g. `flash  port=/dev/cu.usbserial · cfg=debug`).
- Remembers the last value entered per task and prefills it on the next run

## Input commands

Use these commands as `"type": "command"` inputs in your `tasks.json`.

| Command | Purpose | Args |
|---|---|---|
| `firmware-task.pickSerialPort` | Auto-detects and lets the user pick a serial port. Falls back to manual entry if none detected. | `placeholder`, `filter` (regex) |
| `firmware-task.promptInput` | Free-form text prompt. | `prompt`, `placeholder`, `value`, `password`, `validateRegex`, `validateMessage` |
| `firmware-task.pickFile` | File picker (`showOpenDialog`). | `title`, `openLabel`, `filters`, `defaultUri`, `canSelectMany`, `relative` |
| `firmware-task.pickFolder` | Folder picker. | `title`, `openLabel`, `defaultUri`, `relative` |
| `firmware-task.pickFromList` | QuickPick over a custom list. | `items` (string[] or {label,value,description}[]), `placeholder` |

### Example `tasks.json`

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Serial Monitor",
      "type": "shell",
      "command": "pyserial-miniterm ${input:port} ${input:baud}"
    },
    {
      "label": "Flash Firmware",
      "type": "shell",
      "command": "openocd -f interface/stlink.cfg -c 'program ${input:bin} verify reset exit'"
    }
  ],
  "inputs": [
    { "id": "port", "type": "command", "command": "firmware-task.pickSerialPort" },
    {
      "id": "baud",
      "type": "command",
      "command": "firmware-task.promptInput",
      "args": { "prompt": "Baud rate", "value": "115200", "validateRegex": "^\\d+$" }
    },
    {
      "id": "bin",
      "type": "command",
      "command": "firmware-task.pickFile",
      "args": { "filters": { "Firmware": ["bin", "hex", "elf"] } }
    }
  ]
}
```

Variables (`${input:port}`, etc.) are substituted by Firmware Task Manager when
you launch the task from its tree view. Standard VSCode `promptString` and
`pickString` input types are also supported.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `firmwareTask.showOnlyWorkspaceTasks` | `true` | Show only tasks defined in `.vscode/tasks.json`. Set to `false` to also show auto-detected tasks (CMake, npm, tsc, etc.). |
| `firmwareTask.rememberInputs` | `true` | Remember last entered input values per task and prefill on subsequent runs. |
| `firmwareTask.serialPortFilter` | `""` | Regex applied to detected serial port device names. |
| `firmwareTask.exclude` | `null` | Regex pattern for excluding tasks by name. |
| `firmwareTask.collapseLargeTaskTree` | `true` | Collapse top-level groups when there are more than three groups and more than 30 tasks. |
| `firmwareTask.taskSortOrder` | `"label"` | Sort order: `"label"`, `"group"`, or `"provider"`. |
| `firmwareTask.favorites` | `[]` | Saved favorite task ids (workspace settings). |

## Installation (local VSIX)

```bash
pnpm install
pnpm run vsix
# → dist-vsix/firmware-task-manager-1.0.0.vsix
```

Install it in VSCode via **Extensions: Install from VSIX...** in the command
palette, or from the CLI:

```bash
code --install-extension dist-vsix/firmware-task-manager-1.0.0.vsix
```

## Development

```bash
pnpm install
pnpm run watch       # rolldown + tsc in watch mode
# Press F5 in VSCode to launch the Extension Development Host
```

## License

MIT
