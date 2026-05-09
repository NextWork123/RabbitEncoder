"""
F3KDeband - vs-jetpack f3k_deband implementation.

Wrapper around the vszip.Deband plugin (modern f3kdb successor) for removing
color banding in smooth gradients while preserving detail. Particularly useful
for animation, low-bitrate sources, and 8-bit content with quantization bands.

Backed by `vsdeband.f3k_deband` (vs-jetpack).
API reference: https://jaded-encoding-thaumaturgy.github.io/vs-jetpack/api/vsdeband/debanders/#vsdeband.debanders.f3k_deband

Tunables exposed by this preset:
	radius        - banding detection radius (1 - 255)
	thr           - banding detection threshold (1 - 255)
	grain         - grain to add after debanding (0 - 256)
	planes        - which planes to process (all | luma | chroma)
	sample_mode   - reference pixel sampling strategy
	dynamic_grain - generate unique grain per frame (bool)
	blur_first    - compare against mean of refs vs each ref individually (bool)
	seed          - grain RNG seed; -1 picks a random seed each run
	random        - RNG algorithm for reference positions and grain
"""

import vapoursynth as vs
from vsdeband import f3k_deband

import rabbit_vs

core = vs.core

src_path = rabbit_vs.arg_str("SRC")

radius        = rabbit_vs.arg_int("radius", 16)
thr           = rabbit_vs.arg_float("thr", 96.0)
grain         = rabbit_vs.arg_float("grain", 0.0)
planes_s      = rabbit_vs.arg_str("planes", "all")
sample_mode_s = rabbit_vs.arg_str("sample_mode", "SQUARE")
dynamic_grain = rabbit_vs.arg_bool("dynamic_grain", False)
blur_first    = rabbit_vs.arg_bool("blur_first", True)
seed          = rabbit_vs.arg_int("seed", -1)
random_s      = rabbit_vs.arg_str("random", "UNIFORM")

SAMPLE_MODES = {
	"COLUMN":             f3k_deband.SampleMode.COLUMN,
	"SQUARE":             f3k_deband.SampleMode.SQUARE,
	"ROW":                f3k_deband.SampleMode.ROW,
	"COL_ROW_MEAN":       f3k_deband.SampleMode.COL_ROW_MEAN,
	"MEAN_DIFF_INT":      f3k_deband.SampleMode.MEAN_DIFF_INT,
	"MEAN_DIFF_FLOAT":    f3k_deband.SampleMode.MEAN_DIFF_FLOAT,
	"MEAN_DIFF_GRADIENT": f3k_deband.SampleMode.MEAN_DIFF_GRADIENT,
}

RANDOM_ALGOS = {
	"OLD":      f3k_deband.RandomAlgo.OLD,
	"UNIFORM":  f3k_deband.RandomAlgo.UNIFORM,
	"GAUSSIAN": f3k_deband.RandomAlgo.GAUSSIAN,
}

PLANES = {
	"all":    None,
	"luma":   0,
	"chroma": [1, 2],
}

sample_mode = SAMPLE_MODES.get(sample_mode_s, f3k_deband.SampleMode.SQUARE)
random_algo = RANDOM_ALGOS.get(random_s, f3k_deband.RandomAlgo.UNIFORM)
planes      = PLANES.get(planes_s, None)

src  = rabbit_vs.load_source(src_path)
work = rabbit_vs.to_working_depth(src, 16)

work = f3k_deband(
	work,
	radius=radius,
	thr=thr,
	grain=grain,
	planes=planes,
	sample_mode=sample_mode,
	dynamic_grain=dynamic_grain,
	blur_first=blur_first,
	seed=seed if seed >= 0 else None,
	random=random_algo,
)

out = rabbit_vs.match_format(work, src)
out.set_output(0)