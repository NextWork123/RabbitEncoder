import Blake2b from "@rabbit-company/blake2b";
import pkg from "../package.json";

document.getElementById("title-version").innerText = `v${pkg.version}`;

const API = "";
let queuePaused = false;
let defaults = null;
let currentEditJobId = null;
let authToken = localStorage.getItem("authToken") || "";
let pollTimer = null;
let benchmarkPollTimer = null;
let vsPresets = null;

const QUALITIES = ["low", "medium", "high"];
const SPEEDS = ["slower", "slow", "medium", "fast", "faster"];
const DENOISE_LEVELS = ["off", "auto", "light", "medium", "heavy"];
const DEBAND_LEVELS = ["off", "light", "medium", "heavy"];

const DENOISE_BACKENDS = ["cpu", "auto", "vulkan", "opencl"];

const DEFAULT_NLMEANS_PARAMS = {
	light: { s: 1.0, p: 3, r: 7 },
	medium: { s: 1.5, p: 3, r: 9 },
	heavy: { s: 2.0, p: 3, r: 11 },
};
const DEFAULT_GRADFUN_PARAMS = {
	light: { strength: 0.8, radius: 8 },
	medium: { strength: 1.4, radius: 16 },
	heavy: { strength: 2.8, radius: 24 },
};
const DEFAULT_AUTO_THRESHOLDS = { light: 0.5, medium: 0.7, heavy: 0.9 };

const CHANNELS = [
	{ key: "mono", label: "Mono" },
	{ key: "stereo", label: "Stereo" },
	{ key: "2.1", label: "2.1" },
	{ key: "5.1", label: "5.1" },
	{ key: "6.1", label: "6.1" },
	{ key: "7.1", label: "7.1" },
	{ key: "7.1.4", label: "7.1.4 Atmos" },
];

const expandedFolders = new Set();
let libraryDirs = [];
const libraryNodes = new Map();

let previewPollTimer = null;
let currentPreviewJobId = null;
let currentPreviewSettingsFingerprint = "";
const previewBlobCache = new Map(); // key = `${jobId}:${idx}:${kind}` -> object URL
let currentPreviewFullscreenCard = null;

function previewSettingsFingerprintFE(s) {
	return JSON.stringify({
		quality: s.quality,
		finalSpeed: s.finalSpeed,
		denoise: s.denoise,
		denoiseBackend: s.denoiseBackend,
		gpuDevice: s.gpuDevice,
		deband: s.deband,
		downscale: s.downscale,
		skipBoosting: s.skipBoosting,
		nlmeansParams: s.nlmeansParams,
		gradfunParams: s.gradfunParams,
		autoDenoiseThresholds: s.autoDenoiseThresholds,
	});
}

function createTreeNode(entry, depth, parentPath) {
	return {
		path: entry.path,
		name: entry.name,
		type: entry.type,
		depth,
		parentPath,
		expanded: false,
		checked: false,
		children: entry.type === "directory" ? null : undefined,
		loading: false,
		encoded: entry.encoded || false,
		videoCount: entry.videoCount || 0,
		encodedCount: entry.encodedCount || 0,
		size: entry.size || 0,
	};
}

function hashPassword(password) {
	return Blake2b.hash(`rabbitencoder-${password}`);
}

function showLogin(message) {
	const modal = document.getElementById("login-modal");
	const error = document.getElementById("login-error");
	const input = document.getElementById("login-password");
	error.textContent = message || "";
	input.value = "";
	modal.style.display = "";
	input.focus();
}

function hideLogin() {
	document.getElementById("login-modal").style.display = "none";
}

