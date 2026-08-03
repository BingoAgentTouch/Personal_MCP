#!/usr/bin/env node
// P3 Phase 0 / Phase 1a: strictly read-only signal analysis and dry-run.
//
// The analyzer may write versioned JSON reports, but it never changes fragment
// metadata, fragment content, embeddings, or the source signal logs.
// Run from the memory project's parent directory:
//   node D:/AgentStore/memory-mcp-server/analyze_signals.mjs --dry-run

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ANALYZER_VERSION = "p3-phase1a-v1";
const REPORT_SCHEMA_VERSION = 2;
const EPISODE_GAP_SEC = 15 * 60;
const COST_POLICY_VERSION = "retrieval-cost-v1-experimental";
const COST_POLICY = Object.freeze({
	one: 0,
	two: 0.1,
	three: 0.2,
	four_plus: 0.3,
});
const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_EARNED_IMPORTANCE = 0;

export function parseOptions(argv) {
	const options = new Map();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		options.set(key, argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
	}
	return options;
}

export function hash(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return value;
}

export function canonicalJson(value) {
	return JSON.stringify(canonical(value));
}

export function calculateEarnedImportance(earned, cost) {
	if (!Number.isFinite(earned) || !Number.isFinite(cost)) throw new Error("earned and cost must be finite");
	if (earned < 0 || earned > 1) throw new Error("earned must be within [0,1]");
	if (cost < 0 || cost > 1) throw new Error("cost must be within [0,1]");
	return Math.min(1, earned + cost * (1 - earned));
}

export function decayFloor(importance) {
	if (!Number.isFinite(importance)) throw new Error("importance must be finite");
	const normalized = Math.max(0, Math.min(1, importance));
	return 0.4 * normalized + 0.3;
}

export function effectiveImportance(baseImportance, earnedImportance) {
	if (!Number.isFinite(baseImportance) || !Number.isFinite(earnedImportance)) {
		throw new Error("importance values must be finite");
	}
	return Math.max(0, Math.min(1, Math.max(baseImportance, earnedImportance)));
}

export function costForIteration(iteration) {
	if (!Number.isInteger(iteration) || iteration <= 1) return 0;
	if (iteration === 2) return COST_POLICY.two;
	if (iteration === 3) return COST_POLICY.three;
	return COST_POLICY.four_plus;
}

export function buildIdempotencyKey(episodeId, fragmentId, sourceHash, policyVersion = COST_POLICY_VERSION) {
	return hash(canonicalJson({ episode_id: episodeId, fragment_id: fragmentId, source_hash: sourceHash, policy_version: policyVersion }));
}

function finiteTimestamp(value) {
	const timestamp = Date.parse(typeof value === "string" ? value : "");
	return Number.isFinite(timestamp) ? timestamp : null;
}

function agentKey(agentId) {
	return agentId == null ? "∅" : String(agentId);
}

function queryHash(query) {
	return typeof query === "string" && query.length ? hash(query) : null;
}

function safeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJsonl(signalsRoot, name) {
	const filePath = path.join(signalsRoot, name);
	if (!fs.existsSync(filePath)) return { name, filePath, content: "", rows: [], invalidLines: [] };
	const content = fs.readFileSync(filePath, "utf8");
	const rows = [];
	const invalidLines = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (!parsed || typeof parsed !== "object") throw new Error("JSON value is not an object");
			rows.push({ value: parsed, source_line: index + 1 });
		} catch (error) {
			invalidLines.push({ source_line: index + 1, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { name, filePath, content, rows, invalidLines };
}

function normalizeSearchRows(source) {
	const valid = [];
	const invalid = [...source.invalidLines.map((item) => ({ ...item, kind: "invalid_json" }))];
	for (const row of source.rows) {
		const value = row.value;
		const timestamp = finiteTimestamp(value.ts);
		if (!timestamp) {
			invalid.push({ source_line: row.source_line, kind: "invalid_search_timestamp" });
			continue;
		}
		if (!Array.isArray(value.results)) {
			invalid.push({ source_line: row.source_line, kind: "search_results_not_array" });
			continue;
		}
		const results = value.results
			.filter((result) => result && typeof result.fragment_id === "string")
			.map((result, index) => ({
				fragment_id: result.fragment_id,
				rank: safeNumber(result.rank) ?? index + 1,
				raw_similarity: safeNumber(result.raw_similarity),
				weight: safeNumber(result.weight),
				score: safeNumber(result.score),
			}));
		valid.push({
			ts: value.ts,
			timestamp,
			agent_id: value.agent_id ?? null,
			agent_key: agentKey(value.agent_id),
			query_hash: queryHash(value.query),
			results,
			source_line: row.source_line,
		});
	}
	return { valid, invalid };
}

function normalizeGetRows(source) {
	const valid = [];
	const invalid = [...source.invalidLines.map((item) => ({ ...item, kind: "invalid_json" }))];
	for (const row of source.rows) {
		const value = row.value;
		const timestamp = finiteTimestamp(value.ts);
		if (!timestamp || typeof value.fragment_id !== "string" || !value.fragment_id) {
			invalid.push({ source_line: row.source_line, kind: "invalid_get_event" });
			continue;
		}
		valid.push({
			ts: value.ts,
			timestamp,
			fragment_id: value.fragment_id,
			agent_id: value.agent_id ?? null,
			agent_key: agentKey(value.agent_id),
			confirmed_by: value.confirmed_by ?? null,
			query_hash: queryHash(value.query),
			source_line: row.source_line,
		});
	}
	return { valid, invalid };
}

function episodeId(agent, searches) {
	return `ep_${hash(canonicalJson({ agent, start: searches[0].ts, lines: searches.map((search) => search.source_line) })).slice(7, 23)}`;
}

function buildEpisodes(searches) {
	const groups = new Map();
	for (const search of searches) {
		if (!groups.has(search.agent_key)) groups.set(search.agent_key, []);
		groups.get(search.agent_key).push(search);
	}
	const episodes = [];
	for (const [agent, rows] of groups) {
		rows.sort((a, b) => a.timestamp - b.timestamp || a.source_line - b.source_line);
		let current = null;
		for (const search of rows) {
			if (!current || search.timestamp - current.last_timestamp > EPISODE_GAP_SEC * 1000) {
				current = { agent, searches: [], start_timestamp: search.timestamp, last_timestamp: search.timestamp };
				episodes.push(current);
			}
			current.searches.push(search);
			current.last_timestamp = search.timestamp;
		}
	}
	return episodes
		.sort((a, b) => a.start_timestamp - b.start_timestamp)
		.map((episode) => ({ ...episode, episode_id: episodeId(episode.agent, episode.searches) }));
}

function episodeCandidates(episodes, get) {
	return episodes.filter((episode) =>
		episode.agent === get.agent_key &&
		episode.start_timestamp <= get.timestamp &&
		get.timestamp - episode.last_timestamp <= EPISODE_GAP_SEC * 1000,
	);
}

function findOccurrences(episode, fragmentId) {
	const occurrences = [];
	for (const [index, search] of episode.searches.entries()) {
		for (const result of search.results) {
			if (result.fragment_id !== fragmentId) continue;
			occurrences.push({ iteration: index + 1, source_line: search.source_line, rank: result.rank, raw_similarity: result.raw_similarity });
		}
	}
	return occurrences;
}

function histogram(values) {
	const output = {};
	for (const value of values) {
		const key = value >= 4 ? "≥4" : String(value);
		output[key] = (output[key] ?? 0) + 1;
	}
	return output;
}

function sanitizeGet(get, status, episodeIdValue = null) {
	return {
		source_line: get.source_line,
		ts: get.ts,
		fragment_id: get.fragment_id,
		agent_id: get.agent_id,
		query_hash: get.query_hash,
		confirmed_by: get.confirmed_by,
		status,
		episode_id: episodeIdValue,
	};
}

function attachGets(episodes, gets) {
	const assigned = new Map(episodes.map((episode) => [episode.episode_id, []]));
	const ambiguousGets = [];
	const orphanGets = [];
	for (const get of gets) {
		const candidates = episodeCandidates(episodes, get);
		if (candidates.length !== 1) {
			const status = candidates.length ? "ambiguous_episode_match" : "no_episode_match";
			const item = sanitizeGet(get, status);
			if (candidates.length) ambiguousGets.push({ ...item, candidate_episode_ids: candidates.map((episode) => episode.episode_id) });
			else orphanGets.push(item);
			continue;
		}
		const episode = candidates[0];
		const occurrences = findOccurrences(episode, get.fragment_id);
		if (!occurrences.length) {
			orphanGets.push(sanitizeGet(get, "target_not_in_episode_search", episode.episode_id));
			continue;
		}
		assigned.get(episode.episode_id).push({ get, occurrences });
	}
	return { assigned, ambiguousGets, orphanGets };
}

function summarizeEpisode(episode, assignedGets, ambiguousGets) {
	const targetFragments = [...new Set(assignedGets.map((item) => item.get.fragment_id))];
	const reasons = [];
	const ambiguous = ambiguousGets.some((item) => item.candidate_episode_ids?.includes(episode.episode_id)) || targetFragments.length > 1;
	if (ambiguous) reasons.push("ambiguous_target_or_episode");
	if (!assignedGets.length && !ambiguous) reasons.push("no_get_target");
	let targetFragment = targetFragments.length === 1 ? targetFragments[0] : null;
	const occurrences = targetFragment ? findOccurrences(episode, targetFragment) : [];
	if (targetFragment && !occurrences.length) {
		reasons.push("target_not_in_episode_search");
		targetFragment = null;
	}
	const first = occurrences[0] ?? null;
	const last = occurrences[occurrences.length - 1] ?? null;
	const firstIteration = first?.iteration ?? null;
	if (!ambiguous && targetFragment && firstIteration === 1) reasons.push("iteration_1_no_cost");
	if (!ambiguous && targetFragment && firstIteration == null) reasons.push("target_not_observed");
	const eligibleReward = !ambiguous && Boolean(targetFragment) && firstIteration != null && firstIteration >= 2;
	return {
		episode_id: episode.episode_id,
		agent_id: episode.agent === "∅" ? null : episode.agent,
		search_count: episode.searches.length,
		start_ts: episode.searches[0].ts,
		end_ts: episode.searches[episode.searches.length - 1].ts,
		search_source_lines: episode.searches.map((search) => search.source_line),
		search_query_hashes: episode.searches.map((search) => search.query_hash),
		get_event_count: assignedGets.length,
		target_fragments: targetFragments,
		target_fragment: targetFragment,
		ambiguous,
		orphan_get: false,
		targeted_fragment_iteration: firstIteration,
		first_seen_iteration: firstIteration,
		first_seen_rank: first?.rank ?? null,
		final_rank: last?.rank ?? null,
		max_raw_similarity: occurrences.reduce((max, item) => Math.max(max, item.raw_similarity ?? 0), 0),
		target_occurrence_count: occurrences.length,
		candidate_cost: eligibleReward ? costForIteration(firstIteration) : null,
		eligible_reward: eligibleReward,
		skip_reason: reasons.length ? reasons.join(";") : null,
		skip_reasons: reasons,
		get_events: assignedGets.map((item) => sanitizeGet(item.get, "assigned", episode.episode_id)),
	};
}

function readFragmentMeta(memoryRoot, fragmentId) {
	const [date, id, extra] = String(fragmentId).split("/");
	if (!date || !id || extra || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^frag_\d+$/.test(id)) {
		return { status: "invalid_fragment_id", importance: DEFAULT_IMPORTANCE, earned_importance: DEFAULT_EARNED_IMPORTANCE };
	}
	const filePath = path.join(memoryRoot, "fragments", date, `${id}.meta.json`);
	if (!fs.existsSync(filePath)) {
		return { status: "missing_default", path: filePath, importance: DEFAULT_IMPORTANCE, earned_importance: DEFAULT_EARNED_IMPORTANCE };
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		const importance = Number.isFinite(parsed.importance) && parsed.importance >= 0 && parsed.importance <= 1 ? parsed.importance : DEFAULT_IMPORTANCE;
		const earned = Number.isFinite(parsed.earned_importance) && parsed.earned_importance >= 0 && parsed.earned_importance <= 1 ? parsed.earned_importance : DEFAULT_EARNED_IMPORTANCE;
		return {
			status: importance === parsed.importance && earned === (parsed.earned_importance ?? DEFAULT_EARNED_IMPORTANCE) ? "valid" : "invalid_value_default",
			path: filePath,
			importance,
			earned_importance: earned,
		};
	} catch {
		return { status: "invalid_json_default", path: filePath, importance: DEFAULT_IMPORTANCE, earned_importance: DEFAULT_EARNED_IMPORTANCE };
	}
}

export function buildDryRunRecord(episode, memoryRoot, sourceHash, policyVersion = COST_POLICY_VERSION) {
	const fragmentId = episode.target_fragment;
	const meta = fragmentId ? readFragmentMeta(memoryRoot, fragmentId) : null;
	const oldImportance = meta?.importance ?? DEFAULT_IMPORTANCE;
	const oldEarned = meta?.earned_importance ?? DEFAULT_EARNED_IMPORTANCE;
	const cost = episode.candidate_cost ?? 0;
	const newEarned = episode.eligible_reward ? calculateEarnedImportance(oldEarned, cost) : oldEarned;
	const oldEffective = effectiveImportance(oldImportance, oldEarned);
	const newEffective = effectiveImportance(oldImportance, newEarned);
	const targetFragments = episode.target_fragments ?? [];
	const idempotencyKeys = targetFragments.map((target) => buildIdempotencyKey(episode.episode_id, target, sourceHash, policyVersion));
	return {
		episode_id: episode.episode_id,
		fragment_id: fragmentId,
		target_fragments: targetFragments,
		agent_id: episode.agent_id,
		iterations: episode.search_count,
		first_seen_iteration: episode.first_seen_iteration,
		first_seen_rank: episode.first_seen_rank,
		final_rank: episode.final_rank,
		max_raw_similarity: episode.max_raw_similarity,
		candidate_cost: episode.candidate_cost,
		old_importance: oldImportance,
		old_earned_importance: oldEarned,
		preview_earned_importance: newEarned,
		old_effective_importance: oldEffective,
		preview_effective_importance: newEffective,
		old_decay_floor: decayFloor(oldEffective),
		preview_decay_floor: decayFloor(newEffective),
		meta_status: meta?.status ?? "no_target",
		eligible_reward: episode.eligible_reward,
		ambiguous: episode.ambiguous,
		skip_reason: episode.skip_reason,
		skip_reasons: episode.skip_reasons,
		idempotency_key: episode.eligible_reward ? idempotencyKeys[0] : null,
		idempotency_keys: idempotencyKeys,
		policy_version: policyVersion,
		source_hash: sourceHash,
	};
}

function atomicWrite(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.tmp`;
	fs.writeFileSync(tempPath, content, "utf8");
	fs.renameSync(tempPath, filePath);
}

function createReports(memoryRoot, reportPath, dryRunPath) {
	const signalsRoot = path.join(memoryRoot, "signals");
	const searchSource = readJsonl(signalsRoot, "search.jsonl");
	const getSource = readJsonl(signalsRoot, "get_fragment.jsonl");
	const searches = normalizeSearchRows(searchSource);
	const gets = normalizeGetRows(getSource);
	const episodes = buildEpisodes(searches.valid);
	const attached = attachGets(episodes, gets.valid);
	const ambiguousEpisodeIds = new Set(attached.ambiguousGets.flatMap((item) => item.candidate_episode_ids ?? []));
	const episodeRows = episodes.map((episode) => summarizeEpisode(
		episode,
		attached.assigned.get(episode.episode_id) ?? [],
		attached.ambiguousGets.filter((item) => item.candidate_episode_ids?.includes(episode.episode_id)),
	));
	const iterationCounts = episodeRows.map((episode) => episode.search_count);
	const targetedIterations = episodeRows.filter((episode) => episode.first_seen_iteration != null).map((episode) => episode.first_seen_iteration);
	const confirmedBy = { user: 0, agent: 0, null: 0 };
	for (const get of gets.valid) confirmedBy[get.confirmed_by ?? "null"] = (confirmedBy[get.confirmed_by ?? "null"] ?? 0) + 1;
	const sourceHash = hash(canonicalJson({ search_jsonl: searchSource.content, get_fragment_jsonl: getSource.content }));
	const phase0 = {
		report_schema_version: REPORT_SCHEMA_VERSION,
		report_type: "p3-phase0-signal-analysis",
		analyzer_version: ANALYZER_VERSION,
		generated_at: new Date().toISOString(),
		read_only: true,
		apply_performed: false,
		memory_root: memoryRoot,
		signals_root: signalsRoot,
		report_path: reportPath,
		source_hash: sourceHash,
		source_files: {
			search: { path: searchSource.filePath, bytes: Buffer.byteLength(searchSource.content, "utf8"), sha256: hash(searchSource.content), invalid_lines: searchSource.invalidLines.length },
			get_fragment: { path: getSource.filePath, bytes: Buffer.byteLength(getSource.content, "utf8"), sha256: hash(getSource.content), invalid_lines: getSource.invalidLines.length },
		},
		policy: { episode_gap_seconds: EPISODE_GAP_SEC, cost_policy_version: COST_POLICY_VERSION, cost_policy: COST_POLICY, note: "experimental candidate only; Phase 0 never updates fragment metadata" },
		counts: {
			search_events: searches.valid.length,
			get_events: gets.valid.length,
			episodes: episodeRows.length,
			episodes_with_assigned_get: episodeRows.filter((episode) => episode.get_event_count > 0).length,
			targeted_episodes: episodeRows.filter((episode) => episode.target_fragment != null).length,
			eligible_reward_episodes: episodeRows.filter((episode) => episode.eligible_reward).length,
			ambiguous_episodes: episodeRows.filter((episode) => episode.ambiguous || ambiguousEpisodeIds.has(episode.episode_id)).length,
			orphan_gets: attached.orphanGets.length,
			ambiguous_gets: attached.ambiguousGets.length,
			no_get_target_episodes: episodeRows.filter((episode) => episode.skip_reason === "no_get_target").length,
		},
		confirmed_by: confirmedBy,
		iteration_histogram: histogram(iterationCounts),
		targeted_iteration_histogram: histogram(targetedIterations),
		invalid_events: [...searches.invalid, ...gets.invalid],
		orphan_gets: attached.orphanGets,
		ambiguous_gets: attached.ambiguousGets,
		episodes: episodeRows,
	};
	const dryRunRecords = episodeRows.map((episode) => buildDryRunRecord(episode, memoryRoot, sourceHash));
	const dryRun = {
		report_schema_version: 1,
		report_type: "p3-phase1a-dry-run",
		analyzer_version: ANALYZER_VERSION,
		generated_at: new Date().toISOString(),
		read_only: true,
		apply_performed: false,
		memory_root: memoryRoot,
		phase0_report_path: reportPath,
		source_hash: sourceHash,
		policy: phase0.policy,
		counts: {
			episodes: dryRunRecords.length,
			eligible_reward: dryRunRecords.filter((record) => record.eligible_reward).length,
			skipped: dryRunRecords.filter((record) => !record.eligible_reward).length,
			ambiguous: dryRunRecords.filter((record) => record.ambiguous).length,
			iteration_1_skipped: dryRunRecords.filter((record) => record.skip_reasons?.includes("iteration_1_no_cost")).length,
			no_get_target: dryRunRecords.filter((record) => record.skip_reasons?.includes("no_get_target")).length,
		},
		records: dryRunRecords,
	};
	atomicWrite(reportPath, `${JSON.stringify(phase0, null, 2)}\n`);
	if (dryRunPath) atomicWrite(dryRunPath, `${JSON.stringify(dryRun, null, 2)}\n`);
	return { phase0, dryRun };
}

export function run(argv = process.argv.slice(2)) {
	const options = parseOptions(argv);
	const memoryRoot = path.resolve(options.get("memory-root") ?? "memory");
	const signalsRoot = path.join(memoryRoot, "signals");
	const reportPath = path.resolve(options.get("report") ?? path.join(signalsRoot, "p3-phase0-report.json"));
	const dryRun = options.has("dry-run");
	const dryRunPath = dryRun ? path.resolve(options.get("dry-run-report") ?? path.join(signalsRoot, "p3-dry-run.json")) : null;
	const reports = createReports(memoryRoot, reportPath, dryRunPath);
	console.log("=== P3 Phase 0 / Phase 1a 只读分析 ===");
	console.log(`Phase 0 报告：${reportPath}`);
	if (dryRunPath) console.log(`Phase 1a dry-run：${dryRunPath}`);
	console.log(`source_hash：${reports.phase0.source_hash}`);
	console.log(`search：${reports.phase0.counts.search_events} / get_fragment：${reports.phase0.counts.get_events}`);
	console.log(`episode：${reports.phase0.counts.episodes}，迭代分布：${JSON.stringify(reports.phase0.iteration_histogram)}`);
	if (dryRun) {
		console.log(`targeted：${reports.phase0.counts.targeted_episodes}，eligible_reward：${reports.dryRun.counts.eligible_reward}`);
		console.log(`ambiguous：${reports.dryRun.counts.ambiguous}，iteration_1_skipped：${reports.dryRun.counts.iteration_1_skipped}`);
	}
	console.log("apply_performed：false（只读，不修改 meta）");
	return reports;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) run();
