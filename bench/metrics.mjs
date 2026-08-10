import { createHash } from "node:crypto";

export function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
	}
	return value;
}

export function canonicalJson(value) {
	return JSON.stringify(canonical(value));
}

export function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function datasetHash(dataset) {
	const { content_hash: _ignored, ...body } = dataset;
	return sha256(canonicalJson(body));
}

export function ratio(numerator, denominator) {
	return denominator === 0 ? null : numerator / denominator;
}

export function rankOf(results, expectedFragmentId) {
	const index = results.findIndex((result) => result.fragment_id === expectedFragmentId);
	return index < 0 ? null : index + 1;
}

export function retrievalMetrics(rows, topK) {
	const ranks = rows.map((row) => row.rank).filter((rank) => rank !== null);
	const hitCount = ranks.filter((rank) => rank <= topK).length;
	return {
		query_count: rows.length,
		hit_count: hitCount,
		recall_at_k: ratio(hitCount, rows.length),
		mrr: rows.length ? rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length : null,
		all_required_hit_at_k: rows.length ? (hitCount === rows.length ? 1 : 0) : null,
	};
}

export function gateMetrics(rows) {
	const positives = rows.filter((row) => row.evidence_expected === true);
	const negatives = rows.filter((row) => row.evidence_expected === false);
	const truePositive = positives.filter((row) => row.evidence_passed).length;
	const falseNegative = positives.length - truePositive;
	const falsePositive = negatives.filter((row) => row.evidence_passed).length;
	const trueNegative = negatives.length - falsePositive;
	return {
		positive_count: positives.length,
		negative_count: negatives.length,
		true_positive: truePositive,
		false_negative: falseNegative,
		false_positive: falsePositive,
		true_negative: trueNegative,
		evidence_recall: ratio(truePositive, positives.length),
		fpr: ratio(falsePositive, negatives.length),
		tnr: ratio(trueNegative, negatives.length),
		precision: ratio(truePositive, truePositive + falsePositive),
	};
}