async function handleLogin() {
	const input = document.getElementById("login-password");
	const password = input.value.trim();
	if (!password) return;

	const btn = document.getElementById("login-submit-btn");
	btn.disabled = true;
	btn.textContent = "Verifying...";

	authToken = hashPassword(password);

	try {
		const res = await fetch(`${API}/api/config`, {
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (res.status === 401 || res.status === 403) {
			document.getElementById("login-error").textContent = "Invalid password";
			input.value = "";
			input.focus();
			return;
		}

		if (!res.ok) {
			document.getElementById("login-error").textContent = `Server error (${res.status})`;
			return;
		}

		localStorage.setItem("authToken", authToken);
		hideLogin();
		defaults = await res.json();
		startPolling();
	} catch (e) {
		document.getElementById("login-error").textContent = "Cannot reach server";
	} finally {
		btn.disabled = false;
		btn.textContent = "Login";
	}
}

function logout() {
	authToken = "";
	localStorage.removeItem("authToken");
	defaults = null;
	lastJobsJson = "";
	stopPolling();
	document.getElementById("jobs-list").style.display = "none";
	document.getElementById("empty-state").style.display = "";
	showLogin("");
}

async function authFetch(url, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (authToken) {
		headers["Authorization"] = `Bearer ${authToken}`;
	}
	const res = await fetch(url, { ...opts, headers });

	if (res.status === 401 || res.status === 403) {
		authToken = "";
		localStorage.removeItem("authToken");
		stopPolling();
		showLogin("Session expired, please log in again");
		throw new Error("Unauthorized");
	}

	return res;
}

let openClDevices = null;
async function fetchOpenClDevices() {
	if (openClDevices !== null) return openClDevices;
	try {
		const res = await authFetch(`${API}/api/opencl-devices`);
		const data = await res.json();
		openClDevices = data.devices || [];
	} catch {
		openClDevices = [];
	}
	return openClDevices;
}

let vulkanDevices = null;
async function fetchVulkanDevices() {
	if (vulkanDevices !== null) return vulkanDevices;
	try {
		const res = await authFetch(`${API}/api/vulkan-devices`);
		const data = await res.json();
		vulkanDevices = data.devices || [];
	} catch {
		vulkanDevices = [];
	}
	return vulkanDevices;
}

async function fetchJobs() {
	const res = await authFetch(`${API}/api/jobs`);
	return res.json();
}

async function fetchConfig() {
	const res = await authFetch(`${API}/api/config`);
	return res.json();
}

async function fetchQueueState() {
	const res = await authFetch(`${API}/api/queue`);
	return res.json();
}

async function pauseQueueRequest() {
	const res = await authFetch(`${API}/api/queue/pause`, { method: "POST" });
	return res.json();
}

async function resumeQueueRequest() {
	const res = await authFetch(`${API}/api/queue/resume`, { method: "POST" });
	return res.json();
}

async function fetchBenchmark() {
	const res = await authFetch(`${API}/api/benchmark`);
	return res.json();
}

async function startBenchmarkRun() {
	const res = await authFetch(`${API}/api/benchmark`, { method: "POST" });
	return res.json();
}

async function cancelBenchmarkRun() {
	const res = await authFetch(`${API}/api/benchmark`, { method: "DELETE" });
	return res.json();
}

async function patchConfig(settings) {
	const res = await authFetch(`${API}/api/config`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return res.json();
}

async function patchJob(id, settings) {
	const res = await authFetch(`${API}/api/jobs/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return res.json();
}

async function deleteJob(id) {
	await authFetch(`${API}/api/jobs/${id}`, { method: "DELETE" });
}

async function retryJob(id) {
	await authFetch(`${API}/api/jobs/${id}/retry`, { method: "POST" });
}

async function cancelJob(id) {
	await authFetch(`${API}/api/jobs/${id}/cancel`, { method: "POST" });
}

async function reorderQueue(orderedIds) {
	await authFetch(`${API}/api/jobs/reorder`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ids: orderedIds }),
	});
}

async function fetchPreviewState(jobId) {
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview`);
	return res.json();
}

async function startPreviewRequest(jobId) {
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview`, { method: "POST" });
	return res.json();
}

async function cancelPreviewRequest(jobId) {
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview`, { method: "DELETE" });
	return res.json();
}

async function fetchVsPresets(force = false) {
	if (vsPresets !== null && !force) return vsPresets;
	const res = await authFetch(`${API}/api/vs-presets`);
	const data = await res.json();
	vsPresets = data.presets || [];
	return vsPresets;
}

async function reloadVsPresets() {
	await authFetch(`${API}/api/vs-presets/reload`, { method: "POST" });
	return fetchVsPresets(true);
}

async function fetchVsDefaultEntry(presetId) {
	const res = await authFetch(`${API}/api/vs-presets/${encodeURIComponent(presetId)}/default-entry`);
	return res.json();
}

function renderVsChainEditor(container, settings) {
	container.innerHTML = "";
	settings.vsFilters = settings.vsFilters || [];

	fetchVsPresets().then((presets) => {
		if (presets.length === 0) {
			const empty = document.createElement("div");
			empty.className = "vs-empty";
			empty.textContent = "No VapourSynth presets found.";
			container.appendChild(empty);
			return;
		}

		settings.vsFilters.forEach((entry, idx) => {
			const manifest = presets.find((p) => p.id === entry.presetId);
			if (!manifest) return;
			container.appendChild(renderVsChainEntry(manifest, entry, idx, settings));
		});

		const addRow = document.createElement("div");
		addRow.className = "vs-add-row";

		const select = document.createElement("select");
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = "+ Add filter…";
		select.appendChild(placeholder);
		for (const p of presets) {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = `${p.name}  ·  ${p.source}`;
			select.appendChild(opt);
		}
		select.onchange = async () => {
			if (!select.value) return;
			const fresh = await fetchVsDefaultEntry(select.value);
			settings.vsFilters.push(fresh);
			renderVsChainEditor(container, settings);
		};

		addRow.appendChild(select);
		container.appendChild(addRow);
	});
}

function renderVsChainEntry(manifest, entry, idx, settings) {
	const card = document.createElement("div");
	card.className = "vs-entry-card";

	const header = document.createElement("div");
	header.className = "vs-entry-header";

	const name = document.createElement("span");
	name.className = "vs-entry-name";
	name.textContent = manifest.name;
	header.appendChild(name);

	const badge = document.createElement("span");
	badge.className = `vs-entry-source ${manifest.source === "user" ? "user" : ""}`;
	badge.textContent = manifest.source;
	header.appendChild(badge);

	const removeBtn = document.createElement("button");
	removeBtn.className = "btn btn-ghost btn-small btn-remove";
	removeBtn.textContent = "Remove";
	removeBtn.onclick = () => {
		settings.vsFilters.splice(idx, 1);
		renderVsChainEditor(card.parentElement, settings);
	};
	header.appendChild(removeBtn);
	card.appendChild(header);

	if (manifest.description) {
		const desc = document.createElement("div");
		desc.className = "vs-entry-description";
		desc.textContent = manifest.description;
		card.appendChild(desc);
	}

	const levelOptions = ["off", ...manifest.levels];
	const levelEl = document.createElement("div");
	levelEl.className = "radio-group";
	renderRadioPills(levelEl, levelOptions, entry.level || "off", (v) => {
		entry.level = v;
	});
	card.appendChild(levelEl);

	const editBtn = document.createElement("button");
	editBtn.className = "vs-entry-edit-btn";
	editBtn.type = "button";
	editBtn.textContent = "Edit values per level";

	const paramPanel = document.createElement("div");
	paramPanel.className = "vs-param-panel";
	paramPanel.style.display = "none";
	renderVsParamPanel(paramPanel, manifest, entry);

	editBtn.onclick = () => {
		const open = paramPanel.style.display !== "none";
		paramPanel.style.display = open ? "none" : "";
		editBtn.classList.toggle("open", !open);
	};

	card.appendChild(editBtn);
	card.appendChild(paramPanel);
	return card;
}

function renderVsParamPanel(container, manifest, entry) {
	container.innerHTML = "";

	const grid = document.createElement("div");
	grid.className = "vs-param-grid";
	grid.style.gridTemplateColumns = `minmax(80px, auto) repeat(${manifest.levels.length}, 1fr)`;

	const corner = document.createElement("div");
	corner.className = "vs-param-header vs-param-header-corner";
	corner.textContent = "param";
	grid.appendChild(corner);
	for (const lvl of manifest.levels) {
		const h = document.createElement("div");
		h.className = "vs-param-header";
		h.textContent = lvl;
		grid.appendChild(h);
	}

	for (const spec of manifest.params) {
		const label = document.createElement("div");
		label.className = "vs-param-row-label";
		label.textContent = spec.label || spec.key;
		label.title = spec.key;
		grid.appendChild(label);

		for (const lvl of manifest.levels) {
			const cell = document.createElement("div");
			cell.className = "vs-param-cell";
			cell.appendChild(renderVsParamInput(spec, lvl, entry));
			grid.appendChild(cell);
		}

		if (spec.help) {
			const help = document.createElement("div");
			help.className = "vs-param-help";
			help.textContent = spec.help;
			grid.appendChild(help);
		}
	}

	container.appendChild(grid);
}

function renderVsParamInput(spec, level, entry) {
	entry.params = entry.params || {};
	entry.params[level] = entry.params[level] || {};
	const cur = entry.params[level][spec.key];

	if (spec.type === "bool") {
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.checked = !!cur;
		cb.onchange = () => {
			entry.params[level][spec.key] = cb.checked;
		};
		return cb;
	}

	if (spec.type === "enum") {
		const sel = document.createElement("select");
		for (const v of spec.enum) {
			const opt = document.createElement("option");
			opt.value = v;
			opt.textContent = v;
			if (v === cur) opt.selected = true;
			sel.appendChild(opt);
		}
		sel.onchange = () => {
			entry.params[level][spec.key] = sel.value;
		};
		return sel;
	}

	const input = document.createElement("input");
	input.type = "number";
	if (spec.min !== undefined) input.min = String(spec.min);
	if (spec.max !== undefined) input.max = String(spec.max);
	input.step = spec.step !== undefined ? String(spec.step) : spec.type === "int" ? "1" : "0.01";
	input.value = String(cur ?? spec.defaults[level]);
	input.onchange = () => {
		const n = parseFloat(input.value);
		if (!Number.isFinite(n)) return;
		const v = spec.type === "int" ? Math.round(n) : n;
		const clamped = clampToRange(v, spec.min, spec.max);
		entry.params[level][spec.key] = clamped;
		input.value = String(clamped);
	};
	return input;
}

function clampToRange(v, min, max) {
	if (typeof min === "number" && v < min) v = min;
	if (typeof max === "number" && v > max) v = max;
	return v;
}

async function fetchPreviewArtifactBlob(jobId, idx, kind) {
	const cacheKey = `${jobId}:${idx}:${kind}`;
	const cached = previewBlobCache.get(cacheKey);
	if (cached) return cached;
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview/sample/${idx}/${kind}`);
	if (!res.ok) throw new Error(`Failed to load ${kind} (${res.status})`);
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	previewBlobCache.set(cacheKey, url);
	return url;
}

function clearPreviewBlobCache() {
	for (const url of previewBlobCache.values()) URL.revokeObjectURL(url);
	previewBlobCache.clear();
}

async function openPreviewModal(jobId) {
	currentPreviewJobId = jobId;
	clearPreviewBlobCache();

	const jobsList = await fetchJobs();
	const job = jobsList.find((j) => j.id === jobId);
	if (!job) return;

	currentPreviewSettingsFingerprint = previewSettingsFingerprintFE(job.settings);

	document.getElementById("preview-modal-title").textContent = `Preview Encode — ${job.filename}`;
	document.getElementById("preview-modal").style.display = "";

	await refreshPreviewModal();
}

function closePreviewModal() {
	document.getElementById("preview-modal").style.display = "none";
	stopPreviewPolling();
	currentPreviewJobId = null;
	clearPreviewBlobCache();
}

function closePreviewModalIfOutside(e) {
	if (e.target === e.currentTarget) closePreviewModal();
}

function startPreviewPolling() {
	stopPreviewPolling();
	previewPollTimer = setInterval(refreshPreviewModal, 1000);
}

function stopPreviewPolling() {
	if (previewPollTimer) clearInterval(previewPollTimer);
	previewPollTimer = null;
}

async function refreshPreviewModal() {
	if (!currentPreviewJobId) return;
	try {
		const state = await fetchPreviewState(currentPreviewJobId);
		renderPreviewState(state);
		if (state.status !== "running") stopPreviewPolling();
	} catch (e) {
		if (e.message !== "Unauthorized") console.error("Preview poll error:", e);
	}
}

function renderPreviewState(state) {
	const introEl = document.getElementById("preview-intro");
	const statusEl = document.getElementById("preview-status");
	const errorEl = document.getElementById("preview-error");
	const samplesEl = document.getElementById("preview-samples");
	const staleEl = document.getElementById("preview-stale-banner");
	const runBtn = document.getElementById("preview-run-btn");
	const cancelBtn = document.getElementById("preview-cancel-btn");
	const clearBtn = document.getElementById("preview-clear-btn");

	const status = state?.status || "idle";
	const isRunning = status === "running";
	const hasResults = (state?.samples?.length || 0) > 0;
	const isFinished = status === "done" || status === "error" || status === "cancelled";

	const stale = state?.settingsFingerprint && state.settingsFingerprint !== currentPreviewSettingsFingerprint;
	staleEl.style.display = stale && hasResults ? "" : "none";

	introEl.style.display = status === "idle" ? "" : "none";

	if (isRunning) {
		statusEl.style.display = "";
		const pct = (state.progress || 0).toFixed(1);
		document.getElementById("preview-status-label").textContent = state.currentDetail || "Encoding…";
		document.getElementById("preview-status-pct").textContent = `${pct}%`;
		document.getElementById("preview-progress-fill").style.width = `${pct}%`;
		document.getElementById("preview-status-detail").textContent = `${state.samples?.length || 0} of ${state.sampleCount} samples done`;
	} else {
		statusEl.style.display = "none";
	}

	if (status === "error" && state.error) {
		errorEl.textContent = state.error;
		errorEl.style.display = "";
	} else {
		errorEl.style.display = "none";
	}

	if (hasResults) {
		samplesEl.style.display = "";
		renderPreviewSamples(state.jobId, state.samples);
	} else {
		samplesEl.style.display = "none";
	}

	runBtn.disabled = isRunning;
	runBtn.textContent = isFinished || hasResults ? "Re-run Preview" : "Run Preview";
	runBtn.style.display = isRunning ? "none" : "";
	cancelBtn.style.display = isRunning ? "" : "none";
	clearBtn.style.display = !isRunning && hasResults ? "" : "none";
}

function renderPreviewSamples(jobId, samples) {
	const container = document.getElementById("preview-samples");

	const desiredKey = samples.map((s) => s.index).join(",");
	if (container.dataset.renderedKey === desiredKey) return;
	container.dataset.renderedKey = desiredKey;
	container.innerHTML = "";

	for (const sample of samples) {
		const card = document.createElement("div");
		card.className = "preview-sample";
		card.dataset.idx = String(sample.index);
		card.dataset.viewing = "source";

		const ts = formatTimestamp(sample.timestampSec);
		const projected = sample.projectedTotalHuman || "—";
		const sizeStr = sample.encodedSizeHuman || "—";
		const bitrate = formatBitrate2(sample.encodedBitrateKbps);

		card.innerHTML = `
			<div class="preview-sample-image" data-action="toggle">
				<div class="preview-img-loading">Loading…</div>
				<img alt="Preview sample ${sample.index + 1}" style="display: none">
				<span class="preview-sample-tag is-source">Source</span>
				<button class="preview-fullscreen-btn" type="button" title="View fullscreen" aria-label="View preview sample fullscreen" data-action="fullscreen">
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
				</button>
				<span class="preview-sample-hint">Click to toggle</span>
			</div>
			<div class="preview-sample-meta">
				<div class="preview-sample-meta-row">
					<span class="meta-label">Sample ${sample.index + 1} · ${ts}</span>
					<span class="meta-value">${bitrate}</span>
				</div>
				<div class="preview-sample-meta-row">
					<span class="meta-label">Clip size</span>
					<span class="meta-value">${escapeHtml(sizeStr)}</span>
				</div>
				<div class="preview-sample-meta-row">
					<span class="meta-label">Projected total</span>
					<span class="meta-value">${escapeHtml(projected)}</span>
				</div>
				<div class="preview-sample-actions">
					<button class="btn btn-ghost" data-dl="source">Source</button>
					<button class="btn btn-ghost" data-dl="encode">Encode</button>
					<button class="btn btn-ghost" data-dl="clip">Clip</button>
				</div>
			</div>`;

		container.appendChild(card);

		(async () => {
			try {
				const sourceUrl = await fetchPreviewArtifactBlob(jobId, sample.index, "source");
				await fetchPreviewArtifactBlob(jobId, sample.index, "encode"); // warm cache
				const img = card.querySelector("img");
				img.src = sourceUrl;
				img.style.display = "";
				card.querySelector(".preview-img-loading").style.display = "none";
			} catch (e) {
				card.querySelector(".preview-img-loading").textContent = `Failed to load: ${e.message || e}`;
			}
		})();
	}
}

function formatTimestamp(sec) {
	const total = Math.floor(sec);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function setPreviewSampleView(card, view) {
	const jobId = currentPreviewJobId;
	const idx = parseInt(card.dataset.idx, 10);
	if (!jobId || !Number.isFinite(idx)) return;

	try {
		const url = await fetchPreviewArtifactBlob(jobId, idx, view);
		const img = card.querySelector("img");

		if (img) img.src = url;
		card.dataset.viewing = view;

		const label = view === "source" ? "Source" : "Encode";
		const tag = card.querySelector(".preview-sample-tag");
		if (tag) {
			tag.textContent = label;
			tag.classList.toggle("is-source", view === "source");
			tag.classList.toggle("is-encode", view === "encode");
		}

		if (currentPreviewFullscreenCard === card) {
			const fsImg = document.getElementById("preview-fullscreen-img");
			const fsTag = document.getElementById("preview-fullscreen-tag");
			if (fsImg) fsImg.src = url;
			if (fsTag) {
				fsTag.textContent = label;
				fsTag.classList.toggle("is-source", view === "source");
				fsTag.classList.toggle("is-encode", view === "encode");
			}
		}
	} catch (e) {
		console.error("Preview image switch failed:", e);
	}
}

async function togglePreviewSampleView(card) {
	const next = card.dataset.viewing === "source" ? "encode" : "source";
	await setPreviewSampleView(card, next);
}

async function openPreviewFullscreen(card) {
	if (!card) return;
	currentPreviewFullscreenCard = card;
	const idx = parseInt(card.dataset.idx, 10);
	const view = card.dataset.viewing || "source";
	const modal = document.getElementById("preview-fullscreen-modal");
	const title = document.getElementById("preview-fullscreen-title");
	const img = document.getElementById("preview-fullscreen-img");
	const loading = document.getElementById("preview-fullscreen-loading");

	if (!modal || !title || !img || !loading) return;

	title.textContent = `Preview sample ${idx + 1}`;
	img.style.display = "none";
	loading.style.display = "";
	loading.textContent = "Loading…";
	modal.style.display = "";

	try {
		const url = await fetchPreviewArtifactBlob(currentPreviewJobId, idx, view);
		img.src = url;
		img.style.display = "";
		loading.style.display = "none";
		await setPreviewSampleView(card, view);
	} catch (e) {
		loading.textContent = `Failed to load: ${e.message || e}`;
	}
}

function closePreviewFullscreen() {
	const modal = document.getElementById("preview-fullscreen-modal");
	if (modal) modal.style.display = "none";
	currentPreviewFullscreenCard = null;
}

function closePreviewFullscreenIfOutside(e) {
	if (e.target === e.currentTarget) closePreviewFullscreen();
}

async function downloadPreviewSampleArtifact(jobId, idx, kind) {
	try {
		const url = await fetchPreviewArtifactBlob(jobId, idx, kind);
		const a = document.createElement("a");
		a.href = url;
		const ext = kind === "clip" ? "mkv" : "png";
		const role = kind === "clip" ? "clip" : `${kind}-frame`;
		a.download = `preview-${role}-sample${idx + 1}.${ext}`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} catch (e) {
		console.error("Download failed:", e);
	}
}

async function handlePreviewRun() {
	if (!currentPreviewJobId) return;
	const runBtn = document.getElementById("preview-run-btn");
	runBtn.disabled = true;
	runBtn.textContent = "Starting…";
	clearPreviewBlobCache();
	const samplesEl = document.getElementById("preview-samples");
	if (samplesEl) samplesEl.dataset.renderedKey = "";

	try {
		const result = await startPreviewRequest(currentPreviewJobId);
		if (result.error) {
			document.getElementById("preview-error").textContent = result.error;
			document.getElementById("preview-error").style.display = "";
			runBtn.disabled = false;
			runBtn.textContent = "Run Preview";
			return;
		}
		renderPreviewState(result);
		startPreviewPolling();
	} catch (e) {
		document.getElementById("preview-error").textContent = `Failed to start: ${e.message || e}`;
		document.getElementById("preview-error").style.display = "";
		runBtn.disabled = false;
		runBtn.textContent = "Run Preview";
	}
}

async function handlePreviewCancel() {
	if (!currentPreviewJobId) return;
	const cancelBtn = document.getElementById("preview-cancel-btn");
	cancelBtn.disabled = true;
	try {
		await cancelPreviewRequest(currentPreviewJobId);
		await refreshPreviewModal();
	} catch (e) {
		console.error("Cancel failed:", e);
	} finally {
		cancelBtn.disabled = false;
	}
}

async function handlePreviewClear() {
	if (!currentPreviewJobId) return;
	try {
		await cancelPreviewRequest(currentPreviewJobId);
		clearPreviewBlobCache();
		const samplesEl = document.getElementById("preview-samples");
		samplesEl.dataset.renderedKey = "";
		await refreshPreviewModal();
	} catch (e) {
		console.error("Clear failed:", e);
	}
}

function getMinQueueOrder(node) {
	let min = Infinity;
	for (const job of node.jobs) {
		if (job.status === "queued" && job.queueOrder < min) min = job.queueOrder;
	}
	for (const child of node.children.values()) {
		const childMin = getMinQueueOrder(child);
		if (childMin < min) min = childMin;
	}
	return min;
}

function sortNodeChildren(children) {
	return [...children].sort((a, b) => {
		const aMin = getMinQueueOrder(a);
		const bMin = getMinQueueOrder(b);
		if (aMin === Infinity && bMin === Infinity) return a.name.localeCompare(b.name);
		if (aMin === Infinity) return 1;
		if (bMin === Infinity) return -1;
		return aMin - bMin;
	});
}

function collectAllQueuedJobs(node) {
	const result = [];
	for (const child of node.children.values()) {
		result.push(...collectAllQueuedJobs(child));
	}
	for (const job of node.jobs) {
		if (job.status === "queued") {
			result.push(job);
		}
	}
	return result;
}

function collectQueuedIdsInOrder(node) {
	const ids = [];

	const sorted = sortNodeChildren(Array.from(node.children.values()));
	for (const child of sorted) {
		ids.push(...collectQueuedIdsInOrder(child));
	}

	const sortedJobs = [...node.jobs].sort((a, b) => a.queueOrder - b.queueOrder);
	for (const job of sortedJobs) {
		if (job.status === "queued") {
			ids.push(job.id);
		}
	}

	return ids;
}

function findFolderByPath(node, folderPath) {
	if (node.fullPath === folderPath) return node;
	for (const child of node.children.values()) {
		const found = findFolderByPath(child, folderPath);
		if (found) return found;
	}
	return null;
}

function findParentOfFolder(node, folderPath) {
	for (const child of node.children.values()) {
		if (child.fullPath === folderPath) return node;
		const found = findParentOfFolder(child, folderPath);
		if (found) return found;
	}
	return null;
}

async function handleMove(targetPath, direction, isFile, jobId) {
	const jobs = await fetchJobs();
	const tree = buildFolderTree(jobs);

	if (isFile) {
		const folder = findFolderByPath(tree, targetPath);
		if (!folder) return;

		const queuedJobs = folder.jobs.filter((j) => j.status === "queued").sort((a, b) => a.queueOrder - b.queueOrder);

		const idx = queuedJobs.findIndex((j) => j.id === jobId);
		if (idx === -1) return;

		if (direction === "up" && idx > 0) {
			const tmp = queuedJobs[idx];
			queuedJobs[idx] = queuedJobs[idx - 1];
			queuedJobs[idx - 1] = tmp;
		} else if (direction === "down" && idx < queuedJobs.length - 1) {
			const tmp = queuedJobs[idx];
			queuedJobs[idx] = queuedJobs[idx + 1];
			queuedJobs[idx + 1] = tmp;
		} else {
			return;
		}

		const orders = queuedJobs.map((j) => j.queueOrder).sort((a, b) => a - b);
		for (let i = 0; i < queuedJobs.length; i++) {
			queuedJobs[i].queueOrder = orders[i];
		}
	} else {
		const parent = findParentOfFolder(tree, targetPath);
		if (!parent) return;

		const siblings = sortNodeChildren(Array.from(parent.children.values()));
		const idx = siblings.findIndex((n) => n.fullPath === targetPath);
		if (idx === -1) return;

		let otherIdx;
		if (direction === "up" && idx > 0) {
			otherIdx = idx - 1;
		} else if (direction === "down" && idx < siblings.length - 1) {
			otherIdx = idx + 1;
		} else {
			return;
		}

		const jobsA = collectAllQueuedJobs(siblings[idx]).sort((a, b) => a.queueOrder - b.queueOrder);
		const jobsB = collectAllQueuedJobs(siblings[otherIdx]).sort((a, b) => a.queueOrder - b.queueOrder);

		if (jobsA.length === 0 && jobsB.length === 0) return;

		const allOrders = [...jobsA, ...jobsB].map((j) => j.queueOrder).sort((a, b) => a - b);

		const first = direction === "up" ? jobsA : jobsB;
		const second = direction === "up" ? jobsB : jobsA;

		let i = 0;
		for (const job of first) {
			job.queueOrder = allOrders[i++];
		}
		for (const job of second) {
			job.queueOrder = allOrders[i++];
		}
	}

	const orderedIds = collectQueuedIdsInOrder(tree);
	await reorderQueue(orderedIds);
	lastJobsJson = "";
	update();
}

function renderRadioPills(container, options, selected, onChange) {
	container.innerHTML = "";
	options.forEach((opt) => {
		const pill = document.createElement("div");
		pill.className = `radio-pill${opt === selected ? " selected" : ""}`;
		pill.textContent = opt;
		pill.onclick = () => {
			container.querySelectorAll(".radio-pill").forEach((p) => p.classList.remove("selected"));
			pill.classList.add("selected");
			onChange(opt);
		};
		container.appendChild(pill);
	});
}

function renderGpuDevicePicker(container, devices, selectedId, onChange) {
	container.innerHTML = "";
	if (!devices || devices.length === 0) {
		container.style.display = "none";
		return;
	}
	container.style.display = "";
	if (devices.length === 1) {
		const d = devices[0];
		const info = document.createElement("div");
		info.className = "gpu-device-info";
		info.textContent = `Device: ${d.deviceName.split("(")[0].trim()} (${d.id})`;
		container.appendChild(info);
		// ensure config still carries the id
		if (selectedId !== d.id) onChange(d.id);
		return;
	}
	for (const d of devices) {
		const label = document.createElement("label");
		label.className = "radio-pill";
		const input = document.createElement("input");
		input.type = "radio";
		input.name = container.id + "-radio";
		input.value = d.id;
		input.checked = d.id === selectedId;
		input.onchange = () => onChange(d.id);
		const text = document.createElement("span");
		text.textContent = `${d.deviceName.split("(")[0].trim()} (${d.id})`;
		label.appendChild(input);
		label.appendChild(text);
		container.appendChild(label);
	}
}

function renderAutoThresholds(container, thresholds, onChange) {
	container.innerHTML = "";
	const wrap = document.createElement("div");
	wrap.className = "auto-threshold-grid";
	for (const key of ["light", "medium", "heavy"]) {
		const label = document.createElement("label");
		label.className = "auto-threshold-row";
		const span = document.createElement("span");
		span.textContent = key;
		const input = document.createElement("input");
		input.type = "number";
		input.step = "0.01";
		input.min = "0";
		input.max = "1";
		input.value = thresholds[key];
		input.onchange = () => {
			const v = clampFloat(input.value, 0, 1);
			thresholds[key] = v;
			input.value = v;
			onChange({ ...thresholds });
		};
		label.appendChild(span);
		label.appendChild(input);
		wrap.appendChild(label);
	}
	container.appendChild(wrap);
}

function renderBitrateInputs(container, bitrates, onChange) {
	container.innerHTML = "";
	CHANNELS.forEach((ch) => {
		const field = document.createElement("div");
		field.className = "bitrate-field";
		field.innerHTML = `
      <span>${ch.label}</span>
      <input type="number" min="32" max="1024" step="16" value="${bitrates[ch.key] || 128}" data-ch="${ch.key}">
    `;
		field.querySelector("input").oninput = (e) => {
			onChange(ch.key, parseInt(e.target.value) || 128);
		};
		container.appendChild(field);
	});
}

function statusLabel(status) {
	const labels = {
		queued: "Queued",
		probing: "Analyzing",
		encoding_video: "Video",
		encoding_audio: "Audio",
		muxing: "Muxing",
		done: "Done",
		error: "Error",
		cancelled: "Cancelled",
	};
	return labels[status] || status;
}

function isActive(status) {
	return ["probing", "encoding_video", "encoding_audio", "muxing"].includes(status);
}

function formatDuration(ms) {
	const sec = Math.floor(ms / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatDurationShort(ms) {
	const sec = Math.floor(ms / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function clampInt(v, min, max) {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, n));
}

function forceOdd(n) {
	return n % 2 === 0 ? n + 1 : n;
}

function clampFloat(v, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, n));
}

function computeStepElapsed(step) {
	if (!step.startedAt) return null;
	const end = step.finishedAt || Date.now();
	return end - step.startedAt;
}

function computeStepETA(step) {
	if (!step.startedAt || step.status !== "active" || step.progress <= 0) return null;
	const elapsed = Date.now() - step.startedAt;
	if (elapsed < 3000) return null;
	const totalEstimated = (elapsed / step.progress) * 100;
	const remaining = totalEstimated - elapsed;
	return remaining > 0 ? remaining : null;
}

function renderStepTime(step) {
	if (step.status === "done" && step.startedAt) {
		const elapsed = computeStepElapsed(step);
		return `<span class="step-time step-time-done">${formatDurationShort(elapsed)}</span>`;
	}
	if (step.status === "active" && step.startedAt) {
		const elapsed = computeStepElapsed(step);
		const eta = computeStepETA(step);
		let timeStr = formatDurationShort(elapsed);
		if (eta !== null) {
			timeStr += ` · ~${formatDurationShort(eta)} left`;
		}
		return `<span class="step-time step-time-active">${timeStr}</span>`;
	}
	return "";
}

async function openSubtitlePreview(jobId) {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	document.getElementById("sub-preview-title").textContent = `Subtitles — ${job.filename}`;
	document.getElementById("sub-preview-loading").style.display = "";
	document.getElementById("sub-preview-error").style.display = "none";
	document.getElementById("sub-preview-content").style.display = "none";
	document.getElementById("sub-preview-modal").style.display = "";

	try {
		const res = await authFetch(`${API}/api/jobs/${jobId}/subtitle-preview`);
		const data = await res.json();

		if (data.error) {
			document.getElementById("sub-preview-loading").style.display = "none";
			document.getElementById("sub-preview-error").textContent = data.error;
			document.getElementById("sub-preview-error").style.display = "";
			return;
		}

		renderSubtitlePreview(data);
	} catch (err) {
		document.getElementById("sub-preview-loading").style.display = "none";
		document.getElementById("sub-preview-error").textContent = `Failed: ${err.message || err}`;
		document.getElementById("sub-preview-error").style.display = "";
	}
}

async function openMediaInfo(jobId) {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	document.getElementById("mediainfo-title").textContent = `Media Info — ${job.filename}`;
	document.getElementById("mediainfo-loading").style.display = "";
	document.getElementById("mediainfo-error").style.display = "none";
	document.getElementById("mediainfo-content").style.display = "none";
	document.getElementById("mediainfo-modal").style.display = "";

	try {
		const res = await authFetch(`${API}/api/jobs/${jobId}/mediainfo`);
		const data = await res.json();
		document.getElementById("mediainfo-loading").style.display = "none";
		if (data.error) {
			const el = document.getElementById("mediainfo-error");
			el.textContent = data.error;
			el.style.display = "";
			return;
		}
		const pre = document.getElementById("mediainfo-content");
		pre.textContent = data.text;
		pre.style.display = "";
	} catch (err) {
		document.getElementById("mediainfo-loading").style.display = "none";
		const el = document.getElementById("mediainfo-error");
		el.textContent = `Failed: ${err.message || err}`;
		el.style.display = "";
	}
}

function closeMediaInfo() {
	document.getElementById("mediainfo-modal").style.display = "none";
}

async function openAudioPreview(jobId) {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	document.getElementById("audio-preview-title").textContent = `Audio — ${job.filename}`;
	document.getElementById("audio-preview-loading").style.display = "";
	document.getElementById("audio-preview-error").style.display = "none";
	document.getElementById("audio-preview-content").style.display = "none";
	document.getElementById("audio-preview-modal").style.display = "";

	try {
		const res = await authFetch(`${API}/api/jobs/${jobId}/audio-preview`);
		const data = await res.json();

		if (data.error) {
			document.getElementById("audio-preview-loading").style.display = "none";
			document.getElementById("audio-preview-error").textContent = data.error;
			document.getElementById("audio-preview-error").style.display = "";
			return;
		}

		renderAudioPreview(data);
	} catch (err) {
		document.getElementById("audio-preview-loading").style.display = "none";
		document.getElementById("audio-preview-error").textContent = `Failed: ${err.message || err}`;
		document.getElementById("audio-preview-error").style.display = "";
	}
}

function renderAudioPreview(data) {
	document.getElementById("audio-preview-loading").style.display = "none";
	document.getElementById("audio-preview-content").style.display = "";

	document.getElementById("audio-preview-source").innerHTML =
		data.source.length > 0 ? data.source.map((t) => renderAudioTrack(t, false)).join("") : '<div class="sub-track"><em>No audio tracks</em></div>';

	document.getElementById("audio-preview-output").innerHTML =
		data.output.length > 0 ? data.output.map((t) => renderAudioTrack(t, true)).join("") : '<div class="sub-track"><em>No audio tracks</em></div>';
}

function formatBitrate(raw) {
	if (raw === undefined || raw === null) return "";
	// Probe may return bps or kbps - normalize.
	const kbps = raw >= 10000 ? Math.round(raw / 1000) : Math.round(raw);
	return `${kbps} kbps`;
}

function formatBitrate2(kbps) {
	if (!kbps) return "—";

	if (kbps >= 1000) {
		return `${(kbps / 1000).toFixed(2)} Mbps`;
	}

	return `${kbps} kbps`;
}

function renderAudioTrack(track, isOutput) {
	const badges = [];
	if (track.isDefault) badges.push('<span class="sub-badge sub-badge-default">Default</span>');
	if (track.isOriginal) badges.push('<span class="sub-badge sub-badge-forced">Original</span>');
	if (track.trackType === "commentary") badges.push('<span class="sub-badge sub-badge-commentary">Commentary</span>');
	if (track.trackType === "descriptive") badges.push('<span class="sub-badge sub-badge-hi">Descriptive</span>');
	badges.push(`<span class="sub-badge sub-badge-type">${escapeHtml(track.channelLayout)}</span>`);

	const name = track.title || track.trackType;
	const bitrate = isOutput ? formatBitrate(track.outputBitrate * 1000) : formatBitrate(track.bitrate);

	return `
		<div class="sub-track">
			<div class="sub-track-top">
				<span class="sub-track-flag">${track.flag}</span>
				<span class="sub-track-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
				<span class="sub-track-lang">${escapeHtml(track.language)}</span>
				<span class="sub-track-codec">${escapeHtml(track.codec)}${bitrate ? " · " + bitrate : ""}</span>
			</div>
			<div class="sub-track-badges">${badges.join("")}</div>
		</div>`;
}

function closeAudioPreview() {
	document.getElementById("audio-preview-modal").style.display = "none";
}

function closeAudioPreviewIfOutside(e) {
	if (e.target === e.currentTarget) closeAudioPreview();
}

function renderSubtitlePreview(data) {
	document.getElementById("sub-preview-loading").style.display = "none";
	document.getElementById("sub-preview-content").style.display = "";

	document.getElementById("sub-preview-source").innerHTML =
		data.source.length > 0 ? data.source.map((t) => renderSubTrack(t, false)).join("") : '<div class="sub-track"><em>No subtitle tracks</em></div>';

	document.getElementById("sub-preview-output").innerHTML =
		data.output.length > 0
			? data.output
					.map((t, i) => {
						// Highlight changes
						const src = data.source.find((s) => s.index === t.index);
						const changed = src && (src.language !== t.language || src.trackName !== t.trackName || data.source.indexOf(src) !== i);
						return renderSubTrack(t, changed);
					})
					.join("")
			: '<div class="sub-track"><em>No subtitle tracks</em></div>';
}

function renderSubTrack(track, highlight) {
	const badges = [];
	if (track.isDefault) badges.push('<span class="sub-badge sub-badge-default">Default</span>');
	if (track.isForced) badges.push('<span class="sub-badge sub-badge-forced">Forced</span>');
	if (track.isHearingImpaired) badges.push('<span class="sub-badge sub-badge-hi">HI</span>');
	if (track.isCommentary) badges.push('<span class="sub-badge sub-badge-commentary">Commentary</span>');
	badges.push(`<span class="sub-badge sub-badge-type">${escapeHtml(track.trackType)}</span>`);

	return `
    <div class="sub-track${highlight ? " sub-track-changed" : ""}">
      <div class="sub-track-top">
        <span class="sub-track-flag">${track.flag}</span>
        <span class="sub-track-name" title="${escapeHtml(track.trackName)}">${escapeHtml(track.trackName)}</span>
        <span class="sub-track-lang">${escapeHtml(track.language)}</span>
        <span class="sub-track-codec">${escapeHtml(track.codec)}</span>
      </div>
      <div class="sub-track-badges">${badges.join("")}</div>
    </div>`;
}

function closeSubPreview() {
	document.getElementById("sub-preview-modal").style.display = "none";
}

function closeSubPreviewIfOutside(e) {
	if (e.target === e.currentTarget) closeSubPreview();
}

function renderSteps(steps) {
	if (!steps || steps.length === 0) return "";

	const stepsHtml = steps
		.map((step) => {
			const statusIcon = step.status === "done" ? "✓" : step.status === "active" ? "›" : step.status === "error" ? "✗" : "·";

			const statusClass = `step-${step.status}`;
			const pctStr = step.status === "active" ? `${step.progress.toFixed(2)}%` : step.status === "done" ? "100%" : "";

			const detail = step.detail && step.status === "active" ? `<span class="step-detail">${escapeHtml(step.detail)}</span>` : "";

			const timeHtml = renderStepTime(step);

			let progressBar = "";
			if (step.status === "active") {
				progressBar = `<div class="step-bar"><div class="step-bar-fill" style="width:${step.progress}%"></div></div>`;
			}

			return `
      <div class="step ${statusClass}">
        <div class="step-head">
          <span class="step-icon">${statusIcon}</span>
          <span class="step-label">${escapeHtml(step.label)}</span>
          <span class="step-pct">${pctStr}</span>
          ${timeHtml}
        </div>
        ${progressBar}
        ${detail}
      </div>`;
		})
		.join("");

	return `<div class="steps-pipeline">${stepsHtml}</div>`;
}

function renderJobCard(job) {
	const active = isActive(job.status);
	const done = job.status === "done";
	const err = job.status === "error";

	let meta = "";
	if (job.probe) {
		meta += `<span>${job.probe.width}x${job.probe.height}</span>`;
		meta += `<span>${job.probe.audioLayout}</span>`;
		if (job.probe.isHDR) meta += `<span>HDR</span>`;
		if (job.probe.duration) meta += `<span>${formatDuration(job.probe.duration * 1000)}</span>`;
	}
	meta += `<span>${job.settings.quality} · ${job.settings.finalSpeed}${job.settings.downscale ? " · ↓1080p" : ""}</span>`;
	if (job.settings.skipBoosting) meta += `<span>No Boost</span>`;

	const stepsHtml = active || done || err ? renderSteps(job.steps) : "";

	let result = "";
	if (done) {
		const elapsed = job.finishedAt && job.startedAt ? formatDuration(job.finishedAt - job.startedAt) : "—";
		result = `
      <div class="job-result">
        <span>Size: ${job.encodedFileSize || "—"}</span>
        <span>Time: ${elapsed}</span>
        <span>Output: ${job.outputFilename || "—"}</span>
      </div>`;
	}

	let error = "";
	if (err && job.error) {
		error = `<div class="job-error">${escapeHtml(job.error)}</div>`;
	}

	const infoBtn = `<button class="btn-icon" title="Media info" data-job-id="${job.id}" data-action="mediainfo">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
	</button>`;

	const audioBtn = `<button class="btn-icon" title="Preview Audio" data-job-id="${job.id}" data-action="audio-preview">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
			<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
		</svg>
	</button>`;

	const subBtn = `<button class="btn-icon" title="Preview Subtitles" data-job-id="${job.id}" data-action="sub-preview">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  </button>`;

	const previewBtn = `<button class="btn-icon" title="Preview Encode" data-job-id="${job.id}" data-action="preview">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  </button>`;

	let actions = "";
	if (job.status === "queued") {
		actions = `
      <div class="move-buttons" data-move-type="file" data-move-job="${job.id}">
        <button class="btn-icon btn-move" title="Move up" data-action="move-up">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="btn-icon btn-move" title="Move down" data-action="move-down">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
			${infoBtn}
			${audioBtn}
			${subBtn}
			${previewBtn}
      <button class="btn-icon" title="Settings" data-job-id="${job.id}" data-action="edit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </button>
      <button class="btn-icon" title="Remove" data-job-id="${job.id}" data-action="remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
	} else if (active) {
		actions = `
			${infoBtn}
			${audioBtn}
			${subBtn}
			${previewBtn}
      <button class="btn-icon btn-cancel" title="Cancel" data-job-id="${job.id}" data-action="cancel">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
      </button>`;
	} else if (err) {
		actions = `
			${infoBtn}
			${audioBtn}
			${subBtn}
			${previewBtn}
      <button class="btn-icon" title="Retry" data-job-id="${job.id}" data-action="retry">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
      <button class="btn-icon" title="Remove" data-job-id="${job.id}" data-action="remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
	} else if (done) {
		actions = `
      <button class="btn-icon" title="Dismiss" data-job-id="${job.id}" data-action="dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      </button>`;
	}

	return `
    <div class="job-card ${active ? "is-active" : ""} ${done ? "is-done" : ""}" id="job-${job.id}">
      <div class="job-top">
        <div class="job-info">
          <div class="job-filename" title="${escapeHtml(job.filename)}">${escapeHtml(job.filename)}</div>
          <div class="job-meta">${meta}</div>
        </div>
        <div class="job-actions">
          <span class="status-badge status-${job.status}">${statusLabel(job.status)}</span>
          ${actions}
        </div>
      </div>
      ${stepsHtml}
      ${result}
      ${error}
    </div>`;
}

function buildFolderTree(jobs) {
	const root = { name: "", fullPath: "", children: new Map(), jobs: [] };

	for (const job of jobs) {
		let parts = [];

		if (job.replaceSource && job.inputPath) {
			// Library job: derive full folder hierarchy from inputPath
			const lastSlash = job.inputPath.lastIndexOf("/");
			const dir = lastSlash > 0 ? job.inputPath.substring(1, lastSlash) : "";
			parts = dir ? dir.split("/") : [];
		} else {
			// Regular job: use relativePath
			const rel = job.relativePath || "";
			parts = rel ? rel.split(/[/\\]/) : [];
		}

		if (parts.length === 0) {
			root.jobs.push(job);
			continue;
		}

		let current = root;
		let pathSoFar = "";

		for (const part of parts) {
			pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					fullPath: pathSoFar,
					children: new Map(),
					jobs: [],
				});
			}
			current = current.children.get(part);
		}

		current.jobs.push(job);
	}

	return root;
}

