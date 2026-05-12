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
- **Preview encoding** generate 6 short comparison clips spread across the source so you can A/B source vs encode before committing the full job
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

All settings are configurable via environment variables in `docker-compose.yml`:

| Variable                                | Default                       | Description                                                                                                                  |
| --------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                  | `3000`                        | Web dashboard port                                                                                                           |
| `PASSWORD`                              | `rabbitencoder`               | Password to access web dashboard                                                                                             |
| `FILE_COOLDOWN`                         | `30`                          | Seconds the file size must stay unchanged before encoding starts                                                             |
| `ENCODER_QUALITY`                       | `medium`                      | Default video quality (`low`, `medium`, `high`)                                                                              |
| `ENCODER_SPEED`                         | `slow`                        | Default encode speed (`slower`, `slow`, `medium`, `fast`, `faster`)                                                          |
| `ENCODER_DENOISE`                       | `off`                         | Default denoise level (`off`, `auto`, `light`, `medium`, `heavy`)                                                            |
| `ENCODER_DENOISE_BACKEND`               | `auto`                        | Denoise backend: `cpu`, `auto`, `vulkan`, `opencl`. `cpu` forces software nlmeans.                                           |
| `ENCODER_DENOISE_GPU_DEVICE`            | `0.0`                         | GPU device id (ignored when backend is `cpu`). `0` for vulkan, `<platform>.<device>` for opencl.                             |
| `ENCODER_DENOISE_AUTO_THRESHOLD_LIGHT`  | `0.5`                         | Y bitplane-4 threshold above which scenes get `light` denoise (only used when `ENCODER_DENOISE=auto`).                       |
| `ENCODER_DENOISE_AUTO_THRESHOLD_MEDIUM` | `0.7`                         | Y bitplane-4 threshold above which scenes get `medium` denoise.                                                              |
| `ENCODER_DENOISE_AUTO_THRESHOLD_HEAVY`  | `0.9`                         | Y bitplane-4 threshold above which scenes get `heavy` denoise.                                                               |
| `ENCODER_DENOISE_LIGHT_S`               | `1.0`                         | NLMeans strength `s` for `light` level (float [1.0 – 30.0]).                                                                 |
| `ENCODER_DENOISE_LIGHT_P`               | `3`                           | NLMeans patch size `p` for `light` level (odd int [1 – 99]).                                                                 |
| `ENCODER_DENOISE_LIGHT_R`               | `7`                           | NLMeans research size `r` for `light` level (odd int [1 – 99]).                                                              |
| `ENCODER_DENOISE_MEDIUM_S`              | `1.5`                         | NLMeans `s` for `medium` level.                                                                                              |
| `ENCODER_DENOISE_MEDIUM_P`              | `3`                           | NLMeans `p` for `medium` level.                                                                                              |
| `ENCODER_DENOISE_MEDIUM_R`              | `9`                           | NLMeans `r` for `medium` level.                                                                                              |
| `ENCODER_DENOISE_HEAVY_S`               | `2.0`                         | NLMeans `s` for `heavy` level.                                                                                               |
| `ENCODER_DENOISE_HEAVY_P`               | `3`                           | NLMeans `p` for `heavy` level.                                                                                               |
| `ENCODER_DENOISE_HEAVY_R`               | `11`                          | NLMeans `r` for `heavy` level.                                                                                               |
| `ENCODER_DEBAND`                        | `off`                         | Default deband level (`off`, `light`, `medium`, `heavy`).                                                                    |
| `ENCODER_DEBAND_LIGHT_STRENGTH`         | `0.8`                         | Gradfun strength for `light` level (float [0.51 – 64]).                                                                      |
| `ENCODER_DEBAND_LIGHT_RADIUS`           | `8`                           | Gradfun radius for `light` level (int [8 – 32]).                                                                             |
| `ENCODER_DEBAND_MEDIUM_STRENGTH`        | `1.4`                         | Gradfun strength for `medium` level.                                                                                         |
| `ENCODER_DEBAND_MEDIUM_RADIUS`          | `16`                          | Gradfun radius for `medium` level.                                                                                           |
| `ENCODER_DEBAND_HEAVY_STRENGTH`         | `2.8`                         | Gradfun strength for `heavy` level.                                                                                          |
| `ENCODER_DEBAND_HEAVY_RADIUS`           | `24`                          | Gradfun radius for `heavy` level.                                                                                            |
| `ENCODER_DOWNSCALE`                     | `false`                       | Downscale 4K sources to 1080p before encoding.                                                                               |
| `ENCODER_SKIP_BOOSTING`                 | `false`                       | Skip boosting — bypass per-scene CRF zone analysis.                                                                          |
| `ENCODER_DEDUPE_SUBTITLES`              | `false`                       | Keep only one subtitle per language + type.                                                                                  |
| `AUDIO_NO_PHASE_INV`                    | `false`                       | Disable phase inversion (`--no-phase-inv`) for AV1 encoding.                                                                 |
| `AUDIO_LANGUAGES`                       | _(empty)_                     | Comma-separated audio language codes to keep (empty = keep all).                                                             |
| `SUBTITLE_LANGUAGES`                    | _(empty)_                     | Comma-separated subtitle language codes to keep (empty = keep all).                                                          |
| `ORGANIZATION`                          | `RabbitCompany`               | Tag appended to encoded filenames (e.g. `-RabbitCompany`).                                                                   |
| `AUDIO_BITRATE_MONO`                    | `64`                          | Opus bitrate for mono audio (kbps).                                                                                          |
| `AUDIO_BITRATE_STEREO`                  | `128`                         | Opus bitrate for stereo audio.                                                                                               |
| `AUDIO_BITRATE_2_1`                     | `160`                         | Opus bitrate for 2.1 audio.                                                                                                  |
| `AUDIO_BITRATE_5_1`                     | `256`                         | Opus bitrate for 5.1 audio.                                                                                                  |
| `AUDIO_BITRATE_6_1`                     | `320`                         | Opus bitrate for 6.1 audio.                                                                                                  |
| `AUDIO_BITRATE_7_1`                     | `384`                         | Opus bitrate for 7.1 audio.                                                                                                  |
| `AUDIO_BITRATE_7_1_4`                   | `448`                         | Opus bitrate for 7.1.4 Atmos audio.                                                                                          |
| `VS_PRESETS_STOCK_DIR`                  | `/app/vapoursynth/presets`    | Directory the built-in VapourSynth presets are loaded from. Override only if you mount a custom stock set.                   |
| `VS_PRESETS_USER_DIR`                   | `/config/vapoursynth/presets` | Directory scanned for user-provided VapourSynth presets. Mounted from the host via `./vapoursynth-user:/config/vapoursynth`. |
| `VS_RABBIT_MODULE_DIR`                  | `/app/vapoursynth`            | Path added to `PYTHONPATH` so preset scripts can `import rabbit_vs`.                                                         |

