import { Logger } from "./logger";

export interface OpenClDevice {
	/** Spec consumed by FFmpeg's -init_hw_device opencl=gpu:X.Y */
	id: string;
	platformIndex: number;
	deviceIndex: number;
	platformName: string;
	deviceName: string;
}

/**
 * Enumerate OpenCL devices via `clinfo -l`.
 *
 * Expected output:
 *   Platform #0: rusticl
 *    `-- Device #0: AMD Radeon RX 6500 XT (radeonsi, navi23, ...)
 *    `-- Device #1: AMD Radeon 780M Graphics (radeonsi, phoenix, ...)
 *
 * Returns an empty array on any failure - callers should treat that as
 * "no GPU acceleration possible".
 */
export async function listOpenClDevices(): Promise<OpenClDevice[]> {
	try {
		const proc = Bun.spawn(["clinfo", "-l"], { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) {
			Logger.warn(`[opencl] clinfo -l exited with code ${code}`);
			return [];
		}

		const devices: OpenClDevice[] = [];
		let currentPlatform = -1;
		let currentPlatformName = "";

		for (const rawLine of stdout.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;

			const platformMatch = line.match(/^Platform\s+#(\d+):\s*(.+)$/i);
			if (platformMatch) {
				currentPlatform = parseInt(platformMatch[1]!, 10);
				currentPlatformName = platformMatch[2]!.trim();
				continue;
			}

			const deviceMatch = line.match(/Device\s+#(\d+):\s*(.+)$/i);
			if (deviceMatch && currentPlatform >= 0) {
				const deviceIndex = parseInt(deviceMatch[1]!, 10);
				devices.push({
					id: `${currentPlatform}.${deviceIndex}`,
					platformIndex: currentPlatform,
					deviceIndex,
					platformName: currentPlatformName,
					deviceName: deviceMatch[2]!.trim(),
				});
			}
		}

		return devices;
	} catch (err) {
		Logger.warn(`[opencl] Failed to enumerate devices: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

export function isValidDeviceSpec(spec: string): boolean {
	return /^\d+\.\d+$/.test(spec);
}