function collectAllJobs(node) {
	let all = [...node.jobs];
	for (const child of node.children.values()) {
		all = all.concat(collectAllJobs(child));
	}
	return all;
}

function computeFolderStats(node) {
	const allJobs = collectAllJobs(node);
	const total = allJobs.length;
	const done = allJobs.filter((j) => j.status === "done").length;
	const encoding = allJobs.filter((j) => isActive(j.status)).length;
	const queued = allJobs.filter((j) => j.status === "queued").length;
	const error = allJobs.filter((j) => j.status === "error").length;
	return { total, done, encoding, queued, error };
}

function folderHasActive(node) {
	return collectAllJobs(node).some((j) => isActive(j.status));
}

function computeFolderTimeEstimate(node) {
	const allJobs = collectAllJobs(node);

	const doneJobs = allJobs.filter((j) => j.status === "done" && j.startedAt && j.finishedAt);
	const activeJobs = allJobs.filter((j) => isActive(j.status));
	const queuedJobs = allJobs.filter((j) => j.status === "queued");

	if (doneJobs.length === 0 && activeJobs.length === 0) return null;

	// Total elapsed time for completed jobs
	const totalElapsed = doneJobs.reduce((sum, j) => sum + (j.finishedAt - j.startedAt), 0);

	// Average encode time per episode
	const avgPerEpisode = doneJobs.length > 0 ? totalElapsed / doneJobs.length : null;

	// Try duration-weighted estimation
	let useDurationWeighted = false;
	let encodeRatio = null;

	const doneWithDuration = doneJobs.filter((j) => j.probe && j.probe.duration > 0);
	if (doneWithDuration.length > 0) {
		const totalEncode = doneWithDuration.reduce((sum, j) => sum + (j.finishedAt - j.startedAt), 0);
		const totalDuration = doneWithDuration.reduce((sum, j) => sum + j.probe.duration * 1000, 0);
		encodeRatio = totalEncode / totalDuration;
		useDurationWeighted = true;
	}

	// Estimate remaining time for queued jobs
	let queuedEstimate = 0;
	if (queuedJobs.length > 0) {
		if (useDurationWeighted) {
			const queuedWithDuration = queuedJobs.filter((j) => j.probe && j.probe.duration > 0);
			const queuedWithoutDuration = queuedJobs.length - queuedWithDuration.length;
			queuedEstimate += queuedWithDuration.reduce((sum, j) => sum + j.probe.duration * 1000 * encodeRatio, 0);
			if (queuedWithoutDuration > 0 && avgPerEpisode) {
				queuedEstimate += queuedWithoutDuration * avgPerEpisode;
			}
		} else if (avgPerEpisode) {
			queuedEstimate = queuedJobs.length * avgPerEpisode;
		}
	}

	// Estimate remaining time for active jobs
	let activeRemaining = 0;
	for (const job of activeJobs) {
		if (job.startedAt && job.progress > 0) {
			const elapsed = Date.now() - job.startedAt;
			if (elapsed > 3000) {
				const totalEstimated = (elapsed / job.progress) * 100;
				const remaining = totalEstimated - elapsed;
				activeRemaining += Math.max(0, remaining);
			}
		} else if (avgPerEpisode) {
			activeRemaining += avgPerEpisode;
		} else if (useDurationWeighted && job.probe && job.probe.duration > 0) {
			activeRemaining += job.probe.duration * 1000 * encodeRatio;
		}
	}

	let activeElapsed = 0;
	for (const job of activeJobs) {
		if (job.startedAt) {
			activeElapsed += Date.now() - job.startedAt;
		}
	}

	const estimatedRemaining = activeRemaining + queuedEstimate;
	const estimatedTotal = totalElapsed + activeElapsed + estimatedRemaining;
	const remainingCount = activeJobs.length + queuedJobs.length;

	return {
		totalElapsed,
		estimatedRemaining,
		estimatedTotal,
		avgPerEpisode,
		doneCount: doneJobs.length,
		remainingCount,
	};
}

