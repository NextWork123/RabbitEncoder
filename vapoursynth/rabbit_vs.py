"""
Rabbit Encoder - VapourSynth helper module.

This module is imported by every preset script and centralizes the boilerplate
that would otherwise be repeated everywhere: argument parsing, source loading,
bit-depth conversion, and frame-property preservation.

Conventions
-----------
The encoder invokes presets via:

	vspipe -c y4m -a SRC=/path/to/source.mkv -a rx=2.0 -a darkstr=1.0 ... preset.vpy -

so every parameter arrives as a *string* in the script's `__main__` globals.
The `arg_*` helpers below read those values with a typed cast and a default.

Output contract
---------------
Each preset must end with `clip.set_output(0)` where `clip` has the SAME format
(pixel format, bit depth, color family) as the source clip. `match_format()`
makes that easy after high-bit-depth filter work.

Frame properties carrying color metadata (_Matrix, _Transfer, _Primaries,
_ColorRange) are populated by the source filter and passed through transparently;
the y4m header alone does NOT carry HDR metadata, so the encoder also passes the
probed color tags as ffmpeg muxing flags on the receiving end.
"""

from __future__ import annotations

import sys
from typing import Optional, Union

import vapoursynth as vs

core = vs.core

def _raw_arg(name: str) -> Optional[str]:
	"""
	Read an argument injected by `vspipe -a name=value`.

	In VSPipe R75, the .vpy script executes with __name__ == "__vapoursynth__",
	and -a/--arg values are inserted into that script's globals. They are not
	present in sys.modules["__main__"], and "__vapoursynth__" may not exist in
	sys.modules either.

	So we inspect the caller's globals: edgecleaner.vpy -> rabbit_vs.arg_* ->
	_raw_arg().
	"""
	import inspect

	frame = inspect.currentframe()
	try:
		# _raw_arg -> arg_str/arg_int/etc -> preset .vpy
		caller = frame.f_back.f_back if frame and frame.f_back else None
		if caller is not None and name in caller.f_globals:
			return caller.f_globals[name]

		# Fallbacks for interactive/manual usage.
		for module_name in ("__main__",):
			mod = sys.modules.get(module_name)
			if mod is not None and name in mod.__dict__:
				return mod.__dict__[name]

		return None
	finally:
		del frame


class MissingArgError(RuntimeError):
	"""Raised when a required vspipe -a argument is absent."""


def arg_str(name: str, default: Optional[str] = None) -> str:
	v = _raw_arg(name)
	if v is None:
		if default is None:
			raise MissingArgError(f"Missing required vspipe arg: {name}")
		return default
	return str(v)


def arg_int(name: str, default: Optional[int] = None) -> int:
	v = _raw_arg(name)
	if v is None:
		if default is None:
			raise MissingArgError(f"Missing required vspipe arg: {name}")
		return int(default)
	return int(float(v))  # tolerate "2.0" strings for ints


def arg_float(name: str, default: Optional[float] = None) -> float:
	v = _raw_arg(name)
	if v is None:
		if default is None:
			raise MissingArgError(f"Missing required vspipe arg: {name}")
		return float(default)
	return float(v)


def arg_bool(name: str, default: Optional[bool] = None) -> bool:
	v = _raw_arg(name)
	if v is None:
		if default is None:
			raise MissingArgError(f"Missing required vspipe arg: {name}")
		return bool(default)
	return str(v).strip().lower() in ("1", "true", "yes", "on")


def load_source(path: str, prefer: str = "ffms2") -> vs.VideoNode:
	"""
	Load a video file with the best available source filter.

	Order of preference: ffms2 (robust, widely tested) -> lsmas (faster but
	occasionally finicky on weird containers). Both populate _Matrix /
	_Transfer / _Primaries / _ColorRange frame properties when the source
	has them tagged.
	"""
	have_ffms2 = hasattr(core, "ffms2")
	have_lsmas = hasattr(core, "lsmas")

	if prefer == "lsmas" and have_lsmas:
		return core.lsmas.LWLibavSource(path)
	if have_ffms2:
		return core.ffms2.Source(path)
	if have_lsmas:
		return core.lsmas.LWLibavSource(path)
	raise RuntimeError(
		"No VapourSynth source filter available (need vapoursynth-ffms2 or vapoursynth-lsmashsource)"
	)


def _format_for_depth(clip: vs.VideoNode, bits: int) -> vs.VideoFormat:
	"""Look up the VS format with the same family/subsampling at a different depth."""
	return core.query_video_format(
		clip.format.color_family,
		clip.format.sample_type,
		bits,
		clip.format.subsampling_w,
		clip.format.subsampling_h,
	)


def to_working_depth(clip: vs.VideoNode, bits: int = 16) -> vs.VideoNode:
	"""
	Convert to a high bit depth for filter work, preserving family/subsampling.

	Most modern VS filters (FineDehalo, BM3D, dfttest, etc.) want 16-bit input
	for clean math; converting back to source depth at the end keeps the
	rest of the pipeline happy.
	"""
	if clip.format.bits_per_sample == bits:
		return clip
	target = _format_for_depth(clip, bits)
	return core.resize.Bicubic(clip, format=target.id)


def match_format(clip: vs.VideoNode, source_clip: vs.VideoNode) -> vs.VideoNode:
	"""
	Convert `clip` back to `source_clip`'s exact format.

	Call this immediately before set_output so downstream FFmpeg receives the
	same pixel format it would have seen without VapourSynth in the chain.
	"""
	if clip.format.id == source_clip.format.id:
		return clip
	return core.resize.Bicubic(clip, format=source_clip.format.id)


def is_hdr(clip: vs.VideoNode) -> bool:
	"""
	Best-effort HDR detection from frame properties on the first frame.

	Returns True for PQ (transfer 16) or HLG (transfer 18). Only used by
	presets that want to gate behavior on HDR - most presets don't need this.
	"""
	try:
		frame = clip.get_frame(0)
		transfer = frame.props.get("_Transfer", 0)
		return transfer in (16, 18)  # SMPTE2084 (PQ), ARIB STD-B67 (HLG)
	except Exception:
		return False


def check_plugin(plugin_attr: str, hint: str = "") -> None:
	"""
	Fail loudly with a clear message if a required plugin is missing.

	Usage in a preset:
		rabbit_vs.check_plugin("knlm", "install vapoursynth-jetpack")
	"""
	if not hasattr(core, plugin_attr):
		msg = f"Required VapourSynth plugin not loaded: core.{plugin_attr}"
		if hint:
			msg += f" ({hint})"
		raise RuntimeError(msg)