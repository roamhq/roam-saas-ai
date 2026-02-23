import type { Env, DatabaseConnection } from "../types";
import mysql2 from "mysql2/promise";

/** Tenant names are lowercase alphanumeric with underscores only */
const VALID_TENANT = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Validate tenant name to prevent SQL injection via the table prefix.
 * Tenant names become SQL identifiers (e.g. `vicheartland.craft_elements`),
 * so they must be strictly alphanumeric.
 */
export function validateTenant(tenant: string): string {
  if (!VALID_TENANT.test(tenant)) {
    throw new Error(`Invalid tenant name: "${tenant}"`);
  }
  return tenant;
}

/**
 * Create a database connection via Hyperdrive.
 *
 * Single Hyperdrive config points at the Aurora cluster.
 * Since Hyperdrive doesn't support USE statements, we prefix
 * all table references with the tenant database name.
 *
 * IMPORTANT: Hyperdrive does not support MySQL prepared statements
 * (COM_STMT_PREPARE), so we must use query() not execute().
 */
export function createConnection(env: Env, tenant?: string): DatabaseConnection {
  // mysql2/promise Connection type has query() via QueryableBase but the
  // exported type hierarchy doesn't always surface it. Use the inferred type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let conn: any = null;
  const dbPrefix = validateTenant(tenant ?? env.DEFAULT_TENANT);

  const getConnection = async () => {
    if (!conn) {
      conn = await mysql2.createConnection({
        host: env.DB.host,
        port: env.DB.port,
        user: env.DB.user,
        password: env.DB.password,
        database: env.DB.database,
        enableKeepAlive: false,
        // Workers runtime blocks eval() - mysql2 needs this flag
        disableEval: true,
      });
    }
    return conn;
  };

  return {
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[]
    ): Promise<T[]> {
      const c = await getConnection();
      // Prefix all craft_ table references with the tenant database name
      // e.g. craft_elements -> vicheartland.craft_elements
      const prefixedSql = sql.replace(/\bcraft_/g, `${dbPrefix}.craft_`);
      const [rows] = await c.query(prefixedSql, params ?? []);
      return rows as T[];
    },

    async close(): Promise<void> {
      if (conn) {
        await conn.end();
        conn = null;
      }
    },
  };
}