function renderFolderTimeEstimate(node) {
	const est = computeFolderTimeEstimate(node);
	if (!est) {
		return `<div class="folder-time-estimate folder-time-pending">Estimated after 1st encode</div>`;
	}

	const parts = [];

	if (est.remainingCount > 0 && est.doneCount > 0) {
		// Still encoding (show estimated total and remaining)
		parts.push(`~${formatDurationShort(est.estimatedTotal)} total`);
		parts.push(`~${formatDurationShort(est.estimatedRemaining)} remaining`);
	} else if (est.remainingCount === 0 && est.doneCount > 0) {
		// All done (show actual total time)
		parts.push(`Total: ${formatDurationShort(est.totalElapsed)}`);
	}

	if (est.avgPerEpisode && est.doneCount > 0) {
		parts.push(`${formatDurationShort(est.avgPerEpisode)} avg/ep`);
	}

	if (parts.length === 0) return `<div class="folder-time-estimate folder-time-pending">Estimated after 1st encode</div>`;

	return `<div class="folder-time-estimate">${parts.join(" · ")}</div>`;
}

function renderFolderStats(stats) {
	const parts = [];

	parts.push(`<span class="folder-stat folder-stat-total">${stats.total} file${stats.total !== 1 ? "s" : ""}</span>`);

	if (stats.encoding > 0) {
		parts.push(`<span class="folder-stat folder-stat-encoding">${stats.encoding} encoding</span>`);
	}
	if (stats.queued > 0) {
		parts.push(`<span class="folder-stat folder-stat-queued">${stats.queued} queued</span>`);
	}
	if (stats.done > 0) {
		parts.push(`<span class="folder-stat folder-stat-done">${stats.done} done</span>`);
	}
	if (stats.error > 0) {
		parts.push(`<span class="folder-stat folder-stat-error">${stats.error} error</span>`);
	}

	return parts.join("");
}

