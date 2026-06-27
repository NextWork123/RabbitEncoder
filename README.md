# Rabbit Encoder

Automated AV1 video transcoding pipeline powered by **Auto-Boost-Essential** and **Opus** audio encoding, with a real-time web dashboard.

Drop media files into the `input` folder and get optimally encoded MKV files in the `output` folder, or browse your media library directly from the dashboard and encode entire series in-place.

## Features

- **Auto-Boost-Essential** integration for optimal per-scene CRF zones
- **Opus** audio encoding with configurable per-channel bitrates
- **HDR10 metadata** preservation (PQ, BT.2020, mastering display, content light)
- **VapourSynth filter chain** stackable per-job filters (FineDehalo, DehaloAlpha...) with `light` / `medium` / `heavy` presets, full per-parameter overrides, and a hot-reloadable user preset directory for dropping in your own `.vpy` scripts
- **Web dashboard** for monitoring progress and configuring per-file settings
- **File watcher** auto-detects new files in the input directory
- **Queue system** processes files sequentially, with drag-and-drop reordering and pause/resume
- **Preview encoding** generates configurable short samples spread across the source, with frame-aligned source/encode comparisons before committing the full job
- **Library encoding** browse mounted media folders from the UI and encode in-place, replacing source files
- **Jellyfin / Sonarr integration** automatically cleans up `.nfo` and thumbnail files when replacing sources so metadata is regenerated
- **Smart skip** already-encoded files (detected by `-{ORGANIZATION}` suffix) are recognized and skipped

## Quick Start

```bash
# 1. Configure settings in docker-compose.yml (or use defaults)

# 2. deploy container
docker compose up -d

# 3. Open the dashboard (http://localhost:3000)

# 4. Drop files into the input folder
cp movie.mkv input/
```

## Configuration

Settings are configurable via environment variables in `docker-compose.yml`:

| Variable               | Default                       | Description                                                      |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `PORT`                 | `3000`                        | Web dashboard port                                               |
| `PASSWORD`             | `rabbitencoder`               | Password to access web dashboard                                 |
| `FILE_COOLDOWN`        | `30`                          | Seconds the file size must stay unchanged before encoding starts |
| `ORGANIZATION`         | `RabbitCompany`               | Tag appended to encoded filenames (e.g. `-RabbitCompany`)        |
| `INPUT_DIR`            | `/data/input`                 | Watched input directory                                          |
| `OUTPUT_DIR`           | `/data/output`                | Encoded output directory                                         |
| `TEMP_DIR`             | `/data/temp`                  | Temporary encode and preview files                               |
| `LIBRARY_DIRS`         | empty                         | Comma-separated mounted library roots                            |
| `FONTS_STOCK_DIR`      | `/app/fonts`                  | Built-in font directory                                          |
| `FONTS_USER_DIR`       | `/config/fonts`               | User font directory                                              |
| `VS_PRESETS_STOCK_DIR` | `/app/vapoursynth/presets`    | Built-in VapourSynth preset directory                            |
| `VS_PRESETS_USER_DIR`  | `/config/vapoursynth/presets` | User VapourSynth preset directory                                |
| `VS_RABBIT_MODULE_DIR` | `/app/vapoursynth`            | Rabbit Encoder VapourSynth helper-module directory               |

If `ORGANIZATION` is set to `RabbitCompany` (the default), then any file ending with `-RabbitCompany.mkv` is treated as already encoded and will be:

- Shown with a green **encoded** badge and dimmed in the library browser
- Completely **skipped** when you click Encode Folder

This means you can safely run Encode Folder on the same series multiple times (only new or unencoded files will be queued).

## Encoding Pipeline

For each file, the engine runs:

1. **Probe** - Extract media information such as resolution, audio layout, frame rate, subtitle tracks, and HDR metadata.
2. **Prepare** - Extract the primary video stream, run the configured VapourSynth passes, and apply the FFmpeg crop/downscale/denoise/deband chain.
3. **Auto-Boost-Essential** - Run scene analysis, quality metrics, CRF-zone generation, and the final AV1 encode.
4. **Audio** - Sort, filter, deduplicate, and encode selected audio tracks to Opus through a FLAC pipe, or copy them when configured.
5. **Subtitles and fonts**
   - Sort, filter, deduplicate, and rename subtitle tracks.
   - Optionally convert SRT subtitles to ASS.
   - Restyle dialogue-classified ASS styles without changing signs, songs, or other untouched styles.
   - Resolve language/script-specific font faces.
   - Instance selected variable-font axes into static font files.
   - Remove unused source font attachments when enabled.
   - Preserve source fonts still referenced by surviving untouched styles or inline `\fn` overrides.
   - Use numbered aliases such as `Noto Sans 2` only when a retained source font already occupies the requested family name.
6. **Mux** - Merge video, audio, subtitles, chapters, fonts, and metadata into the final MKV.
7. **HDR** - Apply HDR10 metadata with `mkvpropedit` when required.

