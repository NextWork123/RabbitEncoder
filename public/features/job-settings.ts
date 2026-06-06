import type { SettingsCodePanelElement } from "../ui/models";
import { decodeSettingsCodeRequest, deleteJob, fetchJobs, patchJob, retryJob } from "../api/client";
import {
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
	SUBTITLE_PROCESSING_OPTIONS,
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