function renderFolderProgress(stats) {
	if (stats.total === 0) return "";
	const pct = Math.round((stats.done / stats.total) * 100);
	return `<div class="folder-progress"><div class="folder-progress-fill" style="width:${pct}%"></div></div>`;
}

function renderFolderNode(node, depth) {
	const isExpanded = expandedFolders.has(node.fullPath);
	const stats = computeFolderStats(node);
	const hasActive = folderHasActive(node);
	const allDone = stats.total > 0 && stats.done === stats.total;

	const chevronSvg = `<svg class="folder-chevron ${isExpanded ? "expanded" : ""}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;

	const folderIconSvg = `<svg class="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

	let html = `
    <div class="folder-node ${hasActive ? "folder-active" : ""} ${allDone ? "folder-done" : ""}" style="--depth:${depth}">
      <div class="folder-header" data-folder-path="${escapeHtml(node.fullPath)}">
				<div class="folder-left">
					${chevronSvg}
					${folderIconSvg}
					<span class="folder-name">${escapeHtml(node.name)}</span>
					<div class="move-buttons" data-move-type="folder" data-move-path="${escapeHtml(node.fullPath)}">
						<button class="btn-icon btn-move" title="Move up" data-action="move-up">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
						</button>
						<button class="btn-icon btn-move" title="Move down" data-action="move-down">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
						</button>
					</div>
				</div>
        <div class="folder-right">
          <div class="folder-stats">${renderFolderStats(stats)}</div>
          ${renderFolderProgress(stats)}
          ${renderFolderTimeEstimate(node)}
        </div>
      </div>`;

	if (isExpanded) {
		html += `<div class="folder-children">`;

		const sortedChildren = sortNodeChildren(Array.from(node.children.values()));
		for (const child of sortedChildren) {
			html += renderFolderNode(child, depth + 1);
		}

		const sortedJobs = [...node.jobs].sort((a, b) => a.queueOrder - b.queueOrder);
		for (const job of sortedJobs) {
			html += `<div class="folder-job" style="--depth:${depth + 1}" data-containing-folder="${escapeHtml(node.fullPath)}">${renderJobCard(job)}</div>`;
		}

		html += `</div>`;
	}

	html += `</div>`;
	return html;
}

function renderJobsList(jobs) {
	const tree = buildFolderTree(jobs);
	let html = "";

	const sortedFolders = sortNodeChildren(Array.from(tree.children.values()));
	for (const folder of sortedFolders) {
		html += renderFolderNode(folder, 0);
	}

	for (const job of tree.jobs) {
		html += renderJobCard(job);
	}

	return html;
}

function escapeHtml(s) {
	const d = document.createElement("div");
	d.textContent = s;
	return d.innerHTML;
}

let lastJobsJson = "";

function updatePauseUI() {
	const btn = document.getElementById("pause-queue-btn");
	const pauseIcon = document.getElementById("pause-icon");
	const resumeIcon = document.getElementById("resume-icon");
	const label = document.getElementById("pause-label");
	const banner = document.getElementById("queue-paused-banner");

	if (queuePaused) {
		pauseIcon.style.display = "none";
		resumeIcon.style.display = "";
		label.textContent = "Continue";
		btn.classList.add("btn-paused");
		banner.style.display = "";
	} else {
		pauseIcon.style.display = "";
		resumeIcon.style.display = "none";
		label.textContent = "Pause";
		btn.classList.remove("btn-paused");
		banner.style.display = "none";
	}
}

async function handlePauseToggle() {
	const btn = document.getElementById("pause-queue-btn");
	btn.disabled = true;
	try {
		if (queuePaused) {
			await resumeQueueRequest();
		} else {
			await pauseQueueRequest();
		}
		lastJobsJson = ""; // force re-render
		await update();
	} catch (e) {
		console.error("Pause toggle failed:", e);
	} finally {
		btn.disabled = false;
	}
}

async function update() {
	try {
		const [jobs, queueState] = await Promise.all([fetchJobs(), fetchQueueState().catch(() => ({ paused: false }))]);

		queuePaused = !!queueState.paused;

		const hashKey = JSON.stringify({ j: jobs, p: queuePaused });
		const hasActive = jobs.some((j) => isActive(j.status));

		updatePauseUI();

		if (hashKey === lastJobsJson && !hasActive) return;
		lastJobsJson = hashKey;

		const emptyEl = document.getElementById("empty-state");
		const listEl = document.getElementById("jobs-list");

		if (jobs.length === 0) {
			emptyEl.style.display = "";
			listEl.style.display = "none";
			return;
		}

		emptyEl.style.display = "none";
		listEl.style.display = "";
		listEl.innerHTML = renderJobsList(jobs);
	} catch (e) {
		if (e.message === "Unauthorized") return;
		console.error("Poll error:", e);
	}
}

function startPolling() {
	stopPolling();
	update();
	pollTimer = setInterval(update, 1500);
}

function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

async function openSettings() {
	if (!defaults) defaults = await fetchConfig();

	const tempDefaults = {
		...defaults,
		audioBitrates: { ...defaults.audioBitrates },
		// Deep-clone nested objects so cancel actually cancels.
		autoDenoiseThresholds: { ...(defaults.autoDenoiseThresholds || DEFAULT_AUTO_THRESHOLDS) },
		nlmeansParams: defaults.nlmeansParams ? JSON.parse(JSON.stringify(defaults.nlmeansParams)) : JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS)),
		gradfunParams: defaults.gradfunParams ? JSON.parse(JSON.stringify(defaults.gradfunParams)) : JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS)),
	};
	window._tempDefaults = tempDefaults;

	renderRadioPills(document.getElementById("default-quality"), QUALITIES, tempDefaults.quality, (v) => (tempDefaults.quality = v));
	renderRadioPills(document.getElementById("default-speed"), SPEEDS, tempDefaults.finalSpeed, (v) => (tempDefaults.finalSpeed = v));
	renderRadioPills(document.getElementById("default-denoise"), DENOISE_LEVELS, tempDefaults.denoise || "off", (v) => (tempDefaults.denoise = v));
	renderRadioPills(document.getElementById("default-deband"), DEBAND_LEVELS, tempDefaults.deband || "off", (v) => (tempDefaults.deband = v));
	renderDownscaleToggle(document.getElementById("default-downscale"), tempDefaults.downscale || false, (v) => (tempDefaults.downscale = v));
	renderSkipBoostingToggle(document.getElementById("default-skip-boosting"), tempDefaults.skipBoosting || false, (v) => (tempDefaults.skipBoosting = v));
	renderNoPhaseInvToggle(document.getElementById("default-no-phase-inv"), tempDefaults.noPhaseInv || false, (v) => (tempDefaults.noPhaseInv = v));
	renderDedupeSubtitlesToggle(
		document.getElementById("default-dedupe-subtitles"),
		tempDefaults.dedupeSubtitles || false,
		(v) => (tempDefaults.dedupeSubtitles = v),
	);
	renderAudioLanguagesInput(document.getElementById("default-audio-languages"), tempDefaults.audioLanguages || [], (v) => (tempDefaults.audioLanguages = v));
	renderLanguageFilterInput(
		document.getElementById("default-subtitle-languages"),
		tempDefaults.subtitleLanguages || [],
		(v) => (tempDefaults.subtitleLanguages = v),
	);
	renderBitrateInputs(document.getElementById("default-bitrates"), tempDefaults.audioBitrates, (ch, val) => (tempDefaults.audioBitrates[ch] = val));

	document.getElementById("settings-modal").style.display = "";
}

async function saveSettings() {
	if (!window._tempDefaults) return;
	defaults = await patchConfig(window._tempDefaults);
	closeSettings();
}

function closeSettings() {
	document.getElementById("settings-modal").style.display = "none";
}

function closeSettingsIfOutside(e) {
	if (e.target === e.currentTarget) closeSettings();
}

async function openAdvancedModal(target /* "default" | "job" */) {
	const settings = target === "default" ? window._tempDefaults : window._tempJobSettings;
	if (!settings) return;

	// Seed any missing fields from defaults (covers older queue.json entries
	// that haven't been migrated by the backend yet).
	if (!settings.nlmeansParams) {
		settings.nlmeansParams = JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS));
	}
	if (!settings.gradfunParams) {
		settings.gradfunParams = JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS));
	}
	if (!settings.autoDenoiseThresholds) {
		settings.autoDenoiseThresholds = { ...DEFAULT_AUTO_THRESHOLDS };
	}
	if (!settings.denoiseBackend) settings.denoiseBackend = "auto";
	if (settings.gpuDevice === undefined || settings.gpuDevice === null) {
		settings.gpuDevice = settings.denoiseBackend === "vulkan" ? "0" : "0.0";
	}

	const titleEl = document.getElementById("advanced-modal-title");
	titleEl.textContent = target === "default" ? "Advanced Default Settings" : "Advanced Job Settings";

	const backendEl = document.getElementById("advanced-denoise-backend");
	const deviceGroupEl = document.getElementById("advanced-gpu-device-group");
	const devicePickerEl = document.getElementById("advanced-gpu-device");

	async function refreshDevicePicker(backend) {
		if (backend === "cpu") {
			deviceGroupEl.style.display = "none";
			return;
		}
		deviceGroupEl.style.display = "";
		const devices = backend === "vulkan" ? await fetchVulkanDevices() : await fetchOpenClDevices();
		// "auto" probes vulkan first; show vulkan devices for that case.
		renderGpuDevicePicker(devicePickerEl, devices, settings.gpuDevice, (v) => (settings.gpuDevice = v));
	}

	renderRadioPills(backendEl, DENOISE_BACKENDS, settings.denoiseBackend, async (v) => {
		const prev = settings.denoiseBackend;
		settings.denoiseBackend = v;
		// Reset gpuDevice format only when crossing the vulkan/opencl divide.
		if (v === "vulkan" && prev !== "vulkan") settings.gpuDevice = "0";
		else if (v === "opencl" && prev !== "opencl") settings.gpuDevice = "0.0";
		else if (v === "auto" && (prev === "cpu" || !settings.gpuDevice)) settings.gpuDevice = "0";
		await refreshDevicePicker(v);
	});
	await refreshDevicePicker(settings.denoiseBackend);

	renderAutoThresholds(document.getElementById("advanced-auto-thresholds"), settings.autoDenoiseThresholds, (v) => (settings.autoDenoiseThresholds = v));

	renderNlmeansParamsEditor(document.getElementById("advanced-nlmeans-params"), settings.nlmeansParams, (v) => (settings.nlmeansParams = v));

	renderGradfunParamsEditor(document.getElementById("advanced-gradfun-params"), settings.gradfunParams, (v) => (settings.gradfunParams = v));

	renderVsChainEditor(document.getElementById("advanced-vs-chain"), settings);

	document.getElementById("advanced-modal").style.display = "";
}

