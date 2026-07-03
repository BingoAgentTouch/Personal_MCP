import { execSync } from "node:child_process";
import * as fs from "node:fs";

const dbPath = "D:/LenovoSoftstore/CherryData/Data/agents.db";
const outPath = "D:/AgentStore/memory-mcp-server/db_schema.txt";

// Try using sqlite3 CLI if available
try {
	const out = execSync(`sqlite3 "${dbPath}" ".tables"`, { encoding: "utf-8", timeout: 5000 });
	fs.writeFileSync(outPath, "=== Tables ===\n" + out + "\n\n=== Schema ===\n");

	// Dump schema
	const schema = execSync(`sqlite3 "${dbPath}" ".schema"`, { encoding: "utf-8", timeout: 5000 });
	fs.appendFileSync(outPath, schema);

	// Dump a sample of each table
	const tables = out.trim().split(/\s+/);
	for (const table of tables) {
		if (!table || table === "sqlite_sequence") continue;
		try {
			const sample = execSync(`sqlite3 "${dbPath}" "SELECT * FROM \\"${table}\\" LIMIT 3;"`, { encoding: "utf-8", timeout: 5000 });
			fs.appendFileSync(outPath, `\n=== ${table} (3 rows) ===\n${sample}\n`);
		} catch {}
	}

	console.log("Schema dumped to: " + outPath);
} catch {
	console.log("sqlite3 not available, trying alternate approach...");

	// Read raw bytes and look for CREATE TABLE
	const buf = fs.readFileSync(dbPath);
	const text = buf.toString("utf-8");

	// Find all CREATE TABLE statements with regex (multiline)
	const re = /CREATE\s+TABLE\s+\w+\s*\([^)]*\)/gis;
	let match;
	const results = [];
	while ((match = re.exec(text)) !== null) {
		results.push(match[0]);
	}

	if (results.length > 0) {
		fs.writeFileSync(outPath, results.join("\n\n---\n\n"));
		console.log("Found " + results.length + " CREATE TABLE statements");
		console.log("Written to: " + outPath);
	} else {
		console.log("No CREATE TABLE found in raw bytes");
		// Check the full user data for conversation storage
		exploreDir("D:/LenovoSoftstore/CherryData/Data");
	}
}

function exploreDir(dir) {
	fs.writeFileSync(outPath, `=== Exploring ${dir} ===\n\n`);
	const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		const fullPath = dir + "/" + entry.name;
		if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".db"))) {
			fs.appendFileSync(outPath, fullPath + "\n");
		}
	}
	console.log("Directory listing written to: " + outPath);
}
