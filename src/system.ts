import { readFileSync, existsSync } from "fs";
import { cpus, loadavg } from "os";
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

export interface MemStats {
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
	usedPercent: number;
}

export interface SwapStats {
	totalBytes: number;
	usedBytes: number;
	usedPercent: number;
}

export interface DiskStats {
	/** The path we measured (the temp dir); disk figures are for its mount. */
	path: string;
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
	usedPercent: number;
}

export interface NetStats {
	rxBytesPerSec: number;
	txBytesPerSec: number;
	rxTotalBytes: number;
	txTotalBytes: number;
}

export interface GpuStats {
	name: string | null;
	vendor: "nvidia" | "amd" | "intel" | null;
	utilizationPercent: number | null;
	memUsedBytes: number | null;
	memTotalBytes: number | null;
}

export interface SystemStats {
	cpuName: string | null;
	/** Aggregate utilization across all cores, 0..100. Null until the first delta is available. */
	cpuUsagePercent: number | null;
	cpuCount: number;
	loadAvg: [number, number, number] | null;
	mem: MemStats | null;
	swap: SwapStats | null;
	/** Usage for the filesystem hosting the temp dir (follows a NAS mount). */
	disk: DiskStats | null;
	net: NetStats | null;
	gpu: GpuStats | null;
	sampledAt: number;
}

interface CpuTimes {
	total: number;
	idle: number;
}

function readCpuTimes(): CpuTimes | null {
	try {
		const stat = readFileSync("/proc/stat", "utf8");
		const line = stat.split("\n", 1)[0] ?? "";
		const parts = line.trim().split(/\s+/);
		if (parts[0] !== "cpu") return null;

		const nums = parts.slice(1).map((n) => parseInt(n, 10) || 0);
		const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
		const total = nums.reduce((a, b) => a + b, 0);
		return { total, idle };
	} catch {
		return null;
	}
}

interface NetTotals {
	rx: number;
	tx: number;
}

function readNetTotals(): NetTotals | null {
	try {
		const content = readFileSync("/proc/net/dev", "utf8");
		let rx = 0;
		let tx = 0;
		let found = false;

		for (const raw of content.split("\n")) {
			const line = raw.trim();
			const idx = line.indexOf(":");
			if (idx === -1) continue;

			const iface = line.slice(0, idx).trim();
			if (iface === "lo" || iface.startsWith("veth")) continue;

			const f = line
				.slice(idx + 1)
				.trim()
				.split(/\s+/)
				.map((n) => parseInt(n, 10) || 0);
			rx += f[0] ?? 0;
			tx += f[8] ?? 0;
			found = true;
		}

		return found ? { rx, tx } : { rx: 0, tx: 0 };
	} catch {
		return null;
	}
}

function readMeminfoBytes(content: string, key: string): number | null {
	const m = content.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
	return m ? parseInt(m[1]!, 10) * 1024 : null;
}

function readMem(): MemStats | null {
	try {
		const content = readFileSync("/proc/meminfo", "utf8");
		const total = readMeminfoBytes(content, "MemTotal");
		const avail = readMeminfoBytes(content, "MemAvailable");
		if (total == null || avail == null) return null;

		const used = Math.max(0, total - avail);
		return {
			totalBytes: total,
			usedBytes: used,
			availableBytes: avail,
			usedPercent: total > 0 ? (used / total) * 100 : 0,
		};
	} catch {
		return null;
	}
}

function readSwap(): SwapStats | null {
	try {
		const content = readFileSync("/proc/meminfo", "utf8");
		const total = readMeminfoBytes(content, "SwapTotal");
		const free = readMeminfoBytes(content, "SwapFree");
		if (total == null || free == null) return null;

		const used = Math.max(0, total - free);
		return {
			totalBytes: total,
			usedBytes: used,
			usedPercent: total > 0 ? (used / total) * 100 : 0,
		};
	} catch {
		return null;
	}
}

