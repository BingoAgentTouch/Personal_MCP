import { describe, test } from "node:test";
import assert from "node:assert/strict";

const analyzer = await import("../analyze_signals.mjs");

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

	test("idempotency key is stable and changes with source or policy", () => {
	const first = analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:source");
	assert.equal(first, analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:source"));
	assert.notEqual(first, analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:other"));
	assert.notEqual(first, analyzer.buildIdempotencyKey("episode-1", "2026-08-01/frag_001", "sha256:source", "retrieval-cost-v2"));
	});
});
