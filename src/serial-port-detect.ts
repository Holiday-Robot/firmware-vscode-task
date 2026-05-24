import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SerialPortInfo {
  path: string;
  description?: string;
}

const darwinPatterns = [
  /^cu\.usbserial/i,
  /^cu\.usbmodem/i,
  /^cu\.SLAB/i,
  /^cu\.wchusbserial/i,
  /^cu\.Bluetooth/i,
];

const linuxPatterns = [/^ttyUSB\d+$/, /^ttyACM\d+$/, /^ttyAMA\d+$/];

async function listUnix(patterns: RegExp[]): Promise<string[]> {
  try {
    const entries = await fs.readdir("/dev");
    return entries
      .filter((name) => patterns.some((re) => re.test(name)))
      .map((name) => `/dev/${name}`)
      .sort();
  } catch {
    return [];
  }
}

async function listWindows(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/c", "mode"], {
      windowsHide: true,
    });
    const seen = new Set<string>();
    for (const match of stdout.matchAll(/COM\d+/g)) {
      seen.add(match[0]);
    }
    return Array.from(seen).sort((a, b) => {
      const na = Number.parseInt(a.slice(3), 10);
      const nb = Number.parseInt(b.slice(3), 10);
      return na - nb;
    });
  } catch {
    return [];
  }
}

export async function detectSerialPorts(
  filterPattern?: string,
): Promise<SerialPortInfo[]> {
  let paths: string[];
  if (process.platform === "win32") {
    paths = await listWindows();
  } else if (process.platform === "darwin") {
    paths = await listUnix(darwinPatterns);
  } else {
    paths = await listUnix(linuxPatterns);
  }

  if (filterPattern) {
    try {
      const re = new RegExp(filterPattern);
      paths = paths.filter((p) => re.test(p));
    } catch {
      // Invalid regex — ignore filter
    }
  }

  return paths.map((path) => ({ path }));
}
