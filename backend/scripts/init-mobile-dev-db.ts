import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") {
  throw new Error(
    "Set DATABASE_URL and COMPANION_SOCIAL_DEV_DATABASE=1 before initializing the disposable mobile dev database.",
  );
}

const root = process.cwd();
const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "companion-social-mobile-dev-init",
});

const read = async (relativePath: string): Promise<string> =>
  readFile(path.join(root, relativePath), "utf8");

try {
  const existing = await pool.query<{ count: string }>(
    "select count(*)::text as count from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')",
  );
  if (existing.rows[0]?.count !== "0") {
    throw new Error(
      "Refusing to initialize the mobile dev database because public already contains tables. Use a fresh disposable database.",
    );
  }

  const bootstrap = (await read("backend/db-tests/bootstrap.sql"))
    .replace(
      "create role anon nologin;",
      () => "do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;",
    )
    .replace(
      "create role authenticated nologin;",
      () => "do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;",
    )
    .replace(
      "create role service_role nologin bypassrls;",
      () => "do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;",
    );
  await pool.query(bootstrap);

  const migrationDir = path.join(root, "backend", "supabase", "migrations");
  const migrations = (await readdir(migrationDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const migration of migrations) {
    await pool.query(await read(path.join("backend", "supabase", "migrations", migration)));
  }

  await pool.query(await read("backend/db-tests/mobile-dev-seed.sql"));

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(
      "select set_config('request.jwt.claim.sub',$1,true)",
      ["00000000-0000-0000-0000-0000000000a1"],
    );

    const identity = await client.query<{ payload: Record<string, unknown> }>(
      "select * from public.get_active_identity_context($1,$2)",
      ["OWNER", null],
    );
    const world = await client.query<{ item: { author?: { companionId?: string } } }>(
      "select * from public.list_world_items($1,$2)",
      [20, null],
    );
    const sample_companion = await client.query<{ payload: Record<string, unknown> }>(
      "select * from public.get_active_identity_context($1,$2)",
      ["COMPANION", "00000000-0000-0000-0000-0000000002a1"],
    );

    if (
      identity.rows.length !== 1 ||
      sample_companion.rows.length !== 1 ||
      (identity.rows[0]?.payload as { activeSubject?: { presentation?: { displayName?: string } } }).activeSubject?.presentation?.displayName !== "SampleUser"
    ) {
      throw new Error("Mobile dev identity presentation fixtures failed validation.");
    }

    const another = world.rows.find((row) => row.item.author?.companionId === "00000000-0000-0000-0000-0000000002b1");
    if (!another?.item.author?.companionId) {
      throw new Error("Mobile dev feed actor mapping failed validation.");
    }

    const profile = await client.query<{ payload: { companionId?: string } }>(
      "select * from public.get_companion_profile($1)",
      [another.item.author.companionId],
    );
    if (profile.rows[0]?.payload.companionId !== "00000000-0000-0000-0000-0000000002b1") {
      throw new Error("Mobile dev profile fixture failed validation.");
    }

    await client.query("rollback");
  } finally {
    client.release();
  }

  process.stdout.write(
    [
      "Stage 1 mobile dev database initialized and validated.",
      "Owner auth subject: 00000000-0000-0000-0000-0000000000a1",
      "SampleCompanion Companion:   00000000-0000-0000-0000-0000000002a1",
      "",
    ].join("\n"),
  );
} finally {
  await pool.end();
}