## Preview Encoding

Preview encoding creates configurable samples distributed across the source so source and encoded results can be compared before running the full job.

Each sample starts from an exact, lossless FFV1 video window rather than a stream-copied GOP fragment. This prevents keyframe preroll and timestamp offsets from causing source and encoded comparison images to land on different frames. The default is 6 samples, and both the sample count and duration can be changed through the dashboard or preview API.

Intermediate VapourSynth and prepare-filter stills are also exposed when those stages are active.

## VapourSynth Filters

Rabbit Encoder ships with a VapourSynth filter system that lets you stack arbitrary preprocessing passes in front of the main encode. Each filter runs as its own `vspipe` pass.

### Stock presets

Built-in presets live under `/app/vapoursynth/presets` inside the container and are namespaced as `stock:<id>`:

| Preset ID            | Name         | Description                                                                                                                                        |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stock:finedehalo`   | FineDehalo   | Reduces dark/bright halos around high-contrast edges. Best for anime and DVD upscales.                                                             |
| `stock:dehalo_alpha` | Dehalo Alpha | Classic halo reduction via `vs-jetpack`'s `dehalo_alpha`.                                                                                          |
| `stock:f3k_deband`   | F3K Deband   | Removes color banding in smooth gradients while preserving detail. Wraps `vszip.Deband` (modern f3kdb successor) and can re-grain after debanding. |

Every preset declares its own `levels` (typically `light`, `medium`, `heavy`) and a set of tunable parameters. You can pick a level per job and override individual params per-level in the dashboard's **Advanced Settings -> VapourSynth Filters** panel.

### User custom presets

To add your own filter, drop a matching pair of files into the host-mounted user directory (`./vapoursynth-user/presets` by default, exposed inside the container at `/config/vapoursynth/presets`):

```
myfilter.vpy    # the VapourSynth script
myfilter.json   # the manifest (id, levels, params, defaults)
```

Both files must share the same stem. The `.vpy` script reads its input path from the `SRC` argument and any tunable parameter via `rabbit_vs.arg_int / arg_float / arg_str / arg_bool`. See [**Examples**](https://github.com/Rabbit-Company/RabbitEncoder/tree/main/vapoursynth/presets).

User presets are namespaced as `user:<id>` and override nothing (stock and user presets coexist). After editing or adding presets, click **Reload presets** in the Advanced Settings panel (or `POST /api/vs-presets/reload`); no container restart is required.

### Per-job behavior

The VapourSynth chain is stored per job, so different files in the same queue can use different filter stacks. Each entry has a `level` (or `"off"` to disable without removing it from the chain) and a per-level parameter map, letting you switch intensity without losing your tweaks at other levels. The active chain and its resolved parameters are stored in the output MKV's versioned `SETTINGS` code (for example, `RE1|...`) so the configuration can be reproduced later.

## Subtitle Fonts

Rabbit Encoder can choose different files from one configured font family according to subtitle language and detected script. This allows a family to provide separate Latin, Arabic, Thai, Simplified Chinese, Traditional Chinese, and other script-specific faces.

Variable-font axes such as `wght` are converted into static font instances before attachment. Axis values are not included in visible attachment names or ASS family names.

When a retained source font already uses the selected internal family name, Rabbit Encoder chooses the first available numbered alias:

- `Noto Sans`
- `Noto Sans 2`
- `Noto Sans 3`

The selected alias is written consistently to the static font's internal metadata, the MKV attachment filename, and the ASS styles Rabbit Encoder rewrites.

With **Remove unused fonts** enabled, source attachments are retained only when surviving untouched ASS styles or inline `\fn` overrides still reference them. A source font used only by dialogue that Rabbit Encoder restyles does not cause the original attachment to be kept.

### ASS PlayRes scaling

Configured subtitle dimensions are authored in 1920×1080 space. When Rabbit Encoder restyles an existing ASS file, it preserves that file's original `PlayResX` and `PlayResY` and scales pixel-based values into the script's coordinate system.

For example, a configured 64 px font becomes 21.333 in a script using `PlayResY: 360`:

```text
64 × 360 / 1080 = 21.333
```

When rendered over a 1080p video, libass scales it back to approximately the configured 64 px size. Font size, outline, shadow, and margins use the same PlayRes-aware scaling.

## Output Naming

Files are named following the pattern:

```
{Title} [Source-Resolution][Opus Layout][AV1]-{ORGANIZATION}.mkv
```

For example:

```
Blue Exorcist (2011) - S01E01 - The Devil Resides in Human Souls [Bluray-1080p][Opus 2.0][AV1]-RabbitCompany.mkv
```

Source tags are detected from the input filename: `Bluray`, `WEBDL`, `WEBRip`, `HDTV`, `DVD`, `SDTV`, `CAM`. Files with `REMUX` in the name are tagged as `Bluray`.

## Settings Codes

Each encoded file includes a `SETTINGS` tag. This is a compact, versioned string that records the exact resolved settings used for the encode, such as `RE1|c~q=h,ds=1|dn~m=m,s=4.5,p=5,r=13`.

The settings code stores the actual underlying values, including every nlmeans and gradfun parameter, each active VapourSynth filter in chain order, and all related filter parameters. This makes it possible to reproduce a setup even if presets have changed since the original encode.

To restore settings from a code, paste it into the **Settings Code** field in either the Default Settings panel or the per-job settings panel. Codes are portable across machines because GPU-specific choices, such as the denoise backend and GPU device, are intentionally left out. This prevents an imported code from overwriting the target machine’s hardware configuration.

The format is versioned with an `RE<n>` prefix, so older codes continue to work as the format evolves. Fields that match the shipped baseline are omitted, which means a stock-default configuration is represented simply as `RE1`.

## Supported Input Formats

`.mp4`, `.mkv`, `.avi`, `.webm`, `.flv`, `.ts`, `.mov`

## API Endpoints

| Method   | Endpoint                                    | Description                                                                    |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET`    | `/api/jobs`                                 | List all jobs                                                                  |
| `GET`    | `/api/jobs/:id`                             | Get job details                                                                |
| `PATCH`  | `/api/jobs/:id`                             | Update job settings (queued only)                                              |
| `DELETE` | `/api/jobs/:id`                             | Remove a job                                                                   |
| `POST`   | `/api/jobs/:id/retry`                       | Retry a failed job                                                             |
| `POST`   | `/api/jobs/:id/cancel`                      | Cancel an actively encoding job                                                |
| `POST`   | `/api/jobs/:id/move`                        | Move a queued job in the queue (`direction`: `up`, `down`, `top`, `bottom`)    |
| `POST`   | `/api/jobs/:id/import-code`                 | Apply a settings code to a queued job, replacing its settings                  |
| `POST`   | `/api/jobs/reorder`                         | Set the entire queue order from a JSON `{ ids: [...] }` body                   |
| `GET`    | `/api/jobs/:id/audio-preview`               | Preview audio reorder/filter/dedup for a job                                   |
| `GET`    | `/api/jobs/:id/subtitle-preview`            | Preview subtitle reorder/rename for a job                                      |
| `GET`    | `/api/jobs/:id/mediainfo`                   | Run `mediainfo` on the source file and return the report                       |
| `GET`    | `/api/jobs/:id/preview`                     | Get preview-encode state for a job (`idle`, running, or completed samples)     |
| `POST`   | `/api/jobs/:id/preview`                     | Start a preview encode; optional body configures sample count and duration     |
| `DELETE` | `/api/jobs/:id/preview`                     | Cancel a running preview, or clear completed preview artifacts                 |
| `GET`    | `/api/jobs/:id/preview/sample/:index/:kind` | Fetch source/encode clips, comparison PNGs, VS stills, or prepare-stage stills |
| `GET`    | `/api/config`                               | Get default settings                                                           |
| `PATCH`  | `/api/config`                               | Update default settings                                                        |
| `POST`   | `/api/config/reset`                         | Reset default settings                                                         |
| `POST`   | `/api/config/import-code`                   | Import a settings code as the new default settings                             |
| `POST`   | `/api/settings/encode`                      | Encode a settings object into a shareable settings code (`{ code }`)           |
| `POST`   | `/api/settings/decode`                      | Decode a settings code back into a settings object (`{ settings }`)            |
| `GET`    | `/api/library`                              | List configured library root directories                                       |
| `GET`    | `/api/library/browse`                       | Browse a library folder (`?path=/data/library/Animes`)                         |
| `POST`   | `/api/library/encode`                       | Queue all videos in a folder for in-place encoding                             |
| `GET`    | `/api/queue`                                | Get queue state (paused or running)                                            |
| `POST`   | `/api/queue/pause`                          | Pause encoding - stops current encode, preserves queue                         |
| `POST`   | `/api/queue/resume`                         | Resume encoding from where it was paused                                       |
| `GET`    | `/api/system`                               | Current system resource usage (CPU, RAM, temp-partition disk, network, GPU)    |
| `GET`    | `/api/opencl-devices`                       | List available OpenCL devices                                                  |
| `GET`    | `/api/vulkan-devices`                       | List available Vulkan devices                                                  |
| `GET`    | `/api/benchmark`                            | Get current benchmark state                                                    |
| `POST`   | `/api/benchmark`                            | Start a denoise benchmark run                                                  |
| `DELETE` | `/api/benchmark`                            | Cancel a running benchmark                                                     |
| `GET`    | `/api/vs-presets`                           | List all VapourSynth presets (stock + user) with their manifests               |
| `POST`   | `/api/vs-presets/reload`                    | Rescan stock and user preset directories from disk and reload the registry     |
| `GET`    | `/api/vs-presets/:id/default-entry`         | Build a fresh filter-chain entry for `:id`, pre-filled with manifest defaults  |

## License

GPL-3.0
