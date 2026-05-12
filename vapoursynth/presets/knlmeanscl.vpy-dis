"""
KNLMeansCL - OpenCL-accelerated Non-Local Means denoising.

Effective on a wide range of noise: film grain, sensor noise, low-bitrate
compression artifacts. Works on SDR and HDR sources, and runs on GPU when
available (much faster than CPU NLMeans).

Backed by the `knlm.KNLMeansCL` VapourSynth plugin
(https://github.com/Khanattila/KNLMeansCL).

Tunables exposed by this preset:
	h           - filter strength; larger removes more noise (and detail)
	d           - temporal radius; (2*d+1) frames are used per output frame
	a           - spatial search-window radius; window is (2*a+1)^2 pixels
	s           - similarity-neighborhood radius; (2*s+1)^2 pixels
	channels    - which channels to denoise: auto, Y, UV, YUV, RGB
	wmode       - weighting function (0=Welsch, 1/3=Mod. Bisquare, 2=Bisquare)
	wref        - amount of original pixel to mix back into the result
	device_type - OpenCL device class: auto, gpu, cpu, accelerator
	device_id   - which device of that type to use (0 = first)
"""
import vapoursynth as vs

import rabbit_vs

core = vs.core

rabbit_vs.check_plugin("knlm", "install via 'vsrepo install knlm'")

src_path = rabbit_vs.arg_str("SRC")

h           = rabbit_vs.arg_float("h", 1.2)
d           = rabbit_vs.arg_int("d", 1)
a           = rabbit_vs.arg_int("a", 2)
s           = rabbit_vs.arg_int("s", 4)
channels    = rabbit_vs.arg_str("channels", "auto")
wmode       = rabbit_vs.arg_int("wmode", 0)
wref        = rabbit_vs.arg_float("wref", 1.0)
device_type = rabbit_vs.arg_str("device_type", "auto")
device_id   = rabbit_vs.arg_int("device_id", 0)

src = rabbit_vs.load_source(src_path)

work = core.knlm.KNLMeansCL(
	src,
	d=d,
	a=a,
	s=s,
	h=h,
	channels=channels,
	wmode=wmode,
	wref=wref,
	device_type=device_type,
	device_id=device_id,
)

out = rabbit_vs.match_format(work, src)
out.set_output(0)