async function readDisk(path: string): Promise<DiskStats | null> {
	try {
		const proc = Bun.spawn(["df", "-P", "-B1", path], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;

		const lines = out.trim().split("\n");
		const data = lines[lines.length - 1] ?? "";

		const t = data.split(/\s+/);
		const total = parseInt(t[1] ?? "", 10);
		const used = parseInt(t[2] ?? "", 10);
		const avail = parseInt(t[3] ?? "", 10);
		if (!Number.isFinite(total) || !Number.isFinite(used) || !Number.isFinite(avail)) return null;

		return {
			path,
			totalBytes: total,
			usedBytes: used,
			availableBytes: avail,
			usedPercent: total > 0 ? (used / total) * 100 : 0,
		};
	} catch (err) {
		Logger.warn(`[system] df failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

function numOrNull(s: string | undefined): number | null {
	if (s == null) return null;
	const v = parseFloat(s);
	return Number.isFinite(v) ? v : null;
}

function mibToBytes(s: string | undefined): number | null {
	const v = numOrNull(s);
	return v == null ? null : Math.round(v * 1024 * 1024);
}

async function readNvidiaGpu(): Promise<GpuStats | null> {
	try {
		const proc = Bun.spawn(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;

		const first = out.trim().split("\n")[0];
		if (!first) return null;

		const [name, util, memUsed, memTotal] = first.split(",").map((s) => s.trim());
		return {
			name: name || "NVIDIA GPU",
			vendor: "nvidia",
			utilizationPercent: numOrNull(util),
			memUsedBytes: mibToBytes(memUsed),
			memTotalBytes: mibToBytes(memTotal),
		};
	} catch {
		return null;
	}
}

function readIntFile(path: string): number | null {
	try {
		const v = parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isFinite(v) ? v : null;
	} catch {
		return null;
	}
}

function readVendor(base: string): GpuStats["vendor"] {
	const id = (() => {
		try {
			return readFileSync(`${base}/vendor`, "utf8").trim().toLowerCase();
		} catch {
			return "";
		}
	})();
	if (id === "0x1002") return "amd";
	if (id === "0x8086") return "intel";
	if (id === "0x10de") return "nvidia";
	return null;
}

/**
 * AMD (and recent Intel discrete) GPUs expose live busy% via amdgpu/i915 sysfs.
 * No extra tools required (works whenever /dev/dri is mounted)
 */
function readSysfsGpu(): GpuStats | null {
	for (let i = 0; i < 8; i++) {
		const base = `/sys/class/drm/card${i}/device`;
		const busyPath = `${base}/gpu_busy_percent`;
		if (!existsSync(busyPath)) continue;

		const util = readIntFile(busyPath);
		const vendor = readVendor(base);
		return {
			name: vendor === "amd" ? "AMD GPU" : vendor === "intel" ? "Intel GPU" : "GPU",
			vendor,
			utilizationPercent: util,
			memUsedBytes: readIntFile(`${base}/mem_info_vram_used`),
			memTotalBytes: readIntFile(`${base}/mem_info_vram_total`),
		};
	}
	return null;
}

async function readGpu(): Promise<GpuStats | null> {
	const nv = await readNvidiaGpu();
	if (nv) return nv;
	return readSysfsGpu();
}

// Sampler

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let prevCpu: CpuTimes | null = null;
let prevNet: NetTotals | null = null;
let prevAt = 0;

let cache: { stats: SystemStats; at: number } | null = null;
const CACHE_MS = 600;

/**
 * Snapshot current resource usage. CPU% and network throughput are deltas
 * computed against the previous call, so they reflect activity since the last
 * poll. Results are briefly cached so several near-simultaneous requests (or
 * multiple dashboard tabs) don't thrash /proc, df, or nvidia-smi.
 */
export async function getSystemStats(tempDir: string): Promise<SystemStats> {
	const now = Date.now();
	if (cache && now - cache.at < CACHE_MS) return cache.stats;

	let cpuTimes = readCpuTimes();
	let netTotals = readNetTotals();

	// Very first sample: take a short second reading so the first response
	// already carries a real CPU% and throughput instead of nulls/zeros.
	if ((prevCpu === null || prevNet === null) && (cpuTimes || netTotals)) {
		prevCpu = cpuTimes;
		prevNet = netTotals;
		prevAt = now;
		await sleep(250);
		cpuTimes = readCpuTimes() ?? cpuTimes;
		netTotals = readNetTotals() ?? netTotals;
	}

	const elapsedSec = prevAt > 0 ? Math.max(0.001, (Date.now() - prevAt) / 1000) : 0;

	let cpuUsagePercent: number | null = null;
	if (cpuTimes && prevCpu) {
		const dTotal = cpuTimes.total - prevCpu.total;
		const dIdle = cpuTimes.idle - prevCpu.idle;
		if (dTotal > 0) cpuUsagePercent = clamp(100 * (1 - dIdle / dTotal), 0, 100);
	}

	let net: NetStats | null = null;
	if (netTotals && prevNet && elapsedSec > 0) {
		net = {
			rxBytesPerSec: Math.max(0, (netTotals.rx - prevNet.rx) / elapsedSec),
			txBytesPerSec: Math.max(0, (netTotals.tx - prevNet.tx) / elapsedSec),
			rxTotalBytes: netTotals.rx,
			txTotalBytes: netTotals.tx,
		};
	} else if (netTotals) {
		net = { rxBytesPerSec: 0, txBytesPerSec: 0, rxTotalBytes: netTotals.rx, txTotalBytes: netTotals.tx };
	}

	// Stash this reading as the baseline for the next delta.
	if (cpuTimes) prevCpu = cpuTimes;
	if (netTotals) prevNet = netTotals;
	prevAt = Date.now();

	const [disk, gpu] = await Promise.all([readDisk(tempDir), readGpu()]);

	const stats: SystemStats = {
		cpuName: getCpuName(),
		cpuUsagePercent,
		cpuCount: cpus().length,
		loadAvg: loadavg() as [number, number, number],
		mem: readMem(),
		swap: readSwap(),
		disk,
		net,
		gpu,
		sampledAt: Date.now(),
	};

	cache = { stats, at: Date.now() };
	return stats;
}