function closeAdvancedModal() {
	document.getElementById("advanced-modal").style.display = "none";
}

function closeAdvancedModalIfOutside(e) {
	if (e.target === e.currentTarget) closeAdvancedModal();
}

function formatElapsed(ms) {
	const total = Math.floor(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

function classifySpeedup(x) {
	if (x === null || x === undefined || isNaN(x)) return "";
	if (x >= 2) return "speedup-good";
	if (x >= 1.2) return "speedup-meh";
	return "speedup-bad";
}

function renderBenchmarkResults(state) {
	const container = document.getElementById("benchmark-results");
	const levels = ["light", "medium", "heavy"];

	const cpuMap = new Map();
	const oclMap = new Map();
	const vkMap = new Map();
	for (const r of state.results) {
		const target = r.mode === "vulkan" ? vkMap : r.mode === "opencl" ? oclMap : cpuMap;
		target.set(r.level, r);
	}

	if (state.results.length === 0 && state.status !== "completed") {
		container.style.display = "none";
		return;
	}
	const showOcl = state.openclAvailable === true || oclMap.size > 0;
	const showVk = state.vulkanAvailable === true || vkMap.size > 0;

	const cell = (entry, fps) => {
		if (!entry) return `<td class="numeric cell-empty">—</td>`;
		if (entry.error) return `<td class="numeric cell-failed" title="${escapeHtml(entry.error)}">failed</td>`;
		if (fps === null || fps === undefined) return `<td class="numeric cell-empty">—</td>`;
		const speed = entry.speed ? ` <span class="cell-empty">(${escapeHtml(entry.speed)})</span>` : "";
		return `<td class="numeric">${fps.toFixed(2)}${speed}</td>`;
	};

	let oclSum = 0,
		oclCount = 0;
	let vkSum = 0,
		vkCount = 0;

	const rows = levels
		.map((level) => {
			const cpu = cpuMap.get(level);
			const ocl = oclMap.get(level);
			const vk = vkMap.get(level);
			const cpuFps = cpu && !cpu.error ? cpu.fps : null;
			const oclFps = ocl && !ocl.error ? ocl.fps : null;
			const vkFps = vk && !vk.error ? vk.fps : null;

			const oclSpeedup = cpuFps && oclFps ? oclFps / cpuFps : null;
			const vkSpeedup = cpuFps && vkFps ? vkFps / cpuFps : null;
			if (oclSpeedup !== null) {
				oclSum += oclSpeedup;
				oclCount++;
			}
			if (vkSpeedup !== null) {
				vkSum += vkSpeedup;
				vkCount++;
			}

			const best = vkSpeedup !== null && (oclSpeedup === null || vkSpeedup > oclSpeedup) ? vkSpeedup : oclSpeedup;
			const speedupCell = best !== null ? `<td class="numeric ${classifySpeedup(best)}">${best.toFixed(2)}x</td>` : `<td class="numeric cell-empty">—</td>`;

			return `<tr>
				<td class="level-cell">${level}</td>
				${cell(cpu, cpuFps)}
				${showOcl ? cell(ocl, oclFps) : ""}
				${showVk ? cell(vk, vkFps) : ""}
				${speedupCell}
			</tr>`;
		})
		.join("");

	const headers = [
		`<th>Level</th>`,
		`<th class="numeric">CPU fps</th>`,
		showOcl ? `<th class="numeric">OpenCL fps</th>` : "",
		showVk ? `<th class="numeric">Vulkan fps</th>` : "",
		`<th class="numeric">Best speedup</th>`,
	]
		.filter(Boolean)
		.join("");

	container.innerHTML = `<table>
		<thead><tr>${headers}</tr></thead>
		<tbody>${rows}</tbody>
	</table>`;

	if (state.status === "completed") {
		const oclAvg = oclCount > 0 ? oclSum / oclCount : null;
		const vkAvg = vkCount > 0 ? vkSum / vkCount : null;
		let recHtml = "";

		if (state.openclAvailable === false && state.vulkanAvailable === false) {
			recHtml = `<div class="benchmark-recommendation meh">No GPU backend available — denoising will run on CPU.</div>`;
		} else if (vkAvg !== null && oclAvg !== null) {
			const winner = vkAvg > oclAvg ? "vulkan" : "opencl";
			const winnerSpeed = Math.max(vkAvg, oclAvg);
			const cls = winnerSpeed >= 2 ? "good" : winnerSpeed >= 1.2 ? "meh" : "bad";
			recHtml = `<div class="benchmark-recommendation ${cls}">Vulkan ${vkAvg.toFixed(1)}x · OpenCL ${oclAvg.toFixed(1)}x vs CPU — set <code>ENCODER_GPU_BACKEND=${winner}</code>.</div>`;
		} else if (vkAvg !== null) {
			const cls = vkAvg >= 2 ? "good" : vkAvg >= 1.2 ? "meh" : "bad";
			recHtml = `<div class="benchmark-recommendation ${cls}">Vulkan is ${vkAvg.toFixed(1)}x faster than CPU.</div>`;
		} else if (oclAvg !== null) {
			const cls = oclAvg >= 2 ? "good" : oclAvg >= 1.2 ? "meh" : "bad";
			recHtml = `<div class="benchmark-recommendation ${cls}">OpenCL is ${oclAvg.toFixed(1)}x faster than CPU.</div>`;
		}

		container.insertAdjacentHTML("beforeend", recHtml);
	}

	container.style.display = "";
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderBenchmark(state) {
	const cpuEl = document.getElementById("benchmark-cpu-name");
	const gpuEl = document.getElementById("benchmark-gpu-name");

	if (cpuEl) cpuEl.textContent = state.cpuName || "Unknown";
	if (gpuEl) {
		if (state.gpuName) {
			gpuEl.textContent = `${state.gpuName.split("(")[0].trim()} (${state.gpuDevice})`;
			gpuEl.classList.remove("benchmark-hardware-missing");
		} else if (state.gpuDevice) {
			gpuEl.textContent = `Device ${state.gpuDevice} not found`;
			gpuEl.classList.add("benchmark-hardware-missing");
		} else {
			gpuEl.textContent = "Not available";
			gpuEl.classList.add("benchmark-hardware-missing");
		}
	}

	const statusEl = document.getElementById("benchmark-status");
	const statusLabel = document.getElementById("benchmark-status-label");
	const statusStep = document.getElementById("benchmark-status-step");
	const statusFill = document.getElementById("benchmark-progress-fill");
	const statusMeta = document.getElementById("benchmark-status-meta");
	const errEl = document.getElementById("benchmark-error");
	const runBtn = document.getElementById("benchmark-run-btn");
	const cancelBtn = document.getElementById("benchmark-cancel-btn");
	const noteEl = document.getElementById("benchmark-note");

	errEl.style.display = "none";

	if (state.status === "running") {
		statusEl.style.display = "";
		statusLabel.textContent = state.currentLabel || "Running…";
		statusStep.textContent = state.totalSteps > 0 ? `Step ${state.currentStep} / ${state.totalSteps}` : "";
		const pct = state.totalSteps > 0 ? Math.min(100, (state.currentStep / state.totalSteps) * 100) : 0;
		statusFill.style.width = `${pct}%`;
		const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
		statusMeta.textContent = `Elapsed ${formatElapsed(elapsed)} · ${state.size} · ${state.duration}s @ ${state.rate} fps`;
		runBtn.style.display = "none";
		cancelBtn.style.display = "";
		noteEl.textContent = "";
	} else if (state.status === "completed") {
		statusEl.style.display = "";
		statusLabel.textContent = "Completed";
		statusStep.textContent = `${state.results.length} / ${state.totalSteps} runs`;
		statusFill.style.width = "100%";
		const elapsed = state.startedAt && state.completedAt ? state.completedAt - state.startedAt : 0;
		statusMeta.textContent = `Total ${formatElapsed(elapsed)} · ${state.size} · ${state.duration}s @ ${state.rate} fps`;
		runBtn.style.display = "";
		runBtn.textContent = "Run Again";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	} else if (state.status === "failed") {
		statusEl.style.display = "none";
		errEl.textContent = state.error || "Benchmark failed";
		errEl.style.display = "";
		runBtn.style.display = "";
		runBtn.textContent = "Retry";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	} else if (state.status === "cancelled") {
		statusEl.style.display = "";
		statusLabel.textContent = "Cancelled";
		statusStep.textContent = "";
		statusMeta.textContent = "";
		runBtn.style.display = "";
		runBtn.textContent = "Run Benchmark";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	} else {
		// idle
		statusEl.style.display = "none";
		runBtn.style.display = "";
		runBtn.textContent = "Run Benchmark";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	}

	renderBenchmarkResults(state);
}

function startBenchmarkPolling() {
	stopBenchmarkPolling();
	const tick = async () => {
		try {
			const state = await fetchBenchmark();
			renderBenchmark(state);
			if (state.status !== "running") {
				stopBenchmarkPolling();
			}
		} catch {
			stopBenchmarkPolling();
		}
	};
	benchmarkPollTimer = setInterval(tick, 700);
	tick();
}

function stopBenchmarkPolling() {
	if (benchmarkPollTimer) clearInterval(benchmarkPollTimer);
	benchmarkPollTimer = null;
}

async function openBenchmark() {
	document.getElementById("benchmark-modal").style.display = "";
	try {
		const state = await fetchBenchmark();
		renderBenchmark(state);
		if (state.status === "running") startBenchmarkPolling();
	} catch {
		document.getElementById("benchmark-error").textContent = "Failed to load benchmark state";
		document.getElementById("benchmark-error").style.display = "";
	}
}

function closeBenchmark() {
	document.getElementById("benchmark-modal").style.display = "none";
	stopBenchmarkPolling();
}

function closeBenchmarkIfOutside(e) {
	if (e.target === e.currentTarget) closeBenchmark();
}

async function handleBenchmarkRun() {
	const runBtn = document.getElementById("benchmark-run-btn");
	const noteEl = document.getElementById("benchmark-note");
	runBtn.disabled = true;
	runBtn.textContent = "Starting…";
	noteEl.textContent = "";
	try {
		const result = await startBenchmarkRun();
		if (result.error) {
			noteEl.textContent = result.error;
			runBtn.textContent = "Run Benchmark";
		} else {
			renderBenchmark(result);
			startBenchmarkPolling();
		}
	} catch {
		noteEl.textContent = "Failed to start benchmark";
		runBtn.textContent = "Run Benchmark";
	} finally {
		runBtn.disabled = false;
	}
}

async function handleBenchmarkCancel() {
	const cancelBtn = document.getElementById("benchmark-cancel-btn");
	cancelBtn.disabled = true;
	try {
		await cancelBenchmarkRun();
		const state = await fetchBenchmark();
		renderBenchmark(state);
		stopBenchmarkPolling();
	} catch {
	} finally {
		cancelBtn.disabled = false;
	}
}

async function openJobSettings(jobId) {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job || job.status !== "queued") return;

	currentEditJobId = jobId;
	document.getElementById("job-modal-title").textContent = job.filename;

	const tempSettings = {
		...job.settings,
		audioBitrates: { ...job.settings.audioBitrates },
		autoDenoiseThresholds: { ...(job.settings.autoDenoiseThresholds || DEFAULT_AUTO_THRESHOLDS) },
		nlmeansParams: job.settings.nlmeansParams ? JSON.parse(JSON.stringify(job.settings.nlmeansParams)) : JSON.parse(JSON.stringify(DEFAULT_NLMEANS_PARAMS)),
		gradfunParams: job.settings.gradfunParams ? JSON.parse(JSON.stringify(job.settings.gradfunParams)) : JSON.parse(JSON.stringify(DEFAULT_GRADFUN_PARAMS)),
	};
	window._tempJobSettings = tempSettings;

	renderRadioPills(document.getElementById("job-quality"), QUALITIES, tempSettings.quality, (v) => (tempSettings.quality = v));
	renderRadioPills(document.getElementById("job-speed"), SPEEDS, tempSettings.finalSpeed, (v) => (tempSettings.finalSpeed = v));
	renderRadioPills(document.getElementById("job-denoise"), DENOISE_LEVELS, tempSettings.denoise || "off", (v) => (tempSettings.denoise = v));
	renderRadioPills(document.getElementById("job-deband"), DEBAND_LEVELS, tempSettings.deband || "off", (v) => (tempSettings.deband = v));
	renderDownscaleToggle(document.getElementById("job-downscale"), tempSettings.downscale || false, (v) => (tempSettings.downscale = v));
	renderSkipBoostingToggle(document.getElementById("job-skip-boosting"), tempSettings.skipBoosting || false, (v) => (tempSettings.skipBoosting = v));
	renderNoPhaseInvToggle(document.getElementById("job-no-phase-inv"), tempSettings.noPhaseInv || false, (v) => (tempSettings.noPhaseInv = v));
	renderDedupeSubtitlesToggle(
		document.getElementById("job-dedupe-subtitles"),
		tempSettings.dedupeSubtitles || false,
		(v) => (tempSettings.dedupeSubtitles = v),
	);
	renderAudioLanguagesInput(document.getElementById("job-audio-languages"), tempSettings.audioLanguages || [], (v) => (tempSettings.audioLanguages = v));
	renderLanguageFilterInput(
		document.getElementById("job-subtitle-languages"),
		tempSettings.subtitleLanguages || [],
		(v) => (tempSettings.subtitleLanguages = v),
	);
	renderBitrateInputs(document.getElementById("job-bitrates"), tempSettings.audioBitrates, (ch, val) => (tempSettings.audioBitrates[ch] = val));

	document.getElementById("job-modal").style.display = "";
}

async function saveJobSettings() {
	if (!currentEditJobId || !window._tempJobSettings) return;
	await patchJob(currentEditJobId, window._tempJobSettings);
	closeJobModal();
	update();
}

function closeJobModal() {
	document.getElementById("job-modal").style.display = "none";
	currentEditJobId = null;
}

function closeJobModalIfOutside(e) {
	if (e.target === e.currentTarget) closeJobModal();
}

async function removeJob(id) {
	await deleteJob(id);
	update();
}

async function doRetry(id) {
	await retryJob(id);
	update();
}

async function fetchLibraryDirs() {
	const res = await authFetch(`${API}/api/library`);
	const data = await res.json();
	return data.dirs || [];
}

async function fetchLibraryBrowse(path) {
	const res = await authFetch(`${API}/api/library/browse?path=${encodeURIComponent(path)}`);
	return res.json();
}

async function postLibraryEncodePaths(paths) {
	const res = await authFetch(`${API}/api/library/encode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ paths }),
	});
	return res.json();
}

function humanFileSize(bytes) {
	if (!bytes) return "";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(1)} ${units[i]}`;
}

function setNodeChecked(path, checked) {
	const node = libraryNodes.get(path);
	if (!node) return;
	node.checked = checked;
	if (node.type === "directory" && node.children) {
		for (const childPath of node.children) {
			setNodeChecked(childPath, checked);
		}
	}
}

function getNodeCheckState(path) {
	const node = libraryNodes.get(path);
	if (!node) return { checked: false, indeterminate: false };
	if (node.type === "file") return { checked: node.checked, indeterminate: false };
	if (!node.children || node.children.length === 0) return { checked: node.checked, indeterminate: false };

	let checkedCount = 0;
	let totalCount = 0;
	let hasIndeterminate = false;
	for (const childPath of node.children) {
		const s = getNodeCheckState(childPath);
		totalCount++;
		if (s.checked) checkedCount++;
		if (s.indeterminate) hasIndeterminate = true;
	}
	if (hasIndeterminate || (checkedCount > 0 && checkedCount < totalCount)) {
		return { checked: false, indeterminate: true };
	}
	return { checked: checkedCount === totalCount && totalCount > 0, indeterminate: false };
}

function updateParentCheckState(path) {
	const node = libraryNodes.get(path);
	if (!node || !node.parentPath) return;
	const parent = libraryNodes.get(node.parentPath);
	if (!parent || !parent.children) return;
	const state = getNodeCheckState(parent.path);
	parent.checked = state.checked;
	updateParentCheckState(parent.path);
}

function toggleNodeCheck(path) {
	const state = getNodeCheckState(path);
	const newChecked = !(state.checked || state.indeterminate);
	setNodeChecked(path, newChecked);
	updateParentCheckState(path);
	renderLibraryTree();
	updateLibraryFooter();
}

async function toggleNodeExpand(path) {
	const node = libraryNodes.get(path);
	if (!node || node.type !== "directory") return;

	if (node.expanded) {
		node.expanded = false;
		renderLibraryTree();
		return;
	}

	if (node.children === null) {
		node.loading = true;
		renderLibraryTree();
		try {
			const data = await fetchLibraryBrowse(node.path);
			const entries = data.entries || [];
			node.children = [];
			for (const entry of entries) {
				const child = createTreeNode(entry, node.depth + 1, node.path);
				if (node.checked) child.checked = true;
				libraryNodes.set(child.path, child);
				node.children.push(child.path);
			}
		} catch {
			node.children = [];
		}
		node.loading = false;
	}

	node.expanded = true;
	renderLibraryTree();
}

function getCheckedPaths() {
	const paths = [];
	function collect(path) {
		const node = libraryNodes.get(path);
		if (!node) return;
		if (node.type === "file") {
			if (node.checked && !node.encoded) paths.push(node.path);
			return;
		}
		const state = getNodeCheckState(path);
		if (state.checked) {
			paths.push(node.path);
			return;
		}
		if (state.indeterminate && node.children) {
			for (const childPath of node.children) collect(childPath);
		}
	}
	for (const dir of libraryDirs) {
		const root = libraryNodes.get(dir.path);
		if (root) collect(root.path);
	}
	return paths;
}

function countSelectedToEncode() {
	let total = 0;
	function count(path) {
		const node = libraryNodes.get(path);
		if (!node) return;
		if (node.type === "file") {
			if (node.checked && !node.encoded) total++;
			return;
		}
		const state = getNodeCheckState(path);
		if (state.checked) {
			total += (node.videoCount || 0) - (node.encodedCount || 0);
			return;
		}
		if (state.indeterminate && node.children) {
			for (const childPath of node.children) count(childPath);
		}
	}
	for (const dir of libraryDirs) {
		const root = libraryNodes.get(dir.path);
		if (root) count(root.path);
	}
	return total;
}

function renderLibraryTree() {
	const content = document.getElementById("library-content");
	if (libraryDirs.length === 0) {
		content.innerHTML = `<div class="library-empty">No library directories configured.<br>Set <code>LIBRARY_DIRS</code> in your docker-compose.yml</div>`;
		return;
	}
	let html = "";
	for (const dir of libraryDirs) {
		const node = libraryNodes.get(dir.path);
		if (node) html += renderTreeNode(node);
	}
	content.innerHTML = html || `<div class="library-empty">No library directories configured</div>`;
}

function renderTreeNode(node) {
	const isDir = node.type === "directory";
	const state = getNodeCheckState(node.path);
	const indent = node.depth * 24;

	if (isDir) {
		return renderTreeFolder(node, state.checked, state.indeterminate, indent);
	}
	return renderTreeFile(node, indent);
}

function renderTreeFolder(node, checked, indeterminate, indent) {
	const chevronClass = node.expanded ? "expanded" : "";
	const encodedClass = node.videoCount > 0 && node.videoCount === node.encodedCount ? " is-encoded" : "";
	const pending = (node.videoCount || 0) - (node.encodedCount || 0);

	let metaParts = [];
	if (node.videoCount > 0 && pending === 0) metaParts.push(`<span class="library-encoded-badge">encoded</span>`);
	if (pending > 0) metaParts.push(`${pending} to encode`);
	if (node.videoCount > 0) metaParts.push(`${node.videoCount} video${node.videoCount !== 1 ? "s" : ""}`);

	let childrenHtml = "";
	if (node.expanded && node.children) {
		if (node.children.length === 0) {
			childrenHtml = `<div class="tree-empty" style="padding-left:${indent + 56}px">Empty folder</div>`;
		} else {
			for (const childPath of node.children) {
				const child = libraryNodes.get(childPath);
				if (child) childrenHtml += renderTreeNode(child);
			}
		}
	}
	if (node.loading) {
		childrenHtml = `<div class="tree-loading" style="padding-left:${indent + 56}px">Loading...</div>`;
	}

	const cbHtml = renderCheckbox(node.path, checked, indeterminate);
	return `
		<div class="tree-node tree-folder${encodedClass}">
			<div class="tree-row" style="padding-left:${indent}px">
				<button class="tree-chevron ${chevronClass}" data-action="expand" data-path="${escapeHtml(node.path)}">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
				</button>
				${cbHtml}
				<svg class="tree-icon tree-icon-folder" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
				</svg>
				<span class="tree-name" data-action="expand" data-path="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
				<span class="tree-meta">${metaParts.join(" · ")}</span>
			</div>
			${childrenHtml}
		</div>`;
}

function renderTreeFile(node, indent) {
	const encodedClass = node.encoded ? " is-encoded" : "";
	const cbHtml = renderCheckbox(node.path, node.checked, false);
	let metaParts = [];
	if (node.encoded) metaParts.push(`<span class="library-encoded-badge">encoded</span>`);
	if (node.size) metaParts.push(humanFileSize(node.size));

	return `
		<div class="tree-node tree-file${encodedClass}">
			<div class="tree-row" style="padding-left:${indent + 24}px">
				${cbHtml}
				<svg class="tree-icon tree-icon-file" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<polygon points="23 7 16 12 23 17 23 7"/>
					<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
				</svg>
				<span class="tree-name tree-name-file">${escapeHtml(node.name)}</span>
				<span class="tree-meta">${metaParts.join(" · ")}</span>
			</div>
		</div>`;
}

function renderCheckbox(path, checked, indeterminate) {
	const cls = checked ? "checked" : indeterminate ? "indeterminate" : "";
	const icon = checked
		? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
		: indeterminate
			? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="5" y1="12" x2="19" y2="12"/></svg>`
			: "";
	return `<button class="tree-checkbox ${cls}" data-action="check" data-path="${escapeHtml(path)}">${icon}</button>`;
}

function updateLibraryFooter() {
	const note = document.getElementById("library-note");
	const encodeBtn = document.getElementById("library-encode-btn");
	const count = countSelectedToEncode();
	if (count > 0) {
		note.textContent = `${count} file${count !== 1 ? "s" : ""} selected for encoding`;
		encodeBtn.disabled = false;
	} else {
		note.textContent = "Select folders or files to encode";
		encodeBtn.disabled = true;
	}
}

function renderDownscaleToggle(container, checked, onChange) {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Downscale 4K to 1080p";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

function renderSkipBoostingToggle(container, checked, onChange) {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Skip boosting";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

function renderNoPhaseInvToggle(container, checked, onChange) {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Disable phase inversion (--no-phase-inv)";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

function renderDedupeSubtitlesToggle(container, checked, onChange) {
	container.innerHTML = "";
	const label = document.createElement("label");
	label.className = "toggle-label";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.onchange = () => onChange(input.checked);

	const span = document.createElement("span");
	span.textContent = "\u00A0Keep one subtitle per language and type";

	label.appendChild(input);
	label.appendChild(span);
	container.appendChild(label);
}

function renderAudioLanguagesInput(container, value, onChange) {
	container.innerHTML = "";

	const input = document.createElement("input");
	input.type = "text";
	input.className = "lang-filter-input";
	input.placeholder = "jpn, eng (empty = keep all)";
	input.value = (value || []).join(", ");

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.textContent = "Comma-separated ISO codes. Empty keeps every track.";

	input.oninput = () =>
		onChange(
			input.value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);

	container.appendChild(input);
	container.appendChild(hint);
}

function renderLanguageFilterInput(container, value, onChange) {
	container.innerHTML = "";

	const input = document.createElement("input");
	input.type = "text";
	input.className = "lang-filter-input";
	input.placeholder = "jpn, eng (empty = keep all)";
	input.value = (value || []).join(", ");

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.textContent = "Comma-separated ISO codes. Empty keeps every track.";

	input.oninput = () =>
		onChange(
			input.value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);

	container.appendChild(input);
	container.appendChild(hint);
}

function renderNlmeansParamsEditor(container, params, onChange) {
	container.innerHTML = "";
	const grid = document.createElement("div");
	grid.className = "nlmeans-params-grid";

	// Header row
	for (const label of ["", "s (strength)", "p (patch)", "r (research)"]) {
		const cell = document.createElement("div");
		cell.className = "nlmeans-params-header";
		cell.textContent = label;
		grid.appendChild(cell);
	}

	for (const level of ["light", "medium", "heavy"]) {
		const labelCell = document.createElement("div");
		labelCell.className = "nlmeans-params-label";
		labelCell.textContent = level;
		grid.appendChild(labelCell);

		// s : float [1.0, 30.0]
		const sInput = document.createElement("input");
		sInput.type = "number";
		sInput.step = "0.1";
		sInput.min = "1";
		sInput.max = "30";
		sInput.value = params[level].s;
		sInput.onchange = () => {
			const v = clampFloat(sInput.value, 1.0, 30.0);
			params[level].s = v;
			sInput.value = v;
			onChange(params);
		};
		grid.appendChild(sInput);

		// p : odd int [1, 99]
		const pInput = document.createElement("input");
		pInput.type = "number";
		pInput.step = "2";
		pInput.min = "1";
		pInput.max = "99";
		pInput.value = params[level].p;
		pInput.onchange = () => {
			const v = forceOdd(clampInt(pInput.value, 1, 99));
			params[level].p = v;
			pInput.value = v;
			onChange(params);
		};
		grid.appendChild(pInput);

		// r : odd int [1, 99]
		const rInput = document.createElement("input");
		rInput.type = "number";
		rInput.step = "2";
		rInput.min = "1";
		rInput.max = "99";
		rInput.value = params[level].r;
		rInput.onchange = () => {
			const v = forceOdd(clampInt(rInput.value, 1, 99));
			params[level].r = v;
			rInput.value = v;
			onChange(params);
		};
		grid.appendChild(rInput);
	}

	container.appendChild(grid);
}

function renderGradfunParamsEditor(container, params, onChange) {
	container.innerHTML = "";
	const grid = document.createElement("div");
	grid.className = "gradfun-params-grid";

	// Header row
	for (const label of ["", "strength", "radius"]) {
		const cell = document.createElement("div");
		cell.className = "gradfun-params-header";
		cell.textContent = label;
		grid.appendChild(cell);
	}

	for (const level of ["light", "medium", "heavy"]) {
		const labelCell = document.createElement("div");
		labelCell.className = "gradfun-params-label";
		labelCell.textContent = level;
		grid.appendChild(labelCell);

		// strength : float [0.51, 64]
		const sInput = document.createElement("input");
		sInput.type = "number";
		sInput.step = "0.1";
		sInput.min = "0.51";
		sInput.max = "64";
		sInput.value = params[level].strength;
		sInput.onchange = () => {
			const v = clampFloat(sInput.value, 0.51, 64);
			params[level].strength = v;
			sInput.value = v;
			onChange(params);
		};
		grid.appendChild(sInput);

		// radius : int [8, 32]
		const rInput = document.createElement("input");
		rInput.type = "number";
		rInput.step = "1";
		rInput.min = "8";
		rInput.max = "32";
		rInput.value = params[level].radius;
		rInput.onchange = () => {
			const v = clampInt(rInput.value, 8, 32);
			params[level].radius = v;
			rInput.value = v;
			onChange(params);
		};
		grid.appendChild(rInput);
	}

	container.appendChild(grid);
}

async function openLibrary() {
	const modal = document.getElementById("library-modal");
	const content = document.getElementById("library-content");
	const note = document.getElementById("library-note");
	const encodeBtn = document.getElementById("library-encode-btn");
	content.innerHTML = `<div class="library-loading">Loading library...</div>`;
	note.textContent = "";
	encodeBtn.disabled = true;
	modal.style.display = "";

	try {
		libraryDirs = await fetchLibraryDirs();
		if (libraryDirs.length === 0) {
			content.innerHTML = `<div class="library-empty">No library directories configured.<br>Set <code>LIBRARY_DIRS</code> in your docker-compose.yml</div>`;
			return;
		}
		libraryNodes.clear();
		for (const dir of libraryDirs) {
			const rootNode = createTreeNode({ path: dir.path, name: dir.name, type: "directory", videoCount: 0, encodedCount: 0 }, 0, null);
			libraryNodes.set(dir.path, rootNode);
		}
		renderLibraryTree();
		updateLibraryFooter();
	} catch {
		content.innerHTML = `<div class="library-empty">Failed to load library</div>`;
	}
}

function closeLibrary() {
	document.getElementById("library-modal").style.display = "none";
}

function closeLibraryIfOutside(e) {
	if (e.target === e.currentTarget) closeLibrary();
}

async function handleLibraryEncode() {
	const paths = getCheckedPaths();
	if (paths.length === 0) return;

	const encodeBtn = document.getElementById("library-encode-btn");
	encodeBtn.disabled = true;
	encodeBtn.textContent = "Starting...";

	try {
		const result = await postLibraryEncodePaths(paths);
		const note = document.getElementById("library-note");
		const parts = [];
		if (result.added > 0) parts.push(`Queued ${result.added} file${result.added !== 1 ? "s" : ""}`);
		if (result.skipped > 0) parts.push(`${result.skipped} already queued`);
		if (result.alreadyEncoded > 0) parts.push(`${result.alreadyEncoded} already encoded`);
		if (parts.length === 0) parts.push("No video files found to encode");
		note.textContent = parts.join(" · ");

		if (result.added > 0) {
			closeLibrary();
			update();
		}
	} catch {
		document.getElementById("library-note").textContent = "Failed to start encoding";
	} finally {
		encodeBtn.textContent = "Encode Selected";
		encodeBtn.disabled = getCheckedPaths().length === 0;
	}
}

function initEventListeners() {
	document.getElementById("open-settings-btn").addEventListener("click", openSettings);
	document.getElementById("close-settings-btn").addEventListener("click", closeSettings);
	document.getElementById("save-settings-btn").addEventListener("click", saveSettings);
	document.getElementById("settings-modal").addEventListener("click", closeSettingsIfOutside);

	document.getElementById("close-job-modal-btn").addEventListener("click", closeJobModal);
	document.getElementById("job-modal").addEventListener("click", closeJobModalIfOutside);
	document.getElementById("save-job-settings-btn").addEventListener("click", saveJobSettings);

	document.getElementById("open-default-advanced-btn").addEventListener("click", () => openAdvancedModal("default"));
	document.getElementById("open-job-advanced-btn").addEventListener("click", () => openAdvancedModal("job"));
	document.getElementById("close-advanced-modal-btn").addEventListener("click", closeAdvancedModal);
	document.getElementById("close-advanced-done-btn").addEventListener("click", closeAdvancedModal);
	document.getElementById("advanced-modal").addEventListener("click", closeAdvancedModalIfOutside);

	document.getElementById("vs-reload-btn").onclick = async () => {
		await reloadVsPresets();
		renderVsChainEditor(document.getElementById("advanced-vs-chain"), getCurrentSettings());
	};

	document.getElementById("sub-preview-modal").addEventListener("click", closeSubPreviewIfOutside);
	document.getElementById("logout-btn").addEventListener("click", logout);

	document.getElementById("close-audio-preview-btn").addEventListener("click", closeAudioPreview);
	document.getElementById("audio-preview-modal").addEventListener("click", closeAudioPreviewIfOutside);

	document.getElementById("pause-queue-btn").addEventListener("click", handlePauseToggle);

	document.getElementById("open-benchmark-btn").addEventListener("click", openBenchmark);
	document.getElementById("close-benchmark-btn").addEventListener("click", closeBenchmark);
	document.getElementById("benchmark-modal").addEventListener("click", closeBenchmarkIfOutside);
	document.getElementById("benchmark-run-btn").addEventListener("click", handleBenchmarkRun);
	document.getElementById("benchmark-cancel-btn").addEventListener("click", handleBenchmarkCancel);

	document.getElementById("close-preview-modal-btn").addEventListener("click", closePreviewModal);
	document.getElementById("preview-modal").addEventListener("click", closePreviewModalIfOutside);
	document.getElementById("preview-run-btn").addEventListener("click", handlePreviewRun);
	document.getElementById("preview-cancel-btn").addEventListener("click", handlePreviewCancel);
	document.getElementById("preview-clear-btn").addEventListener("click", handlePreviewClear);

	document.getElementById("login-submit-btn").addEventListener("click", handleLogin);
	document.getElementById("login-password").addEventListener("keydown", (e) => {
		if (e.key === "Enter") handleLogin();
	});

	document.getElementById("jobs-list").addEventListener("click", (e) => {
		const moveBtn = e.target.closest(".btn-move");
		if (moveBtn) {
			e.stopPropagation();
			const direction = moveBtn.dataset.action === "move-up" ? "up" : "down";
			const moveContainer = moveBtn.closest(".move-buttons");
			const moveType = moveContainer.dataset.moveType;

			if (moveType === "folder") {
				handleMove(moveContainer.dataset.movePath, direction, false, null);
			} else if (moveType === "file") {
				const jobId = moveContainer.dataset.moveJob;
				const folderJob = moveBtn.closest(".folder-job");
				const containingFolder = folderJob ? folderJob.dataset.containingFolder : "";
				handleMove(containingFolder, direction, true, jobId);
			}
			return;
		}

		const folderHeader = e.target.closest(".folder-header");
		if (folderHeader) {
			const path = folderHeader.dataset.folderPath;
			if (expandedFolders.has(path)) {
				expandedFolders.delete(path);
			} else {
				expandedFolders.add(path);
			}
			lastJobsJson = "";
			update();
			return;
		}

		const button = e.target.closest(".btn-icon");
		if (!button) return;

		const jobId = button.dataset.jobId;
		const action = button.dataset.action;

		if (action === "edit") {
			openJobSettings(jobId);
		} else if (action === "remove" || action === "dismiss") {
			removeJob(jobId);
		} else if (action === "retry") {
			doRetry(jobId);
		} else if (action === "cancel") {
			cancelJob(jobId).then(() => update());
		} else if (action === "preview") {
			openPreviewModal(jobId);
		} else if (action === "sub-preview") {
			openSubtitlePreview(jobId);
		} else if (action === "audio-preview") {
			openAudioPreview(jobId);
		} else if (action === "mediainfo") {
			openMediaInfo(jobId);
		}
	});

	document.getElementById("preview-samples").addEventListener("click", (e) => {
		const card = e.target.closest(".preview-sample");
		if (!card) return;
		const dlBtn = e.target.closest("[data-dl]");
		if (dlBtn) {
			e.stopPropagation();
			downloadPreviewSampleArtifact(currentPreviewJobId, parseInt(card.dataset.idx, 10), dlBtn.dataset.dl);
			return;
		}
		const fullscreenBtn = e.target.closest('[data-action="fullscreen"]');
		if (fullscreenBtn) {
			e.stopPropagation();
			openPreviewFullscreen(card);
			return;
		}
		const toggleHost = e.target.closest('[data-action="toggle"]');
		if (toggleHost) togglePreviewSampleView(card);
	});

	document.getElementById("close-preview-fullscreen-btn").addEventListener("click", closePreviewFullscreen);
	document.getElementById("preview-fullscreen-modal").addEventListener("click", closePreviewFullscreenIfOutside);
	document.getElementById("preview-fullscreen-stage").addEventListener("click", () => {
		if (currentPreviewFullscreenCard) togglePreviewSampleView(currentPreviewFullscreenCard);
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closePreviewFullscreen();
	});

	document.getElementById("open-library-btn").addEventListener("click", openLibrary);
	document.getElementById("close-library-btn").addEventListener("click", closeLibrary);
	document.getElementById("close-subtitle-preview-btn").addEventListener("click", closeSubPreview);
	document.getElementById("library-modal").addEventListener("click", closeLibraryIfOutside);
	document.getElementById("library-encode-btn").addEventListener("click", handleLibraryEncode);

	document.getElementById("library-content").addEventListener("click", (e) => {
		const chevron = e.target.closest('[data-action="expand"]');
		if (chevron) {
			const path = chevron.dataset.path;
			if (path) toggleNodeExpand(path);
			return;
		}

		const checkbox = e.target.closest('[data-action="check"]');
		if (checkbox) {
			const path = checkbox.dataset.path;
			if (path) toggleNodeCheck(path);
			return;
		}
	});

	document.getElementById("close-mediainfo-btn").addEventListener("click", closeMediaInfo);
	document.getElementById("mediainfo-modal").addEventListener("click", (e) => {
		if (e.target === e.currentTarget) closeMediaInfo();
	});
	document.getElementById("copy-mediainfo-btn").addEventListener("click", () => {
		navigator.clipboard.writeText(document.getElementById("mediainfo-content").textContent);
		closeMediaInfo();
	});
}

async function init() {
	initEventListeners();

	if (!authToken) {
		showLogin("");
		return;
	}

	try {
		const res = await fetch(`${API}/api/config`, {
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (res.status === 401 || res.status === 403) {
			authToken = "";
			localStorage.removeItem("authToken");
			showLogin("");
			return;
		}

		defaults = await res.json();
		startPolling();

		try {
			const libData = await fetchLibraryDirs();
			if (libData.length > 0) {
				document.getElementById("open-library-btn").style.display = "";
			}
		} catch {}
	} catch {
		showLogin("Cannot reach server");
	}
}

document.addEventListener("DOMContentLoaded", init);
