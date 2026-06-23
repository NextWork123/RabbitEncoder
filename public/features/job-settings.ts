import type { SettingsCodePanelElement } from "../ui/models";
import { decodeSettingsCodeRequest, deleteJob, fetchJobs, patchJob, retryJob } from "../api/client";
import {
	AUDIO_CODEC_PRIORITY_OPTIONS,
	AUDIO_ENCODE_OPTIONS,
	DEBAND_LEVELS,
	DEFAULT_AUTO_THRESHOLDS,
	DEFAULT_GRADFUN_PARAMS,
	DEFAULT_NLMEANS_PARAMS,
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
import { update } from "./polling";
import {
	mountSettingsCodePanel,
	renderAudioLanguagesInput,
	renderBitrateInputs,
	renderDedupeSubtitlesToggle,
	renderDownscaleToggle,
	renderKeepBestAudioChannelsToggle,
	renderLanguageFilterInput,
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
import { applyPresetToSettings, inferPreset } from "./settings-modal";
import { byId } from "../shared/dom";
import { appState } from "../state";

export async function openJobSettings(jobId: string): Promise<void> {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job || job.status !== "queued") return;

	appState.currentEditJobId = jobId;
	byId("job-modal-title").textContent = job.filename;

	const base = window._tempJobSettings ?? job.settings;

	const tempSettings = {
		...base,
		audioBitrates: { ...(base.audioBitrates || job.settings.audioBitrates) },
		autoDenoiseThresholds: { ...(base.autoDenoiseThresholds || DEFAULT_AUTO_THRESHOLDS) },
		nlmeansParams: base.nlmeansParams ? JSON.parse(JSON.stringify(base.nlmeansParams)) : JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS)),
		gradfunParams: base.gradfunParams ? JSON.parse(JSON.stringify(base.gradfunParams)) : JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS)),
		vsFilters: Array.isArray(base.vsFilters) ? JSON.parse(JSON.stringify(base.vsFilters)) : [],
	};
	window._tempJobSettings = tempSettings;

	renderRadioPills(byId("job-quality"), QUALITIES, tempSettings.quality, (v) => (tempSettings.quality = v));
	renderRadioPills(byId("job-speed"), SPEEDS, tempSettings.finalSpeed, (v) => (tempSettings.finalSpeed = v));

	wireEncoderControls("job", tempSettings);

	renderRadioPills(byId("job-denoise"), DENOISE_LEVELS, tempSettings.denoise || "off", (v) => (tempSettings.denoise = v));
	renderRadioPills(byId("job-deband"), DEBAND_LEVELS, tempSettings.deband || "off", (v) => (tempSettings.deband = v));

	const presetValue = inferPreset(tempSettings);

	renderRadioPills(byId("job-pipeline-mode"), PIPELINE_PRESETS, presetValue, (v) => {
		applyPresetToSettings(tempSettings, v);
		byId("job-pipeline-custom").style.display = v === "custom" ? "" : "none";
		byId("job-pipeline-mode-help").textContent = PIPELINE_PRESET_HELP[v] ?? "";
	});

	byId("job-pipeline-custom").style.display = presetValue === "custom" ? "" : "none";
	byId("job-pipeline-mode-help").textContent = PIPELINE_PRESET_HELP[presetValue] ?? "";

	renderRadioPills(byId("job-video-encode"), VIDEO_ENCODE_OPTIONS, tempSettings.videoEncode ?? "av1", (v) => (tempSettings.videoEncode = v));
	renderRadioPills(byId("job-audio-encode"), AUDIO_ENCODE_OPTIONS, tempSettings.audioEncode ?? "opus", (v) => (tempSettings.audioEncode = v));
	renderRadioPills(
		byId("job-subtitle-processing"),
		SUBTITLE_PROCESSING_OPTIONS,
		tempSettings.subtitleProcessing ?? "full",
		(v) => (tempSettings.subtitleProcessing = v),
	);

	renderDownscaleToggle(byId("job-downscale"), tempSettings.downscale || false, (v) => (tempSettings.downscale = v));
	renderSkipBoostingToggle(byId("job-skip-boosting"), tempSettings.skipBoosting || false, (v) => (tempSettings.skipBoosting = v));
	renderNoPhaseInvToggle(byId("job-no-phase-inv"), tempSettings.noPhaseInv || false, (v) => (tempSettings.noPhaseInv = v));
	renderDedupeSubtitlesToggle(byId("job-dedupe-subtitles"), tempSettings.dedupeSubtitles || false, (v) => (tempSettings.dedupeSubtitles = v));
	renderSubtitleLangDetectControl(byId("job-sub-lang-detect"), tempSettings.subtitleLangDetect ?? "enabled", (v) => (tempSettings.subtitleLangDetect = v));
	renderSubtitleConfidenceControl(
		byId("job-sub-lang-confidence"),
		tempSettings.subtitleLangDetectConfidence ?? 0.05,
		(v) => (tempSettings.subtitleLangDetectConfidence = v),
	);
	renderDetectSignsSongsToggle(byId("job-detect-signs-songs"), tempSettings.detectSignsSongs ?? true, (v) => (tempSettings.detectSignsSongs = v));
	renderDetectSDHToggle(byId("job-detect-sdh"), tempSettings.detectSDH ?? true, (v) => (tempSettings.detectSDH = v));
	renderDetectHonorificsToggle(byId("job-detect-honorifics"), tempSettings.detectHonorifics ?? true, (v) => (tempSettings.detectHonorifics = v));
	renderRadioPills(
		byId("job-sub-source-priority"),
		SUBTITLE_SOURCE_PRIORITY_OPTIONS,
		tempSettings.subtitleSourcePriority ?? "official-first",
		(v) => (tempSettings.subtitleSourcePriority = v),
	);
	renderRadioPills(
		byId("job-sub-fansub-tiebreak"),
		SUBTITLE_FANSUB_TIEBREAK_OPTIONS,
		tempSettings.subtitleFansubTiebreak ?? "alphabetical",
		(v) => (tempSettings.subtitleFansubTiebreak = v),
	);
	renderRadioPills(
		byId("job-sub-format-priority"),
		SUBTITLE_FORMAT_PRIORITY_OPTIONS,
		tempSettings.subtitleFormatPriority ?? "text-first",
		(v) => (tempSettings.subtitleFormatPriority = v),
	);

	renderLabeledToggle(
		byId("job-drop-picture-subtitles"),
		tempSettings.dropPictureSubtitles ?? false,
		"Drop picture-based (PGS/VOBSUB) tracks",
		(v) => (tempSettings.dropPictureSubtitles = v),
	);
	renderLabeledToggle(
		byId("job-dedupe-across-format"),
		tempSettings.dedupeAcrossFormat ?? true,
		"Dedupe across formats (one per language + type)",
		(v) => (tempSettings.dedupeAcrossFormat = v),
	);
	renderLabeledToggle(
		byId("job-rename-subtitle-tracks"),
		tempSettings.renameSubtitleTracks ?? true,
		"Rename tracks to clean format",
		(v) => (tempSettings.renameSubtitleTracks = v),
	);

	renderLabeledToggle(byId("job-remove-sdh-subtitles"), tempSettings.removeSDHSubtitles ?? false, "Remove SDH", (v) => (tempSettings.removeSDHSubtitles = v));
	renderLabeledToggle(
		byId("job-remove-commentary-subtitles"),
		tempSettings.removeCommentarySubtitles ?? false,
		"Remove commentary",
		(v) => (tempSettings.removeCommentarySubtitles = v),
	);
	renderLabeledToggle(
		byId("job-remove-forced-signs-songs"),
		tempSettings.removeForcedSignsSongs ?? false,
		"Remove forced / Signs & Songs",
		(v) => (tempSettings.removeForcedSignsSongs = v),
	);
	renderLabeledToggle(
		byId("job-remove-storyboard-subtitles"),
		tempSettings.removeStoryboardSubtitles ?? false,
		"Remove storyboards",
		(v) => (tempSettings.removeStoryboardSubtitles = v),
	);
	renderLabeledToggle(
		byId("job-remove-honorifics-subtitles"),
		tempSettings.removeHonorificsSubtitles ?? false,
		"Remove honorifics",
		(v) => (tempSettings.removeHonorificsSubtitles = v),
	);

	renderLabeledToggle(
		byId("job-assume-mislabeled"),
		tempSettings.assumeMislabeledTracks ?? true,
		"Assume mislabeled JP tracks are English",
		(v) => (tempSettings.assumeMislabeledTracks = v),
	);
	renderNumberControl(
		byId("job-signs-songs-style-ratio"),
		"Signs & Songs ASS-style ratio",
		tempSettings.signsSongsStyleRatio ?? 0.8,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (tempSettings.signsSongsStyleRatio = v),
	);
	renderNumberControl(
		byId("job-signs-songs-line-ratio"),
		"Signs & Songs line ratio",
		tempSettings.signsSongsLineRatio ?? 0.1,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (tempSettings.signsSongsLineRatio = v),
	);
	renderNumberControl(
		byId("job-sdh-ratio"),
		"SDH marker ratio",
		tempSettings.sdhRatioThreshold ?? 0.2,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (tempSettings.sdhRatioThreshold = v),
	);
	renderNumberControl(
		byId("job-sdh-min-lines"),
		"SDH min lines",
		tempSettings.sdhMinLines ?? 10,
		{ min: 0, max: 10000, step: 1 },
		(v) => (tempSettings.sdhMinLines = v),
	);
	renderNumberControl(
		byId("job-honorifics-min-count"),
		"Honorifics min count",
		tempSettings.honorificsMinCount ?? 5,
		{ min: 0, max: 10000, step: 1 },
		(v) => (tempSettings.honorificsMinCount = v),
	);
	renderNumberControl(
		byId("job-honorifics-ratio"),
		"Honorifics ratio (×)",
		tempSettings.honorificsRatio ?? 3,
		{ min: 1, max: 100, step: 0.5 },
		(v) => (tempSettings.honorificsRatio = v),
	);
	renderKeepBestAudioChannelsToggle(
		byId("job-keep-best-audio-channels"),
		tempSettings.keepBestAudioChannelsOnly || false,
		(v) => (tempSettings.keepBestAudioChannelsOnly = v),
	);
	renderRemoveCommentaryAudioToggle(
		byId("job-remove-commentary-audio"),
		tempSettings.removeCommentaryAudio || false,
		(v) => (tempSettings.removeCommentaryAudio = v),
	);

	// Audio manipulation
	renderLabeledToggle(
		byId("job-remove-descriptive-audio"),
		tempSettings.removeDescriptiveAudio ?? false,
		"Remove audio description",
		(v) => (tempSettings.removeDescriptiveAudio = v),
	);
	renderLabeledToggle(
		byId("job-remove-karaoke-audio"),
		tempSettings.removeKaraokeAudio ?? false,
		"Remove karaoke / off-vocal",
		(v) => (tempSettings.removeKaraokeAudio = v),
	);
	renderLabeledToggle(
		byId("job-drop-compatibility-audio"),
		tempSettings.dropCompatibilityAudio ?? true,
		"Drop compatibility downmix tracks",
		(v) => (tempSettings.dropCompatibilityAudio = v),
	);
	renderLabeledToggle(
		byId("job-prefer-uncensored-audio"),
		tempSettings.preferUncensoredAudio ?? true,
		"Prefer uncensored tracks",
		(v) => (tempSettings.preferUncensoredAudio = v),
	);
	renderLabeledToggle(byId("job-dedupe-audio"), tempSettings.dedupeAudio ?? true, "Deduplicate audio tracks", (v) => (tempSettings.dedupeAudio = v));
	renderRadioPills(
		byId("job-audio-codec-priority"),
		AUDIO_CODEC_PRIORITY_OPTIONS,
		tempSettings.audioCodecPriority ?? "lossless-first",
		(v) => (tempSettings.audioCodecPriority = v),
	);
	renderLabeledToggle(
		byId("job-rename-audio-tracks"),
		tempSettings.renameAudioTracks ?? false,
		"Rename tracks to clean format",
		(v) => (tempSettings.renameAudioTracks = v),
	);
	renderLanguagePriorityInput(
		byId("job-audio-lang-priority"),
		tempSettings.audioLanguagePriority ?? ["jpn", "eng", "*"],
		(v) => (tempSettings.audioLanguagePriority = v),
	);

	// Audio type detection
	renderLabeledToggle(
		byId("job-detect-commentary-audio"),
		tempSettings.detectCommentaryAudio ?? true,
		"Detect commentary",
		(v) => (tempSettings.detectCommentaryAudio = v),
	);
	renderLabeledToggle(
		byId("job-detect-descriptive-audio"),
		tempSettings.detectDescriptiveAudio ?? true,
		"Detect audio description",
		(v) => (tempSettings.detectDescriptiveAudio = v),
	);
	renderLabeledToggle(
		byId("job-detect-karaoke-audio"),
		tempSettings.detectKaraokeAudio ?? true,
		"Detect karaoke",
		(v) => (tempSettings.detectKaraokeAudio = v),
	);

	// Subtitle additions
	renderLanguagePriorityInput(
		byId("job-subtitle-lang-priority"),
		tempSettings.subtitleLanguagePriority ?? ["eng", "jpn", "*"],
		(v) => (tempSettings.subtitleLanguagePriority = v),
		"eng, jpn, *",
	);

	renderAudioLanguagesInput(byId("job-audio-languages"), tempSettings.audioLanguages || [], (v) => (tempSettings.audioLanguages = v));
	renderLanguageFilterInput(byId("job-subtitle-languages"), tempSettings.subtitleLanguages || [], (v) => (tempSettings.subtitleLanguages = v));
	renderBitrateInputs(byId("job-bitrates"), tempSettings.audioBitrates, (ch, val) => (tempSettings.audioBitrates[ch] = val));

	mountSettingsCodePanel(byId("settings-code-panel-job"), {
		getSettings: () => window._tempJobSettings,
		onImport: (code) => decodeSettingsCodeRequest(code),
		onApplied: (settings) => {
			if (window._tempJobSettings) Object.assign(window._tempJobSettings, settings);
			if (appState.currentEditJobId) openJobSettings(appState.currentEditJobId);
		},
	});

	byId("job-modal").style.display = "";
}

export async function saveJobSettings() {
	if (!appState.currentEditJobId || !window._tempJobSettings) return;
	await patchJob(appState.currentEditJobId, window._tempJobSettings);
	closeJobModal();
	update();
}

export function closeJobModal() {
	window._tempJobSettings = null;
	const panel = byId<SettingsCodePanelElement>("settings-code-panel-job");
	if (panel._codeTimer) {
		clearInterval(panel._codeTimer);
		panel._codeTimer = null;
	}
	byId("job-modal").style.display = "none";
	appState.currentEditJobId = null;
}

export function closeJobModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeJobModal();
}

export async function removeJob(id: string): Promise<void> {
	await deleteJob(id);
	update();
}

export async function doRetry(id: string): Promise<void> {
	await retryJob(id);
	update();
}
