const pools = new Map();

export async function getPgPool(config) {
  const databaseUrl = requireDatabaseUrl(config);
  if (pools.has(databaseUrl)) return pools.get(databaseUrl);
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
  });
  pools.set(databaseUrl, pool);
  return pool;
}

export async function withPgClient(config, callback) {
  const pool = await getPgPool(config);
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function checkPgConnection(config) {
  return withPgClient(config, async (client) => {
    const result = await client.query("select now() as now");
    return { ok: true, now: result.rows[0]?.now };
  });
}

export function requireDatabaseUrl(config) {
  const databaseUrl = String(config.databaseUrl || "").trim();
  if (!databaseUrl) {
    throw new Error("缺少 DATABASE_URL，无法连接 PostgreSQL。");
  }
  return databaseUrl;
}
