"""
DehaloAlpha - vs-jetpack dehalo_alpha implementation.

API: https://jaded-encoding-thaumaturgy.github.io/vs-jetpack/api/vsdehalo/alpha/#vsdehalo.alpha.dehalo_alpha
"""

import vapoursynth as vs
from vsdehalo import dehalo_alpha

import rabbit_vs

core = vs.core

src_path = rabbit_vs.arg_str("SRC")

blur      = rabbit_vs.arg_float("blur", 1.4)
lowsens   = rabbit_vs.arg_float("lowsens", 50.0)
highsens  = rabbit_vs.arg_float("highsens", 50.0)
ss        = rabbit_vs.arg_float("ss", 1.5)
darkstr   = rabbit_vs.arg_float("darkstr", 0.0)
brightstr = rabbit_vs.arg_float("brightstr", 1.0)
planes    = rabbit_vs.arg_int("planes", 0)

src = rabbit_vs.load_source(src_path)

work = dehalo_alpha(
	src,
	blur=blur,
	lowsens=lowsens,
	highsens=highsens,
	ss=ss,
	darkstr=darkstr,
	brightstr=brightstr,
	planes=planes,
)

out = rabbit_vs.match_format(work, src)
out.set_output(0)