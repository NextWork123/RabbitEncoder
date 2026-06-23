import type { DenoiseBackend, JobSettings } from "../types";
import type { AdvancedTarget, PipelinePreset, SettingsCodePanelElement } from "../ui/models";
import { decodeSettingsCodeRequest, fetchConfig, fetchOpenClDevices, fetchVulkanDevices, patchConfig, resetConfigRequest } from "../api/client";
import { getCurrentSettings } from "../app/events";
import {
	AUDIO_CODEC_PRIORITY_OPTIONS,
	AUDIO_ENCODE_OPTIONS,
	DEBAND_LEVELS,
	DEFAULT_AUTO_THRESHOLDS,
	DEFAULT_GRADFUN_PARAMS,
	DEFAULT_NLMEANS_PARAMS,
	DENOISE_BACKENDS,
	DENOISE_LEVELS,
	PIPELINE_PRESETS,
	PIPELINE_PRESET_HELP,
	QUALITIES,
	SPEEDS,
	SUBTITLE_FANSUB_TIEBREAK_OPTIONS,
	SUBTITLE_FORMAT_PRIORITY_OPTIONS,
	SUBTITLE_PROCESSING_OPTIONS,
	SUBTITLE_SOURCE_PRIORITY_OPTIONS,
	VIDEO_ENCODE_OPTIONS,
} from "../config/options";
import {
	mountSettingsCodePanel,
	renderAudioLanguagesInput,
	renderAutoThresholds,
	renderBitrateInputs,
	renderDedupeSubtitlesToggle,
	renderDownscaleToggle,
	renderGpuDevicePicker,
	renderGradfunParamsEditor,
	renderKeepBestAudioChannelsToggle,
	renderLanguageFilterInput,
	renderNlmeansParamsEditor,
	renderNoPhaseInvToggle,
	renderRadioPills,
	renderRemoveCommentaryAudioToggle,
	renderSkipBoostingToggle,
	wireEncoderControls,
	renderSubtitleLangDetectControl,
	renderSubtitleConfidenceControl,
	renderDetectSignsSongsToggle,
	renderDetectSDHToggle,
	renderDetectHonorificsToggle,
	renderNumberControl,
	renderLabeledToggle,
	renderLanguagePriorityInput,
} from "./settings-controls";
import { renderVsChainEditor } from "./vapoursynth";
import { byId } from "../shared/dom";
import { appState } from "../state";

export function inferPreset(settings: JobSettings): PipelinePreset {
	const v = settings.videoEncode ?? "av1";
	const a = settings.audioEncode ?? "opus";
	const s = settings.subtitleProcessing ?? "full";
	if (v === "av1" && a === "opus" && s === "full") return "full";
	if (v === "off" && a === "copy" && s === "copy") return "prepare";
	return "custom";
}

export function applyPresetToSettings(settings: JobSettings, preset: PipelinePreset): void {
	if (preset === "full") {
		settings.videoEncode = "av1";
		settings.audioEncode = "opus";
		settings.subtitleProcessing = "full";
	} else if (preset === "prepare") {
		settings.videoEncode = "off";
		settings.audioEncode = "copy";
		settings.subtitleProcessing = "copy";
	}
}

