import { Logger } from "../core/logger";

export interface VulkanDevice {
	/** Spec consumed by FFmpeg's -init_hw_device vulkan=gpu:N (N is the device index). */
	id: string;
	/** Index from the `GPU<N>:` line in vulkaninfo output. */
	deviceIndex: number;
	deviceName: string;
	/** PHYSICAL_DEVICE_TYPE_DISCRETE_GPU / INTEGRATED_GPU / CPU / etc. */
	deviceType: string;
	/** e.g. "radv", "anv", "nvidia", "amdvlk". */
	driverName: string;
	apiVersion: string;
}

/**
 * Enumerate Vulkan devices via `vulkaninfo --summary`.
 *
 * Expected output (snippet):
 *   Devices:
 *   ========
 *   GPU0:
 *           apiVersion         = 1.3.296
 *           deviceName         = AMD Radeon RX 6500 XT
 *           deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
 *           driverName         = radv
 *   GPU1:
 *           apiVersion         = 1.3.296
 *           deviceName         = AMD Radeon 780M Graphics
 *           ...
 *
 * Returns an empty array on any failure - callers should treat that as
 * "no Vulkan acceleration possible".
 */
export async function listVulkanDevices(): Promise<VulkanDevice[]> {
	try {
		const proc = Bun.spawn(["vulkaninfo", "--summary"], { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) {
			Logger.warn(`[vulkan] vulkaninfo --summary exited with code ${code}`);
			return [];
		}

		const devices: VulkanDevice[] = [];
		let inDevices = false;
		let current: { idx: number; fields: Record<string, string> } | null = null;

		const flush = () => {
			if (!current) return;
			const f = current.fields;
			devices.push({
				id: String(current.idx),
				deviceIndex: current.idx,
				deviceName: f.deviceName ?? `GPU ${current.idx}`,
				deviceType: f.deviceType ?? "",
				driverName: f.driverName ?? "",
				apiVersion: f.apiVersion ?? "",
			});
			current = null;
		};

		for (const rawLine of stdout.split("\n")) {
			const trimmed = rawLine.replace(/\r$/, "").trim();

			if (/^Devices:\s*$/i.test(trimmed)) {
				inDevices = true;
				continue;
			}
			if (!inDevices) continue;

			const gpuMatch = trimmed.match(/^GPU(\d+):\s*$/);
			if (gpuMatch) {
				flush();
				current = { idx: parseInt(gpuMatch[1]!, 10), fields: {} };
				continue;
			}

			if (current) {
				const kv = trimmed.match(/^(\w+)\s*=\s*(.+?)\s*$/);
				if (kv) {
					current.fields[kv[1]!] = kv[2]!;
				}
			}
		}
		flush();

		// Filter out CPU "devices" - we never want to fall back to llvmpipe for nlmeans.
		return devices.filter((d) => !/CPU/i.test(d.deviceType));
	} catch (err) {
		Logger.warn(`[vulkan] Failed to enumerate devices: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

export function isValidVulkanDeviceSpec(spec: string): boolean {
	return /^\d+$/.test(spec);
}
