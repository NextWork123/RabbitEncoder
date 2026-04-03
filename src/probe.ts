import type { AudioStreamInfo, SubtitleStreamInfo, AudioChannelBitrates, ProbeResult } from "./types";

async function exec(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

async function mediainfo(file: string, inform: string): Promise<string> {
	return exec(["mediainfo", `--Inform=${inform}`, file]);
}

export async function probeFile(inputPath: string): Promise<ProbeResult> {
	const filename = inputPath.split("/").pop() || "";

	const streamsRaw = await exec(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=index,width,height", "-of", "csv=p=0", inputPath]);
	const streams = streamsRaw
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [index, w, h] = line.split(",");
			return {
				index: parseInt(index!),
				width: parseInt(w!),
				height: parseInt(h!),
			};
		});
	streams.sort((a, b) => b.width - a.width);
	const best = streams[0] || { index: 0, width: 1920, height: 1080 };

	const durationStr = await exec(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath]);
	const duration = parseFloat(durationStr) || 0;

	const streamFpsRaw = await exec(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", inputPath]);
	const containerFpsStr = await mediainfo(inputPath, "Video;%FrameRate%");
	const containerFpsNum = await mediainfo(inputPath, "Video;%FrameRate_Num%");
	const containerFpsDen = await mediainfo(inputPath, "Video;%FrameRate_Den%");

	const parseFps = (s: string): number => {
		const parts = s.split("/");
		if (parts.length === 2) return parseInt(parts[0]!) / parseInt(parts[1]!);
		return parseFloat(s) || 23.976;
	};

	const videoStreamFps = parseFps(streamFpsRaw);
	const videoDisplayFps = parseFloat(containerFpsStr) || 23.976;
	const videoFrameRate = containerFpsNum && containerFpsDen ? `${containerFpsNum}/${containerFpsDen}` : "24000/1001";
	const isFrameRateMismatch = Math.abs(videoStreamFps - videoDisplayFps) > 0.5;

	const audioInfoJson = await exec([
		"ffprobe",
		"-v",
		"error",
		"-select_streams",
		"a",
		"-show_entries",
		"stream=index,channels,channel_layout,codec_name,bit_rate:stream_tags=language,title",
		"-of",
		"json",
		inputPath,
	]);
	const audioData = JSON.parse(audioInfoJson);
	const audioStreams: AudioStreamInfo[] = (audioData.streams || []).map((s: any) => ({
		index: s.index,
		channels: s.channels || 0,
		channelLayout: s.channel_layout || "",
		language: s.tags?.language || undefined,
		title: s.tags?.title || undefined,
		codec: s.codec_name || undefined,
		bitrate: s.bit_rate ? parseInt(s.bit_rate) : undefined,
	}));

	// Probe subtitle streams
	const subtitleInfoJson = await exec([
		"ffprobe",
		"-v",
		"error",
		"-select_streams",
		"s",
		"-show_entries",
		"stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,default,hearing_impaired",
		"-of",
		"json",
		inputPath,
	]);
	const subtitleData = JSON.parse(subtitleInfoJson);
	const subtitleStreams: SubtitleStreamInfo[] = (subtitleData.streams || []).map((s: any) => ({
		index: s.index,
		codec: s.codec_name || "unknown",
		language: s.tags?.language || undefined,
		title: s.tags?.title || undefined,
		isForced: s.disposition?.forced === 1,
		isDefault: s.disposition?.default === 1,
		isHearingImpaired: s.disposition?.hearing_impaired === 1,
	}));

	const firstAudio = audioStreams[0];
	const audioLayout = firstAudio ? normalizeLayout(firstAudio.channelLayout) : "stereo";
	const audioChannels = firstAudio ? firstAudio.channels : 2;

	// HDR checks
	const hdrFormat = await mediainfo(inputPath, "Video;%HDR_Format%");
	const hasHDR10Plus = /HDR10\+/i.test(hdrFormat);
	const hasDolbyVision = /Dolby Vision/i.test(hdrFormat);

	const transferCharacteristics = await mediainfo(inputPath, "Video;%transfer_characteristics%");
	const colorPrimaries = await mediainfo(inputPath, "Video;%colour_primaries%");
	const matrixCoefficients = await mediainfo(inputPath, "Video;%matrix_coefficients%");
	const colorRange = await mediainfo(inputPath, "Video;%colour_range%");
	const maxCLL = await mediainfo(inputPath, "Video;%MaxCLL%").then((s) => s.split(" ")[0] || "");
	const maxFALL = await mediainfo(inputPath, "Video;%MaxFALL%").then((s) => s.split(" ")[0] || "");
	const masteringDisplay = await mediainfo(inputPath, "Video;%MasteringDisplay_ColorPrimaries%");
	const masteringLuminance = await mediainfo(inputPath, "Video;%MasteringDisplay_Luminance%");

	return {
		filename,
		width: best.width,
		height: best.height,
		duration,
		audioLayout,
		audioChannels,
		audioStreams,
		subtitleStreams,
		isHDR: transferCharacteristics === "PQ",
		hasHDR10Plus,
		hasDolbyVision,
		transferCharacteristics,
		colorPrimaries,
		matrixCoefficients,
		colorRange,
		maxCLL,
		maxFALL,
		masteringDisplay,
		masteringLuminance,
		videoStreamIndex: best.index,
		videoFrameRate,
		videoStreamFps,
		videoDisplayFps,
		isFrameRateMismatch,
	};
}

export function normalizeLayout(layout: string): string {
	const map: Record<string, string> = {
		mono: "mono",
		stereo: "stereo",
		"2.1": "2.1",
		"5.1": "5.1",
		"5.1(side)": "5.1",
		"6.1": "6.1",
		"7.1": "7.1",
		"7.1.4": "7.1.4",
		dolbyatmos: "7.1.4",
	};
	return map[layout] || "stereo";
}

export function getOpusBitrateForLayout(layout: string, bitrates: AudioChannelBitrates): number {
	const key = layout as keyof typeof bitrates;
	return bitrates[key] ?? bitrates.stereo ?? 128;
}

export function getAudioReplacementLabel(layout: string): string {
	const labels: Record<string, string> = {
		mono: "Opus 1.0",
		stereo: "Opus 2.0",
		"2.1": "Opus 2.1",
		"5.1": "Opus 5.1",
		"6.1": "Opus 6.1",
		"7.1": "Opus 7.1",
		"7.1.4": "Opus 7.1.4",
	};
	return labels[layout] || "Opus 2.0";
}