export async function openSettings() {
	if (!appState.defaults) appState.defaults = await fetchConfig();

	const base = window._tempDefaults ?? appState.defaults;

	const tempDefaults = {
		...base,
		audioBitrates: { ...base.audioBitrates },
		// Deep-clone nested objects so cancel actually cancels.
		autoDenoiseThresholds: { ...(base.autoDenoiseThresholds || DEFAULT_AUTO_THRESHOLDS) },
		nlmeansParams: base.nlmeansParams ? JSON.parse(JSON.stringify(base.nlmeansParams)) : JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS)),
		gradfunParams: base.gradfunParams ? JSON.parse(JSON.stringify(base.gradfunParams)) : JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS)),
		vsFilters: Array.isArray(base.vsFilters) ? JSON.parse(JSON.stringify(base.vsFilters)) : [],
	};
	window._tempDefaults = tempDefaults;

	renderRadioPills(byId("default-quality"), QUALITIES, tempDefaults.quality, (v) => (tempDefaults.quality = v));
	renderRadioPills(byId("default-speed"), SPEEDS, tempDefaults.finalSpeed, (v) => (tempDefaults.finalSpeed = v));

	wireEncoderControls("default", tempDefaults);

	renderRadioPills(byId("default-denoise"), DENOISE_LEVELS, tempDefaults.denoise || "off", (v) => (tempDefaults.denoise = v));
	renderRadioPills(byId("default-deband"), DEBAND_LEVELS, tempDefaults.deband || "off", (v) => (tempDefaults.deband = v));

	const presetValue = inferPreset(tempDefaults);

	renderRadioPills(byId("default-pipeline-mode"), PIPELINE_PRESETS, presetValue, (v) => {
		applyPresetToSettings(tempDefaults, v);
		byId("default-pipeline-custom").style.display = v === "custom" ? "" : "none";
		byId("default-pipeline-mode-help").textContent = PIPELINE_PRESET_HELP[v] ?? "";
	});

	byId("default-pipeline-custom").style.display = presetValue === "custom" ? "" : "none";
	byId("default-pipeline-mode-help").textContent = PIPELINE_PRESET_HELP[presetValue] ?? "";

	renderRadioPills(byId("default-video-encode"), VIDEO_ENCODE_OPTIONS, tempDefaults.videoEncode ?? "av1", (v) => (tempDefaults.videoEncode = v));
	renderRadioPills(byId("default-audio-encode"), AUDIO_ENCODE_OPTIONS, tempDefaults.audioEncode ?? "opus", (v) => (tempDefaults.audioEncode = v));
	renderRadioPills(
		byId("default-subtitle-processing"),
		SUBTITLE_PROCESSING_OPTIONS,
		tempDefaults.subtitleProcessing ?? "full",
		(v) => (tempDefaults.subtitleProcessing = v),
	);

	renderDownscaleToggle(byId("default-downscale"), tempDefaults.downscale || false, (v) => (tempDefaults.downscale = v));
	renderSkipBoostingToggle(byId("default-skip-boosting"), tempDefaults.skipBoosting || false, (v) => (tempDefaults.skipBoosting = v));
	renderNoPhaseInvToggle(byId("default-no-phase-inv"), tempDefaults.noPhaseInv || false, (v) => (tempDefaults.noPhaseInv = v));
	renderDedupeSubtitlesToggle(byId("default-dedupe-subtitles"), tempDefaults.dedupeSubtitles || false, (v) => (tempDefaults.dedupeSubtitles = v));
	renderSubtitleLangDetectControl(byId("default-sub-lang-detect"), tempDefaults.subtitleLangDetect ?? "enabled", (v) => (tempDefaults.subtitleLangDetect = v));
	renderSubtitleConfidenceControl(
		byId("default-sub-lang-confidence"),
		tempDefaults.subtitleLangDetectConfidence ?? 0.05,
		(v) => (tempDefaults.subtitleLangDetectConfidence = v),
	);
	renderDetectSignsSongsToggle(byId("default-detect-signs-songs"), tempDefaults.detectSignsSongs ?? true, (v) => (tempDefaults.detectSignsSongs = v));
	renderDetectSDHToggle(byId("default-detect-sdh"), tempDefaults.detectSDH ?? true, (v) => (tempDefaults.detectSDH = v));
	renderDetectHonorificsToggle(byId("default-detect-honorifics"), tempDefaults.detectHonorifics ?? true, (v) => (tempDefaults.detectHonorifics = v));
	renderRadioPills(
		byId("default-sub-source-priority"),
		SUBTITLE_SOURCE_PRIORITY_OPTIONS,
		tempDefaults.subtitleSourcePriority ?? "official-first",
		(v) => (tempDefaults.subtitleSourcePriority = v),
	);
	renderRadioPills(
		byId("default-sub-fansub-tiebreak"),
		SUBTITLE_FANSUB_TIEBREAK_OPTIONS,
		tempDefaults.subtitleFansubTiebreak ?? "alphabetical",
		(v) => (tempDefaults.subtitleFansubTiebreak = v),
	);
	renderRadioPills(
		byId("default-sub-format-priority"),
		SUBTITLE_FORMAT_PRIORITY_OPTIONS,
		tempDefaults.subtitleFormatPriority ?? "text-first",
		(v) => (tempDefaults.subtitleFormatPriority = v),
	);

	renderLabeledToggle(
		byId("default-drop-picture-subtitles"),
		tempDefaults.dropPictureSubtitles ?? false,
		"Drop picture-based (PGS/VOBSUB) tracks",
		(v) => (tempDefaults.dropPictureSubtitles = v),
	);
	renderLabeledToggle(
		byId("default-dedupe-across-format"),
		tempDefaults.dedupeAcrossFormat ?? true,
		"Dedupe across formats (one per language + type)",
		(v) => (tempDefaults.dedupeAcrossFormat = v),
	);
	renderLabeledToggle(
		byId("default-rename-subtitle-tracks"),
		tempDefaults.renameSubtitleTracks ?? true,
		"Rename tracks to clean format",
		(v) => (tempDefaults.renameSubtitleTracks = v),
	);

	renderLabeledToggle(
		byId("default-remove-sdh-subtitles"),
		tempDefaults.removeSDHSubtitles ?? false,
		"Remove SDH",
		(v) => (tempDefaults.removeSDHSubtitles = v),
	);
	renderLabeledToggle(
		byId("default-remove-commentary-subtitles"),
		tempDefaults.removeCommentarySubtitles ?? false,
		"Remove commentary",
		(v) => (tempDefaults.removeCommentarySubtitles = v),
	);
	renderLabeledToggle(
		byId("default-remove-forced-signs-songs"),
		tempDefaults.removeForcedSignsSongs ?? false,
		"Remove forced / Signs & Songs",
		(v) => (tempDefaults.removeForcedSignsSongs = v),
	);
	renderLabeledToggle(
		byId("default-remove-storyboard-subtitles"),
		tempDefaults.removeStoryboardSubtitles ?? false,
		"Remove storyboards",
		(v) => (tempDefaults.removeStoryboardSubtitles = v),
	);
	renderLabeledToggle(
		byId("default-remove-honorifics-subtitles"),
		tempDefaults.removeHonorificsSubtitles ?? false,
		"Remove honorifics",
		(v) => (tempDefaults.removeHonorificsSubtitles = v),
	);

	renderLabeledToggle(
		byId("default-assume-mislabeled"),
		tempDefaults.assumeMislabeledTracks ?? true,
		"Assume mislabeled JP tracks are English",
		(v) => (tempDefaults.assumeMislabeledTracks = v),
	);
	renderNumberControl(
		byId("default-signs-songs-style-ratio"),
		"Signs & Songs ASS-style ratio",
		tempDefaults.signsSongsStyleRatio ?? 0.8,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (tempDefaults.signsSongsStyleRatio = v),
	);
	renderNumberControl(
		byId("default-signs-songs-line-ratio"),
		"Signs & Songs line ratio",
		tempDefaults.signsSongsLineRatio ?? 0.1,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (tempDefaults.signsSongsLineRatio = v),
	);
	renderNumberControl(
		byId("default-sdh-ratio"),
		"SDH marker ratio",
		tempDefaults.sdhRatioThreshold ?? 0.2,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (tempDefaults.sdhRatioThreshold = v),
	);
	renderNumberControl(
		byId("default-sdh-min-lines"),
		"SDH min lines",
		tempDefaults.sdhMinLines ?? 10,
		{ min: 0, max: 10000, step: 1 },
		(v) => (tempDefaults.sdhMinLines = v),
	);
	renderNumberControl(
		byId("default-honorifics-min-count"),
		"Honorifics min count",
		tempDefaults.honorificsMinCount ?? 5,
		{ min: 0, max: 10000, step: 1 },
		(v) => (tempDefaults.honorificsMinCount = v),
	);
	renderNumberControl(
		byId("default-honorifics-ratio"),
		"Honorifics ratio (×)",
		tempDefaults.honorificsRatio ?? 3,
		{ min: 1, max: 100, step: 0.5 },
		(v) => (tempDefaults.honorificsRatio = v),
	);
	renderKeepBestAudioChannelsToggle(
		byId("default-keep-best-audio-channels"),
		tempDefaults.keepBestAudioChannelsOnly || false,
		(v) => (tempDefaults.keepBestAudioChannelsOnly = v),
	);
	renderRemoveCommentaryAudioToggle(
		byId("default-remove-commentary-audio"),
		tempDefaults.removeCommentaryAudio || false,
		(v) => (tempDefaults.removeCommentaryAudio = v),
	);

	// Audio manipulation
	renderLabeledToggle(
		byId("default-remove-descriptive-audio"),
		tempDefaults.removeDescriptiveAudio ?? false,
		"Remove audio description",
		(v) => (tempDefaults.removeDescriptiveAudio = v),
	);
	renderLabeledToggle(
		byId("default-remove-karaoke-audio"),
		tempDefaults.removeKaraokeAudio ?? false,
		"Remove karaoke / off-vocal",
		(v) => (tempDefaults.removeKaraokeAudio = v),
	);
	renderLabeledToggle(
		byId("default-drop-compatibility-audio"),
		tempDefaults.dropCompatibilityAudio ?? true,
		"Drop compatibility downmix tracks",
		(v) => (tempDefaults.dropCompatibilityAudio = v),
	);
	renderLabeledToggle(
		byId("default-prefer-uncensored-audio"),
		tempDefaults.preferUncensoredAudio ?? true,
		"Prefer uncensored tracks",
		(v) => (tempDefaults.preferUncensoredAudio = v),
	);
	renderLabeledToggle(byId("default-dedupe-audio"), tempDefaults.dedupeAudio ?? true, "Deduplicate audio tracks", (v) => (tempDefaults.dedupeAudio = v));
	renderRadioPills(
		byId("default-audio-codec-priority"),
		AUDIO_CODEC_PRIORITY_OPTIONS,
		tempDefaults.audioCodecPriority ?? "lossless-first",
		(v) => (tempDefaults.audioCodecPriority = v),
	);
	renderLabeledToggle(
		byId("default-rename-audio-tracks"),
		tempDefaults.renameAudioTracks ?? false,
		"Rename tracks to clean format",
		(v) => (tempDefaults.renameAudioTracks = v),
	);
	renderLanguagePriorityInput(
		byId("default-audio-lang-priority"),
		tempDefaults.audioLanguagePriority ?? ["jpn", "eng", "*"],
		(v) => (tempDefaults.audioLanguagePriority = v),
	);

	// Audio type detection
	renderLabeledToggle(
		byId("default-detect-commentary-audio"),
		tempDefaults.detectCommentaryAudio ?? true,
		"Detect commentary",
		(v) => (tempDefaults.detectCommentaryAudio = v),
	);
	renderLabeledToggle(
		byId("default-detect-descriptive-audio"),
		tempDefaults.detectDescriptiveAudio ?? true,
		"Detect audio description",
		(v) => (tempDefaults.detectDescriptiveAudio = v),
	);
	renderLabeledToggle(
		byId("default-detect-karaoke-audio"),
		tempDefaults.detectKaraokeAudio ?? true,
		"Detect karaoke",
		(v) => (tempDefaults.detectKaraokeAudio = v),
	);

	// Subtitle additions
	renderLanguagePriorityInput(
		byId("default-subtitle-lang-priority"),
		tempDefaults.subtitleLanguagePriority ?? ["eng", "jpn", "*"],
		(v) => (tempDefaults.subtitleLanguagePriority = v),
		"eng, jpn, *",
	);

	renderAudioLanguagesInput(byId("default-audio-languages"), tempDefaults.audioLanguages || [], (v) => (tempDefaults.audioLanguages = v));
	renderLanguageFilterInput(byId("default-subtitle-languages"), tempDefaults.subtitleLanguages || [], (v) => (tempDefaults.subtitleLanguages = v));
	renderBitrateInputs(byId("default-bitrates"), tempDefaults.audioBitrates, (ch, val) => (tempDefaults.audioBitrates[ch] = val));

	mountSettingsCodePanel(byId("settings-code-panel-default"), {
		getSettings: () => window._tempDefaults,
		onImport: (code) => decodeSettingsCodeRequest(code),
		onApplied: (settings) => {
			if (window._tempDefaults) Object.assign(window._tempDefaults, settings);
			openSettings();
		},
	});

	byId("settings-modal").style.display = "";
}

