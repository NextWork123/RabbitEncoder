import type { AudioChannelBitrates, JobSettings } from "../types";
import type { PipelinePreset } from "../ui/models";
import {
	AUDIO_CODEC_PRIORITY_OPTIONS,
	AUDIO_ENCODE_OPTIONS,
	CROP_OPTIONS,
	DEBAND_LEVELS,
	DEFAULT_AUTO_THRESHOLDS,
	DEFAULT_GRADFUN_PARAMS,
	DEFAULT_NLMEANS_PARAMS,
	DEFAULT_SUBTITLE_STYLE,
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
	renderAudioLanguagesInput,
	renderBitrateInputs,
	renderCropLimit,
	renderDedupeSubtitlesToggle,
	renderDetectHonorificsToggle,
	renderDetectSDHToggle,
	renderDetectSignsSongsToggle,
	renderDownscaleToggle,
	renderKeepBestAudioChannelsToggle,
	renderLabeledToggle,
	renderLanguageFilterInput,
	renderLanguagePriorityInput,
	renderNoPhaseInvToggle,
	renderNumberControl,
	renderRadioPills,
	renderRemoveCommentaryAudioToggle,
	renderSkipBoostingToggle,
	renderSubtitleConfidenceControl,
	renderSubtitleLangDetectControl,
	renderSubtitleStyleTargets,
	wireEncoderControls,
} from "./settings-controls";
import { byId } from "../shared/dom";

export type SettingsFormPrefix = "default" | "job";

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

/**
 * Produce a detached, deeply-cloned copy of `base` suitable for live editing in
 * a modal. Nested objects/arrays are cloned so that cancelling the modal (and
 * discarding the temp copy) truly reverts every change. Missing nested fields
 * fall back to defaults, covering older entries not yet migrated by the backend.
 *
 * `audioBitratesFallback` supplies a bitrate map when `base` lacks one (job
 * settings fall back to the job's own bitrates; defaults always carry theirs).
 */
export function cloneSettingsForEditing(base: JobSettings, audioBitratesFallback?: AudioChannelBitrates): JobSettings {
	return {
		...base,
		audioBitrates: { ...(base.audioBitrates || audioBitratesFallback) },
		autoDenoiseThresholds: { ...(base.autoDenoiseThresholds || DEFAULT_AUTO_THRESHOLDS) },
		nlmeansParams: base.nlmeansParams ? JSON.parse(JSON.stringify(base.nlmeansParams)) : JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS)),
		gradfunParams: base.gradfunParams ? JSON.parse(JSON.stringify(base.gradfunParams)) : JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS)),
		subtitleStyle: base.subtitleStyle
			? { ...base.subtitleStyle, fontAxes: { ...(base.subtitleStyle.fontAxes ?? {}) } }
			: { ...DEFAULT_SUBTITLE_STYLE, fontAxes: {} },
		assRestyleTargets: Array.isArray(base.assRestyleTargets) ? [...base.assRestyleTargets] : ["full", "honorifics", "forced", "sdh", "commentary"],
		vsFilters: Array.isArray(base.vsFilters) ? JSON.parse(JSON.stringify(base.vsFilters)) : [],
	};
}

/**
 * Render every control in a settings modal body. The default-settings and
 * job-settings modals share an identical form, differing only by element-id
 * prefix ("default-" vs "job-") and which temp object they mutate — both of
 * which are passed in. Callers remain responsible for cloning the settings,
 * setting the modal title, mounting the settings-code panel, and showing the
 * modal, since those differ between the two.
 */
