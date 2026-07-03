// Pure JS SQLite reader, no native deps needed
import { execSync } from "node:child_process";
import * as fs from "node:fs";

const dbPath = "D:/LenovoSoftstore/CherryData/Data/agents.db";
const outPath = "D:/AgentStore/memory-mcp-server/db_schema.txt";

// Step 1: Install sql.js if needed
const sqlJsPath = "D:/AgentStore/memory-mcp-server/node_modules/sql.js";
if (!fs.existsSync(sqlJsPath)) {
	console.log("Installing sql.js (pure JS SQLite)...");
	execSync("cd D:/AgentStore/memory-mcp-server && npm install sql.js", { stdio: "inherit" });
}

// Step 2: Use sql.js to query
import("sql.js").then(async (mod) => {
	const initSqlJs = mod.default;
	const SQL = await initSqlJs();
	const buf = fs.readFileSync(dbPath);
	const db = new SQL.Database(buf);

	// Get all tables
	const tables = db.exec(
		"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
	);
	const tableNames = tables[0]?.values?.flat() || [];

	let output = "=== Tables ===\n" + tableNames.join("\n") + "\n\n";

	for (const name of tableNames) {
		if (name === "sqlite_sequence") continue;

		// Dump schema
		const schemas = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${name}';`);
		if (schemas[0]?.values?.[0]?.[0]) {
			output += `\n=== ${name} ===\n${schemas[0].values[0][0]};\n`;
		}

		// Sample rows
		try {
			const rows = db.exec(`SELECT * FROM "${name}" LIMIT 5;`);
			if (rows[0]) {
				const cols = rows[0].columns.join(" | ");
				output += `\nColumns: ${rows[0].columns.join(", ")}\n`;
				for (const row of rows[0].values.slice(0, 3)) {
					const vals = row.map(v => String(v ?? "").slice(0, 80)).join(" | ");
					output += `  ${vals}\n`;
				}
			}
		} catch (e) {
			output += `  (query error: ${e.message})\n`;
		}
	}

	// Detailed view of sessions and session_messages
	output += "\n=== sessions DETAIL ===\n";
	const sessionSchema = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions';`);
	if (sessionSchema[0]) output += sessionSchema[0].values[0][0] + ";\n";
	const sessionRows = db.exec("SELECT * FROM sessions LIMIT 5;");
	if (sessionRows[0]) {
		output += "Columns: " + sessionRows[0].columns.join(", ") + "\n";
		for (const r of sessionRows[0].values) {
			const vals = r.map(v => String(v ?? "").slice(0, 60)).join(" | ");
			output += `  ${vals}\n`;
		}
	}

	output += "\n=== session_messages DETAIL ===\n";
	const msgSchema = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_messages';`);
	if (msgSchema[0]) output += msgSchema[0].values[0][0] + ";\n";
	const msgRows = db.exec("SELECT * FROM session_messages LIMIT 5;");
	if (msgRows[0]) {
		output += "Columns: " + msgRows[0].columns.join(", ") + "\n";
		for (const r of msgRows[0].values) {
			const vals = r.map(v => String(v ?? "").slice(0, 100)).join(" | ");
			output += `  ${vals}\n`;
		}
	}

	// Count messages per session
	output += "\n=== Messages per session ===\n";
	const counts = db.exec(`SELECT session_id, COUNT(*) as cnt FROM session_messages GROUP BY session_id ORDER BY cnt DESC;`);
	if (counts[0]) {
		output += "session_id | count\n";
		for (const r of counts[0].values) {
			output += `  ${r[0]?.toString().slice(0,20)} | ${r[1]}\n`;
		}
	}

	fs.writeFileSync(outPath, output);
	console.log("Done! Output written to: " + outPath);

	db.close();
});
