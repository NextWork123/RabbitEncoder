"""
FineDehalo - modern vs-jetpack implementation.

Reduces dark and bright halos around high-contrast edges. Particularly useful
for anime, DVD upscales, and any source where ringing or oversharpening has
introduced visible halos.

Backed by `vsdehalo.fine_dehalo` (vs-jetpack).
API reference: https://jaded-encoding-thaumaturgy.github.io/vs-jetpack/api/vsdehalo/

Tunables exposed by this preset:
	rx        - horizontal halo radius (1 - 4)
	ry        - vertical halo radius   (1 - 4)
	darkstr   - dark halo removal strength   (0.0 - 1.0)
	brightstr - bright halo removal strength (0.0 - 1.0)
	thmi      - minimum sharp-edge threshold (0 - 255)
	thma      - maximum sharp-edge threshold (0 - 255)
	lowsens   - sensitivity threshold lower bound  (0 - 100)
	highsens  - sensitivity threshold upper bound  (0 - 100)
	ss        - supersampling factor (1.0 - 2.0) - reduces aliasing, higher values are more expensive
	contra    - contra-sharpening to restore edge contrast (0.0 - 2.0)
"""
import vapoursynth as vs
from vsdehalo import fine_dehalo

import rabbit_vs

core = vs.core

src_path  = rabbit_vs.arg_str("SRC")
rx        = rabbit_vs.arg_int("rx", 2)
ry        = rabbit_vs.arg_int("ry", 2)
darkstr   = rabbit_vs.arg_float("darkstr", 0.0)
brightstr = rabbit_vs.arg_float("brightstr", 1.0)
thmi      = rabbit_vs.arg_float("thmi", 80.0)
thma      = rabbit_vs.arg_float("thma", 128.0)
lowsens   = rabbit_vs.arg_float("lowsens", 50.0)
highsens  = rabbit_vs.arg_float("highsens", 50.0)
ss        = rabbit_vs.arg_float("ss", 1.5)
contra    = rabbit_vs.arg_float("contra", 0.0)

src  = rabbit_vs.load_source(src_path)
work = rabbit_vs.to_working_depth(src, 16)

work = fine_dehalo(
	work,
	rx=rx, ry=ry,
	darkstr=darkstr, brightstr=brightstr,
	thmi=thmi, thma=thma,
	lowsens=lowsens, highsens=highsens,
	ss=ss,
	contra=contra,
)

out = rabbit_vs.match_format(work, src)
out.set_output(0)