export function renderSettingsForm(prefix: SettingsFormPrefix, settings: JobSettings): void {
	const el = (suffix: string): HTMLElement => byId(`${prefix}-${suffix}`);

	renderRadioPills(el("quality"), QUALITIES, settings.quality, (v) => (settings.quality = v));
	renderRadioPills(el("speed"), SPEEDS, settings.finalSpeed, (v) => (settings.finalSpeed = v));

	wireEncoderControls(prefix, settings);

	renderRadioPills(el("denoise"), DENOISE_LEVELS, settings.denoise || "off", (v) => (settings.denoise = v));
	renderRadioPills(el("deband"), DEBAND_LEVELS, settings.deband || "off", (v) => (settings.deband = v));

	const presetValue = inferPreset(settings);

	renderRadioPills(el("pipeline-mode"), PIPELINE_PRESETS, presetValue, (v) => {
		applyPresetToSettings(settings, v);
		el("pipeline-custom").style.display = v === "custom" ? "" : "none";
		el("pipeline-mode-help").textContent = PIPELINE_PRESET_HELP[v] ?? "";
	});

	el("pipeline-custom").style.display = presetValue === "custom" ? "" : "none";
	el("pipeline-mode-help").textContent = PIPELINE_PRESET_HELP[presetValue] ?? "";

	renderRadioPills(el("video-encode"), VIDEO_ENCODE_OPTIONS, settings.videoEncode ?? "av1", (v) => (settings.videoEncode = v));
	renderRadioPills(el("audio-encode"), AUDIO_ENCODE_OPTIONS, settings.audioEncode ?? "opus", (v) => (settings.audioEncode = v));
	renderRadioPills(el("subtitle-processing"), SUBTITLE_PROCESSING_OPTIONS, settings.subtitleProcessing ?? "full", (v) => (settings.subtitleProcessing = v));

	renderDownscaleToggle(el("downscale"), settings.downscale || false, (v) => (settings.downscale = v));
	renderRadioPills(el("crop"), CROP_OPTIONS, settings.crop || "off", (v) => {
		settings.crop = v;
		// Re-render crop limit to reflect visibility change
		renderCropLimit(el("crop-limit"), settings.crop, settings.cropLimit ?? 0.1, (nv) => (settings.cropLimit = nv));
	});
	renderCropLimit(el("crop-limit"), settings.crop, settings.cropLimit ?? 0.1, (v) => (settings.cropLimit = v));
	renderSkipBoostingToggle(el("skip-boosting"), settings.skipBoosting || false, (v) => (settings.skipBoosting = v));
	renderNoPhaseInvToggle(el("no-phase-inv"), settings.noPhaseInv || false, (v) => (settings.noPhaseInv = v));
	renderDedupeSubtitlesToggle(el("dedupe-subtitles"), settings.dedupeSubtitles || false, (v) => (settings.dedupeSubtitles = v));
	renderSubtitleLangDetectControl(el("sub-lang-detect"), settings.subtitleLangDetect ?? "enabled", (v) => (settings.subtitleLangDetect = v));
	renderSubtitleConfidenceControl(el("sub-lang-confidence"), settings.subtitleLangDetectConfidence ?? 0.05, (v) => (settings.subtitleLangDetectConfidence = v));
	renderDetectSignsSongsToggle(el("detect-signs-songs"), settings.detectSignsSongs ?? true, (v) => (settings.detectSignsSongs = v));
	renderDetectSDHToggle(el("detect-sdh"), settings.detectSDH ?? true, (v) => (settings.detectSDH = v));
	renderDetectHonorificsToggle(el("detect-honorifics"), settings.detectHonorifics ?? true, (v) => (settings.detectHonorifics = v));
	renderRadioPills(
		el("sub-source-priority"),
		SUBTITLE_SOURCE_PRIORITY_OPTIONS,
		settings.subtitleSourcePriority ?? "official-first",
		(v) => (settings.subtitleSourcePriority = v),
	);
	renderRadioPills(
		el("sub-fansub-tiebreak"),
		SUBTITLE_FANSUB_TIEBREAK_OPTIONS,
		settings.subtitleFansubTiebreak ?? "alphabetical",
		(v) => (settings.subtitleFansubTiebreak = v),
	);
	renderRadioPills(
		el("sub-format-priority"),
		SUBTITLE_FORMAT_PRIORITY_OPTIONS,
		settings.subtitleFormatPriority ?? "text-first",
		(v) => (settings.subtitleFormatPriority = v),
	);

	renderLabeledToggle(
		el("drop-picture-subtitles"),
		settings.dropPictureSubtitles ?? false,
		"Drop picture-based (PGS/VOBSUB) tracks",
		(v) => (settings.dropPictureSubtitles = v),
	);
	renderLabeledToggle(
		el("dedupe-across-format"),
		settings.dedupeAcrossFormat ?? true,
		"Dedupe across formats (one per language + type)",
		(v) => (settings.dedupeAcrossFormat = v),
	);
	renderLabeledToggle(
		el("rename-subtitle-tracks"),
		settings.renameSubtitleTracks ?? true,
		"Rename tracks to clean format",
		(v) => (settings.renameSubtitleTracks = v),
	);

	renderLabeledToggle(el("remove-sdh-subtitles"), settings.removeSDHSubtitles ?? false, "Remove SDH", (v) => (settings.removeSDHSubtitles = v));
	renderLabeledToggle(
		el("remove-commentary-subtitles"),
		settings.removeCommentarySubtitles ?? false,
		"Remove commentary",
		(v) => (settings.removeCommentarySubtitles = v),
	);
	renderLabeledToggle(
		el("remove-forced-signs-songs"),
		settings.removeForcedSignsSongs ?? false,
		"Remove forced / Signs & Songs",
		(v) => (settings.removeForcedSignsSongs = v),
	);
	renderLabeledToggle(
		el("remove-storyboard-subtitles"),
		settings.removeStoryboardSubtitles ?? false,
		"Remove storyboards",
		(v) => (settings.removeStoryboardSubtitles = v),
	);
	renderLabeledToggle(
		el("remove-honorifics-subtitles"),
		settings.removeHonorificsSubtitles ?? false,
		"Remove honorifics",
		(v) => (settings.removeHonorificsSubtitles = v),
	);

	renderLabeledToggle(
		el("assume-mislabeled"),
		settings.assumeMislabeledTracks ?? true,
		"Assume mislabeled JP tracks are English",
		(v) => (settings.assumeMislabeledTracks = v),
	);
	renderNumberControl(
		el("signs-songs-style-ratio"),
		"Signs & Songs ASS-style ratio",
		settings.signsSongsStyleRatio ?? 0.8,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (settings.signsSongsStyleRatio = v),
	);
	renderNumberControl(
		el("signs-songs-line-ratio"),
		"Signs & Songs line ratio",
		settings.signsSongsLineRatio ?? 0.1,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (settings.signsSongsLineRatio = v),
	);
	renderNumberControl(
		el("sdh-ratio"),
		"SDH marker ratio",
		settings.sdhRatioThreshold ?? 0.2,
		{ min: 0, max: 1, step: 0.05 },
		(v) => (settings.sdhRatioThreshold = v),
	);
	renderNumberControl(el("sdh-min-lines"), "SDH min lines", settings.sdhMinLines ?? 10, { min: 0, max: 10000, step: 1 }, (v) => (settings.sdhMinLines = v));
	renderNumberControl(
		el("honorifics-min-count"),
		"Honorifics min count",
		settings.honorificsMinCount ?? 5,
		{ min: 0, max: 10000, step: 1 },
		(v) => (settings.honorificsMinCount = v),
	);
	renderNumberControl(
		el("honorifics-ratio"),
		"Honorifics ratio (×)",
		settings.honorificsRatio ?? 3,
		{ min: 1, max: 100, step: 0.5 },
		(v) => (settings.honorificsRatio = v),
	);
	renderKeepBestAudioChannelsToggle(
		el("keep-best-audio-channels"),
		settings.keepBestAudioChannelsOnly || false,
		(v) => (settings.keepBestAudioChannelsOnly = v),
	);
	renderRemoveCommentaryAudioToggle(el("remove-commentary-audio"), settings.removeCommentaryAudio || false, (v) => (settings.removeCommentaryAudio = v));

	// Audio manipulation
	renderLabeledToggle(
		el("remove-descriptive-audio"),
		settings.removeDescriptiveAudio ?? false,
		"Remove audio description",
		(v) => (settings.removeDescriptiveAudio = v),
	);
	renderLabeledToggle(el("remove-karaoke-audio"), settings.removeKaraokeAudio ?? false, "Remove karaoke / off-vocal", (v) => (settings.removeKaraokeAudio = v));
	renderLabeledToggle(
		el("drop-compatibility-audio"),
		settings.dropCompatibilityAudio ?? true,
		"Drop compatibility downmix tracks",
		(v) => (settings.dropCompatibilityAudio = v),
	);
	renderLabeledToggle(
		el("prefer-uncensored-audio"),
		settings.preferUncensoredAudio ?? true,
		"Prefer uncensored tracks",
		(v) => (settings.preferUncensoredAudio = v),
	);
	renderLabeledToggle(el("dedupe-audio"), settings.dedupeAudio ?? true, "Deduplicate audio tracks", (v) => (settings.dedupeAudio = v));
	renderRadioPills(
		el("audio-codec-priority"),
		AUDIO_CODEC_PRIORITY_OPTIONS,
		settings.audioCodecPriority ?? "lossless-first",
		(v) => (settings.audioCodecPriority = v),
	);
	renderLabeledToggle(el("rename-audio-tracks"), settings.renameAudioTracks ?? false, "Rename tracks to clean format", (v) => (settings.renameAudioTracks = v));
	renderLanguagePriorityInput(el("audio-lang-priority"), settings.audioLanguagePriority ?? ["jpn", "eng", "*"], (v) => (settings.audioLanguagePriority = v));

	// Audio type detection
	renderLabeledToggle(el("detect-commentary-audio"), settings.detectCommentaryAudio ?? true, "Detect commentary", (v) => (settings.detectCommentaryAudio = v));
	renderLabeledToggle(
		el("detect-descriptive-audio"),
		settings.detectDescriptiveAudio ?? true,
		"Detect audio description",
		(v) => (settings.detectDescriptiveAudio = v),
	);
	renderLabeledToggle(el("detect-karaoke-audio"), settings.detectKaraokeAudio ?? true, "Detect karaoke", (v) => (settings.detectKaraokeAudio = v));

	// Subtitle additions
	renderLanguagePriorityInput(
		el("subtitle-lang-priority"),
		settings.subtitleLanguagePriority ?? ["eng", "jpn", "*"],
		(v) => (settings.subtitleLanguagePriority = v),
		"eng, jpn, *",
	);

	// Subtitle styling & fonts
	renderLabeledToggle(el("convert-srt-ass"), settings.convertSrtToAss ?? false, "Convert SRT subtitles to styled ASS", (v) => (settings.convertSrtToAss = v));
	renderLabeledToggle(el("restyle-ass-font"), settings.restyleAssFont ?? false, "Replace dialogue font in existing ASS", (v) => (settings.restyleAssFont = v));
	renderSubtitleStyleTargets(
		el("ass-restyle-targets"),
		settings.assRestyleTargets ?? ["full", "honorifics", "forced", "sdh", "commentary"],
		(v) => (settings.assRestyleTargets = v),
	);
	renderLabeledToggle(el("remove-unused-fonts"), settings.removeUnusedFonts ?? false, "Remove unused fonts from MKV", (v) => (settings.removeUnusedFonts = v));

	renderAudioLanguagesInput(el("audio-languages"), settings.audioLanguages || [], (v) => (settings.audioLanguages = v));
	renderLanguageFilterInput(el("subtitle-languages"), settings.subtitleLanguages || [], (v) => (settings.subtitleLanguages = v));
	renderBitrateInputs(el("bitrates"), settings.audioBitrates, (ch, val) => (settings.audioBitrates[ch] = val));
}
