import { readFileSync } from "fs";
import { Logger } from "./logger";

let cachedCpuName: string | null | undefined = undefined;

/**
 * Read CPU model from /proc/cpuinfo. Cached after first read.
 *
 * Matches:
 *   x86:  "model name : AMD Ryzen 7 5800X 8-Core Processor"
 *   ARM:  "Model      : Raspberry Pi 4"  or  "Hardware : ..."
 */
export function getCpuName(): string | null {
	if (cachedCpuName !== undefined) return cachedCpuName;

	try {
		const content = readFileSync("/proc/cpuinfo", "utf8");
		const m = content.match(/^(?:model name|Model|Hardware)\s*:\s*(.+)$/m);
		cachedCpuName = m ? m[1]!.trim() : null;
	} catch (err) {
		Logger.warn(`[system] Failed to read /proc/cpuinfo: ${err instanceof Error ? err.message : String(err)}`);
		cachedCpuName = null;
	}

	return cachedCpuName;
}
