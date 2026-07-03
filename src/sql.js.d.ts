declare module "sql.js" {
	interface SqlJsStatic {
		Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
	}

	interface Database {
		exec(sql: string): QueryResult[];
		close(): void;
	}

	interface QueryResult {
		columns: string[];
		values: any[][];
	}

	export type { Database };
	export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}
