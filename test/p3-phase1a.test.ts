import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const analyzer = await import("../analyze_signals.mjs");

function writeSignalFixture(searches: unknown[], gets: unknown[], meta?: { fragmentId: string; importance?: number }) {
	const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-p3-"));
	const signalsRoot = path.join(memoryRoot, "signals");
	fs.mkdirSync(signalsRoot, { recursive: true });
	fs.writeFileSync(path.join(signalsRoot, "search.jsonl"), searches.map((row) => JSON.stringify(row)).join("\n") + "\n");
	fs.writeFileSync(path.join(signalsRoot, "get_fragment.jsonl"), gets.map((row) => JSON.stringify(row)).join("\n") + "\n");
	if (meta) {
		const [date, id] = meta.fragmentId.split("/");
		const fragmentRoot = path.join(memoryRoot, "fragments", date);
		fs.mkdirSync(fragmentRoot, { recursive: true });
		fs.writeFileSync(path.join(fragmentRoot, `${id}.meta.json`), JSON.stringify({ importance: meta.importance ?? 0.5 }));
	}
	return memoryRoot;
}

function runDryRun(memoryRoot: string) {
	const reportPath = path.join(memoryRoot, "phase0.json");
	const dryRunPath = path.join(memoryRoot, "dry-run.json");
	return analyzer.run([
		"--memory-root", memoryRoot,
		"--report", reportPath,
		"--dry-run",
		"--dry-run-report", dryRunPath,
	]);
}

