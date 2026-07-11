import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { basename, dirname, extname, join, parse as parsePath, resolve } from "path";
import type { AppConfig, Job } from "../core/types";
import { Logger } from "../core/logger";
import { run } from "../core/process";

/**
 * Shared output finalization for every pipeline (full encode, translate-only).
 *
 * Extracted verbatim from encoder.ts so the "library replace-in-place vs
 * watched-input → output dir" contract cannot drift between pipelines.
 * encoder.ts should delete its local copies of resolveUniqueOutputPath and
 * cleanupAssociatedFiles and import them from here instead.
 */

/**
 * Remove .nfo, .srt, .jpg and .png files associated with a video file.
 */
export function cleanupAssociatedFiles(videoPath: string): void {
	const dir = dirname(videoPath);
	const stem = parsePath(videoPath).name;

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const entryStem = parsePath(entry).name;
			const entryExt = extname(entry).toLowerCase();

			const isAssociated = entryStem.startsWith(stem);

			if (isAssociated && [".nfo", ".srt", ".jpg", ".png"].includes(entryExt)) {
				const fullPath = join(dir, entry);
				try {
					unlinkSync(fullPath);
					Logger.info(`[library] Removed associated file: ${entry}`);
				} catch (err: any) {
					Logger.warn(`[library] Failed to remove ${entry}:`, { "error.message": err?.message });
				}
			}
		}
	} catch {}
}

/**
 * Resolve a non-colliding absolute output path.
 *
 * If `dir/filename` already exists (and is not `ignorePath` - the source we are
 * about to replace in place), a numeric suffix is appended before the
 * extension: `name.mkv`, `name (2).mkv`, ... - until a free path
 * is found. This guarantees two distinct source files can never be written to
 * the same output, so an encode can never silently overwrite an earlier one
 * even if the computed names happen to be identical.
 */
export function resolveUniqueOutputPath(dir: string, filename: string, ignorePath?: string): string {
	const ext = extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	const ignore = ignorePath ? resolve(ignorePath) : null;

	let candidate = join(dir, filename);
	let n = 2;
	while (existsSync(candidate) && resolve(candidate) !== ignore) {
		candidate = join(dir, `${stem} (${n})${ext}`);
		n++;
	}
	return candidate;
}

/**
 * Move a finished temp file to its final destination and return that path.
 *
 * Library jobs (`job.replaceSource`): the result lands next to the source; if
 * it does not overwrite the source directly, associated Jellyfin/Sonarr
 * metadata is cleaned up and the source removed. Watched-input jobs: the
 * result lands in `config.outputDir` (respecting `job.relativePath`).
 *
 * Note: deleting the *input* file for non-replaceSource jobs stays the
 * caller's responsibility (matching encodeJob's existing behavior), because
 * some flows finalize by moving the input file itself.
 */
export async function finalizeOutput(job: Job, config: AppConfig, finishedFile: string, outputFilename: string, signal?: AbortSignal): Promise<string> {
	let outputPath: string;

	if (job.replaceSource) {
		const sourceDir = dirname(job.inputPath);
		outputPath = resolveUniqueOutputPath(sourceDir, outputFilename, job.inputPath);

		const moveRes = await run(["mv", finishedFile, outputPath], { signal });
		if (moveRes.code !== 0) {
			await run(["cp", finishedFile, outputPath], { signal });
			unlinkSync(finishedFile);
		}

		if (resolve(outputPath) !== resolve(job.inputPath)) {
			cleanupAssociatedFiles(job.inputPath);
			try {
				unlinkSync(job.inputPath);
				Logger.info(`[library] Removed source: ${job.filename}`);
			} catch (err: any) {
				Logger.warn(`[library] Failed to remove source ${job.filename}:`, { "error.message": err?.message });
			}
		}

		Logger.info(`[library] Replaced with: ${basename(outputPath)}`);
	} else {
		const outputSubDir = job.relativePath ? join(config.outputDir, job.relativePath) : config.outputDir;
		mkdirSync(outputSubDir, { recursive: true });
		outputPath = resolveUniqueOutputPath(outputSubDir, outputFilename);

		const moveRes = await run(["mv", finishedFile, outputPath], { signal });
		if (moveRes.code !== 0) {
			await run(["cp", finishedFile, outputPath], { signal });
			unlinkSync(finishedFile);
		}
	}

	return outputPath;
}
