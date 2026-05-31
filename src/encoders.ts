import type { EncoderId } from "./types";

export interface EncoderDef {
	id: EncoderId;
	label: string;
	binary: string;
	usesAutoBoost: boolean;
	defaultCrf: number;
	defaultPreset: number;
	crfMin: number;
	crfMax: number;
	presetMin: number;
	presetMax: number;
}

export const ENCODERS: Record<EncoderId, EncoderDef> = {
	"svt-av1-essential": {
		id: "svt-av1-essential",
		label: "SVT-AV1-Essential",
		binary: "SvtAv1EncApp",
		usesAutoBoost: true,
		defaultCrf: 28,
		defaultPreset: 4,
		crfMin: 0,
		crfMax: 63,
		presetMin: 0,
		presetMax: 13,
	},
	"svt-av1-hdr": {
		id: "svt-av1-hdr",
		label: "SVT-AV1-HDR",
		binary: "SVT-AV1-HDR",
		usesAutoBoost: false,
		defaultCrf: 24,
		defaultPreset: 4,
		crfMin: 0,
		crfMax: 63,
		presetMin: 0,
		presetMax: 13,
	},
};

export const ENCODER_IDS = Object.keys(ENCODERS) as EncoderId[];
export const DEFAULT_ENCODER: EncoderId = "svt-av1-essential";

export function getEncoder(id: string | undefined): EncoderDef {
	return ENCODERS[(id ?? "") as EncoderId] ?? ENCODERS[DEFAULT_ENCODER];
}

export function isValidEncoder(id: unknown): id is EncoderId {
	return typeof id === "string" && id in ENCODERS;
}