describe("P3 Phase 1a dry-run calculations", () => {
	test("cost policy does not reward a first-iteration hit", () => {
		assert.equal(analyzer.costForIteration(1), 0);
		assert.equal(analyzer.costForIteration(2), 0.1);
		assert.equal(analyzer.costForIteration(3), 0.2);
		assert.equal(analyzer.costForIteration(4), 0.3);
		assert.equal(analyzer.costForIteration(12), 0.3);
	});

	test("earned importance uses bounded diminishing returns", () => {
	assert.equal(analyzer.calculateEarnedImportance(0, 0.1), 0.1);
	assert.equal(analyzer.calculateEarnedImportance(0.5, 0.2), 0.6);
	assert.equal(analyzer.calculateEarnedImportance(0.95, 0.3), 0.965);
	assert.equal(analyzer.calculateEarnedImportance(1, 0.3), 1);
	assert.throws(() => analyzer.calculateEarnedImportance(Number.NaN, 0.1), /finite/);
	assert.throws(() => analyzer.calculateEarnedImportance(0, -0.1), /within/);
	assert.throws(() => analyzer.calculateEarnedImportance(0, 1.1), /within/);
	});

	test("effective importance preserves base importance and P2 decay mapping", () => {
	assert.equal(analyzer.effectiveImportance(0.8, 0.2), 0.8);
	assert.equal(analyzer.effectiveImportance(0.2, 0.8), 0.8);
	assert.ok(Math.abs(analyzer.decayFloor(analyzer.effectiveImportance(0.2, 0.8)) - 0.62) < 1e-12);
	assert.equal(analyzer.decayFloor(analyzer.effectiveImportance(0.5, 0)), 0.5);
	});

	test("idempotency key is stable and changes with source, policy, or get event", () => {
		const first = analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:source", "retrieval-cost-pre-get-search-count-v1-experimental", 3);
		assert.equal(first, analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:source", "retrieval-cost-pre-get-search-count-v1-experimental", 3));
		assert.notEqual(first, analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:other", "retrieval-cost-pre-get-search-count-v1-experimental", 3));
		assert.notEqual(first, analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:source", "retrieval-cost-v2", 3));
		assert.notEqual(first, analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:source", "retrieval-cost-pre-get-search-count-v1-experimental", 4));
		});

	test("user-confirmed get uses only pre-get searches and can reward a first-round target", () => {
		const fragmentId = "2026-08-04/frag_001";
		const searches = [
			{ ts: "2026-08-04T10:00:00.000Z", query: "first", agent_id: null, results: [{ fragment_id: fragmentId, rank: 2, raw_similarity: 0.4 }] },
			{ ts: "2026-08-04T10:01:00.000Z", query: "refine", agent_id: null, results: [{ fragment_id: fragmentId, rank: 3, raw_similarity: 0.35 }] },
			{ ts: "2026-08-04T10:03:00.000Z", query: "after-get-1", agent_id: null, results: [{ fragment_id: fragmentId, rank: 1, raw_similarity: 0.9 }] },
			{ ts: "2026-08-04T10:04:00.000Z", query: "after-get-2", agent_id: null, results: [{ fragment_id: fragmentId, rank: 1, raw_similarity: 0.95 }] },
		];
		const gets = [{ ts: "2026-08-04T10:02:00.000Z", fragment_id: fragmentId, agent_id: null, confirmed_by: "user", query: "refine" }];
		const reports = runDryRun(writeSignalFixture(searches, gets, { fragmentId, importance: 0.5 }));
		const record = reports.dryRun.records.find((item: { fragment_id: string }) => item.fragment_id === fragmentId);
		assert.ok(record);
		assert.equal(record.episode_search_count, 4);
		assert.equal(record.pre_get_search_count, 2);
		assert.equal(record.post_get_search_count, 2);
		assert.equal(record.iterations, 2);
		assert.equal(record.first_seen_iteration, 1);
		assert.equal(record.final_rank, 3);
		assert.equal(record.candidate_cost, 0.1);
		assert.equal(record.eligible_reward, true);
		assert.equal(record.eligibility_basis, "pre_get_search_count+user_confirmation");
		assert.equal(record.skip_reason, null);
		assert.equal(reports.dryRun.policy.cost_basis, "pre_get_search_count");
	});

	test("agent confirmation still requires delayed target visibility", () => {
		const fragmentId = "2026-08-04/frag_002";
		const searches = [
			{ ts: "2026-08-04T11:00:00.000Z", query: "first", agent_id: null, results: [{ fragment_id: fragmentId, rank: 1, raw_similarity: 0.6 }] },
			{ ts: "2026-08-04T11:01:00.000Z", query: "refine", agent_id: null, results: [{ fragment_id: fragmentId, rank: 2, raw_similarity: 0.5 }] },
		];
		const gets = [{ ts: "2026-08-04T11:02:00.000Z", fragment_id: fragmentId, agent_id: null, confirmed_by: "agent" }];
		const reports = runDryRun(writeSignalFixture(searches, gets));
		const record = reports.dryRun.records.find((item: { fragment_id: string }) => item.fragment_id === fragmentId);
		assert.ok(record);
		assert.equal(record.eligible_reward, false);
		assert.equal(record.skip_reason, "iteration_1_without_user_confirmation");
	});

	test("apply is source-bound and idempotent", () => {
		const fragmentId = "2026-08-04/frag_003";
		const memoryRoot = writeSignalFixture(
			[
				{ ts: "2026-08-04T12:00:00.000Z", query: "first", agent_id: null, results: [{ fragment_id: fragmentId, rank: 2, raw_similarity: 0.4 }] },
				{ ts: "2026-08-04T12:01:00.000Z", query: "refine", agent_id: null, results: [{ fragment_id: fragmentId, rank: 3, raw_similarity: 0.35 }] },
			],
			[{ ts: "2026-08-04T12:02:00.000Z", fragment_id: fragmentId, agent_id: null, confirmed_by: "user" }],
			{ fragmentId, importance: 0.2 },
		);
		const reports = runDryRun(memoryRoot);
		const ledgerPath = path.join(memoryRoot, "signals", "p3-earned-events.jsonl");
		const firstApply = analyzer.applyDryRunReport(memoryRoot, path.join(memoryRoot, "dry-run.json"), ledgerPath);
		assert.equal(firstApply.results[0].status, "applied");
		assert.equal(firstApply.results[0].new_earned_importance, 0.1);
		const secondApply = analyzer.applyDryRunReport(memoryRoot, path.join(memoryRoot, "dry-run.json"), ledgerPath);
		assert.equal(secondApply.results[0].status, "already_applied");
		const meta = JSON.parse(fs.readFileSync(path.join(memoryRoot, "fragments", "2026-08-04", "frag_003.meta.json"), "utf8"));
		assert.equal(meta.earned_importance, 0.1);
		assert.equal(meta.earned_event_count, 1);
		assert.equal(fs.readFileSync(ledgerPath, "utf8").trim().split("\\n").length, 1);
		assert.equal(reports.dryRun.counts.eligible_reward, 1);
	});
});