If `ORGANIZATION` is set to `RabbitCompany` (the default), then any file ending with `-RabbitCompany.mkv` is treated as already encoded and will be:

- Shown with a green **encoded** badge and dimmed in the library browser
- Completely **skipped** when you click Encode Folder

This means you can safely run Encode Folder on the same series multiple times (only new or unencoded files will be queued).

## Encoding Pipeline

For each file, the engine runs:

1. **Probe** - Extract media info (resolution, audio layout, HDR metadata)
2. **Prepare** - Extract the best video stream into a clean container, then run any configured **VapourSynth filter chain** (each enabled filter is piped through `vspipe` -> FFmpeg as its own pass, before the FFmpeg filter chain)
3. **Auto-Boost-Essential** - 4-stage video encoding:
   - Fast pass for scene analysis
   - Quality metric calculation (XPSNR)
   - Optimal CRF zone generation
   - Final encode with per-scene CRF adjustments
4. **Audio** - Encode audio tracks to Opus via FLAC pipe
5. **Mux** - Merge video + audio into MKV with metadata tags
6. **HDR** - Apply HDR10 metadata via mkvpropedit (if source is HDR)

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

Both files must share the same stem. The `.vpy` script reads its input path from the `SRC` argument and any tunable parameter via `rabbit_vs.arg_int / arg_float / arg_str / arg_bool`. See [**Examples**](https://github.com/Rabbit-Company/RabbitEncoder/tree/vapoursynth/vapoursynth/presets).

User presets are namespaced as `user:<id>` and override nothing (stock and user presets coexist). After editing or adding presets, click **Reload presets** in the Advanced Settings panel (or `POST /api/vs-presets/reload`); no container restart is required.

### Per-job behavior

The VapourSynth chain is stored per job, so different files in the same queue can use different filter stacks. Each entry has a `level` (or `"off"` to disable without removing it from the chain) and a per-level param map, letting you switch intensity without losing your tweaks at other levels. The active chain is also baked into the output MKV's `SETTINGS` tag (e.g. `VS finedehalo/medium+dehalo_alpha/light`) for traceability.

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

## Supported Input Formats

`.mp4`, `.mkv`, `.avi`, `.webm`, `.flv`, `.ts`, `.mov`

## API Endpoints

| Method   | Endpoint                                    | Description                                                                   |
| -------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET`    | `/api/jobs`                                 | List all jobs                                                                 |
| `GET`    | `/api/jobs/:id`                             | Get job details                                                               |
| `PATCH`  | `/api/jobs/:id`                             | Update job settings (queued only)                                             |
| `DELETE` | `/api/jobs/:id`                             | Remove a job                                                                  |
| `POST`   | `/api/jobs/:id/retry`                       | Retry a failed job                                                            |
| `POST`   | `/api/jobs/:id/cancel`                      | Cancel an actively encoding job                                               |
| `POST`   | `/api/jobs/:id/move`                        | Move a queued job in the queue (`direction`: `up`, `down`, `top`, `bottom`)   |
| `POST`   | `/api/jobs/reorder`                         | Set the entire queue order from a JSON `{ ids: [...] }` body                  |
| `GET`    | `/api/jobs/:id/audio-preview`               | Preview audio reorder/filter/dedup for a job                                  |
| `GET`    | `/api/jobs/:id/subtitle-preview`            | Preview subtitle reorder/rename for a job                                     |
| `GET`    | `/api/jobs/:id/mediainfo`                   | Run `mediainfo` on the source file and return the report                      |
| `GET`    | `/api/jobs/:id/preview`                     | Get preview-encode state for a job (`idle`, running, or completed samples)    |
| `POST`   | `/api/jobs/:id/preview`                     | Start a preview encode (6 short comparison clips spread across the source)    |
| `DELETE` | `/api/jobs/:id/preview`                     | Cancel a running preview, or clear completed preview artifacts                |
| `GET`    | `/api/jobs/:id/preview/sample/:index/:kind` | Fetch a preview artifact. `kind`: `source` / `encode` (PNG) or `clip` (MKV)   |
| `GET`    | `/api/config`                               | Get default settings                                                          |
| `PATCH`  | `/api/config`                               | Update default settings                                                       |
| `GET`    | `/api/library`                              | List configured library root directories                                      |
| `GET`    | `/api/library/browse`                       | Browse a library folder (`?path=/data/library/Animes`)                        |
| `POST`   | `/api/library/encode`                       | Queue all videos in a folder for in-place encoding                            |
| `GET`    | `/api/queue`                                | Get queue state (paused or running)                                           |
| `POST`   | `/api/queue/pause`                          | Pause encoding - stops current encode, preserves queue                        |
| `POST`   | `/api/queue/resume`                         | Resume encoding from where it was paused                                      |
| `GET`    | `/api/opencl-devices`                       | List available OpenCL devices                                                 |
| `GET`    | `/api/vulkan-devices`                       | List available Vulkan devices                                                 |
| `GET`    | `/api/benchmark`                            | Get current benchmark state                                                   |
| `POST`   | `/api/benchmark`                            | Start a denoise benchmark run                                                 |
| `DELETE` | `/api/benchmark`                            | Cancel a running benchmark                                                    |
| `GET`    | `/api/vs-presets`                           | List all VapourSynth presets (stock + user) with their manifests              |
| `POST`   | `/api/vs-presets/reload`                    | Rescan stock and user preset directories from disk and reload the registry    |
| `GET`    | `/api/vs-presets/:id/default-entry`         | Build a fresh filter-chain entry for `:id`, pre-filled with manifest defaults |

All API endpoints require authentication via `Authorization: Bearer <token>` header, where the token is the BLAKE2b-512 hash of `rabbitencoder-{PASSWORD}`.

## License

GPL-3.0