export async function saveSettings() {
	if (!window._tempDefaults) return;
	appState.defaults = await patchConfig(window._tempDefaults);
	closeSettings();
}

export async function onResetDefaultsClick() {
	if (!confirm("Reset all settings to appState.defaults? This will discard your customizations.")) return;
	const res = await resetConfigRequest();
	appState.defaults = res;
	closeSettings();
}

export function closeSettings() {
	window._tempDefaults = null;
	const panel = byId<SettingsCodePanelElement>("settings-code-panel-default");
	if (panel._codeTimer) {
		clearInterval(panel._codeTimer);
		panel._codeTimer = null;
	}
	byId("settings-modal").style.display = "none";
}

export function closeSettingsIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeSettings();
}

export async function openAdvancedModal(target: AdvancedTarget): Promise<void> {
	appState.currentAdvancedTarget = target;
	const settings = target === "default" ? window._tempDefaults : window._tempJobSettings;
	if (!settings) return;
	const activeSettings = settings;

	// Seed any missing fields from appState.defaults (covers older queue.json entries
	// that haven't been migrated by the backend yet).
	if (!settings.nlmeansParams) {
		settings.nlmeansParams = JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS));
	}
	if (!settings.gradfunParams) {
		settings.gradfunParams = JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS));
	}
	if (!settings.autoDenoiseThresholds) {
		settings.autoDenoiseThresholds = { ...DEFAULT_AUTO_THRESHOLDS };
	}
	if (!settings.denoiseBackend) settings.denoiseBackend = "auto";
	if (settings.gpuDevice === undefined || settings.gpuDevice === null) {
		settings.gpuDevice = settings.denoiseBackend === "vulkan" ? "0" : "0.0";
	}

	const titleEl = byId("advanced-modal-title");
	titleEl.textContent = target === "default" ? "Advanced Default Settings" : "Advanced Job Settings";

	const backendEl = byId("advanced-denoise-backend");
	const deviceGroupEl = byId("advanced-gpu-device-group");
	const devicePickerEl = byId("advanced-gpu-device");

	async function refreshDevicePicker(backend: DenoiseBackend): Promise<void> {
		if (backend === "cpu") {
			deviceGroupEl.style.display = "none";
			return;
		}
		deviceGroupEl.style.display = "";
		const devices = backend === "vulkan" ? await fetchVulkanDevices() : await fetchOpenClDevices();
		// "auto" probes vulkan first; show vulkan devices for that case.
		renderGpuDevicePicker(devicePickerEl, devices, activeSettings.gpuDevice, (v) => (activeSettings.gpuDevice = v));
	}

	renderRadioPills(backendEl, DENOISE_BACKENDS, settings.denoiseBackend, async (v) => {
		const prev = settings.denoiseBackend;
		settings.denoiseBackend = v;
		// Reset gpuDevice format only when crossing the vulkan/opencl divide.
		if (v === "vulkan" && prev !== "vulkan") settings.gpuDevice = "0";
		else if (v === "opencl" && prev !== "opencl") settings.gpuDevice = "0.0";
		else if (v === "auto" && (prev === "cpu" || !settings.gpuDevice)) settings.gpuDevice = "0";
		await refreshDevicePicker(v);
	});
	await refreshDevicePicker(settings.denoiseBackend);

	const cep = byId<HTMLTextAreaElement>("advanced-custom-encoder-params");
	const s = getCurrentSettings();
	if (s) {
		cep.value = s.customEncoderParams || "";
		cep.oninput = () => {
			s.customEncoderParams = cep.value;
		};
	}

	renderAutoThresholds(byId("advanced-auto-thresholds"), settings.autoDenoiseThresholds, (v) => (settings.autoDenoiseThresholds = v));

	renderNlmeansParamsEditor(byId("advanced-nlmeans-params"), settings.nlmeansParams, (v) => (settings.nlmeansParams = v));

	renderGradfunParamsEditor(byId("advanced-gradfun-params"), settings.gradfunParams, (v) => (settings.gradfunParams = v));

	renderVsChainEditor(byId("advanced-vs-chain"), settings);

	byId("advanced-modal").style.display = "";
}

export function closeAdvancedModal() {
	byId("advanced-modal").style.display = "none";
	appState.currentAdvancedTarget = null;
}

export function closeAdvancedModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeAdvancedModal();
}
