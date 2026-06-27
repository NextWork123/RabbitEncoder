import type { JobSettings, ProbeResult, SourceTrackPlan } from "./types";
import {
	analyzeSubtitleStreams,
	sortSubtitleStreams,
	filterStreamsByLanguage,
	filterSubtitleTypes,
	deduplicateSubtitleStreams,
	filterAudioTypes,
	sortAudioStreams,
	deduplicateAudioStreams,
} from "./tracks";
import { Logger } from "./logger";

export async function analyzeSourceTracks(
	probe: ProbeResult,
	settings: JobSettings,
	inputPath: string,
	tempDir: string,
	signal: AbortSignal,
): Promise<SourceTrackPlan> {
	// Audio
	const allAudioStreams = probe.audioStreams || [];

	const audioDetect = {
		commentary: settings.detectCommentaryAudio,
		descriptive: settings.detectDescriptiveAudio,
		karaoke: settings.detectKaraokeAudio,
	};

	const allowedAudioLangs = settings.audioLanguages || [];
	const langFiltered = filterStreamsByLanguage(allAudioStreams, allowedAudioLangs, "audio");
	const skippedLang = allAudioStreams.length - langFiltered.length;
	if (skippedLang > 0) Logger.info(`[audio] Filtered ${skippedLang} track(s) not in [${allowedAudioLangs.join(", ")}]`);

	const typeFiltered = filterAudioTypes(
		langFiltered,
		{
			removeCommentary: settings.removeCommentaryAudio,
			removeDescriptive: settings.removeDescriptiveAudio,
			removeKaraoke: settings.removeKaraokeAudio,
			dropCompatibility: settings.dropCompatibilityAudio,
		},
		audioDetect,
	);
	const droppedByType = langFiltered.length - typeFiltered.length;
	if (droppedByType > 0) Logger.info(`[audio] Dropped ${droppedByType} track(s) by type/compatibility filters`);

	const sortedAudio = sortAudioStreams(typeFiltered, {
		languagePriority: settings.audioLanguagePriority,
		preferUncensored: settings.preferUncensoredAudio,
		detect: audioDetect,
	});

	const audioStreams = settings.dedupeAudio
		? deduplicateAudioStreams(sortedAudio, {
				collapseChannels: settings.keepBestAudioChannelsOnly,
				codecPriority: settings.audioCodecPriority,
				preferUncensored: settings.preferUncensoredAudio,
				detect: audioDetect,
			})
		: sortedAudio;

	if (settings.dedupeAudio && sortedAudio.length !== audioStreams.length) {
		Logger.info(`[audio] Deduplicated ${sortedAudio.length - audioStreams.length} redundant track(s)`);
	}

	// Subtitles
	const allSubtitleStreams = probe.subtitleStreams || [];

	await analyzeSubtitleStreams(
		allSubtitleStreams,
		inputPath,
		tempDir,
		{
			langDetect: settings.subtitleLangDetect,
			langDetectConfidence: settings.subtitleLangDetectConfidence,
			detectSignsSongs: settings.detectSignsSongs,
			detectSDH: settings.detectSDH,
			detectHonorifics: settings.detectHonorifics,
			signsSongsStyleRatio: settings.signsSongsStyleRatio,
			signsSongsLineRatio: settings.signsSongsLineRatio,
			sdhRatioThreshold: settings.sdhRatioThreshold,
			sdhMinLines: settings.sdhMinLines,
			honorificsMinCount: settings.honorificsMinCount,
			honorificsRatio: settings.honorificsRatio,
			assumeMislabeled: settings.assumeMislabeledTracks,
		},
		signal,
	);

	const sortedSubtitleStreams = sortSubtitleStreams(allSubtitleStreams, {
		sourcePriority: settings.subtitleSourcePriority,
		fansubTiebreak: settings.subtitleFansubTiebreak,
		formatPriority: settings.subtitleFormatPriority,
		languagePriority: settings.subtitleLanguagePriority,
	});

	const allowedSubLangs = settings.subtitleLanguages || [];
	const langFilteredSubs = filterStreamsByLanguage(sortedSubtitleStreams, allowedSubLangs, "subtitle");
	const skippedSubLang = sortedSubtitleStreams.length - langFilteredSubs.length;
	if (skippedSubLang > 0) Logger.info(`[subtitle] Filtered ${skippedSubLang} track(s) not in [${allowedSubLangs.join(", ")}]`);

	const typeFilteredSubs = filterSubtitleTypes(langFilteredSubs, {
		removeSDH: settings.removeSDHSubtitles,
		removeCommentary: settings.removeCommentarySubtitles,
		removeForcedSignsSongs: settings.removeForcedSignsSongs,
		removeStoryboard: settings.removeStoryboardSubtitles,
		removeHonorifics: settings.removeHonorificsSubtitles,
		dropPicture: settings.dropPictureSubtitles,
	});
	const droppedByTypeSubs = langFilteredSubs.length - typeFilteredSubs.length;
	if (droppedByTypeSubs > 0) Logger.info(`[subtitle] Dropped ${droppedByTypeSubs} track(s) by type/format filters`);

	const subtitleStreams = settings.dedupeSubtitles
		? deduplicateSubtitleStreams(typeFilteredSubs, { acrossFormat: settings.dedupeAcrossFormat })
		: typeFilteredSubs;

	if (settings.dedupeSubtitles && typeFilteredSubs.length !== subtitleStreams.length) {
		Logger.info(`[subtitle] Deduplicated ${typeFilteredSubs.length - subtitleStreams.length} redundant track(s)`);
	}

	return { subtitleStreams, audioStreams };
}
