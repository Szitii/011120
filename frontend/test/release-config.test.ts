import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Expo release config rejects a development token and non-real builds", () => {
  const check = (nodeEnv: "development" | "production", mode: string, token?: string, easBuild = "false") => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv, EXPO_PUBLIC_DATA_MODE: mode, EAS_BUILD: easBuild };
    delete env.EXPO_PUBLIC_OWNER_BEARER_TOKEN;
    if (token !== undefined) env.EXPO_PUBLIC_OWNER_BEARER_TOKEN = token;
    return spawnSync(process.execPath, ["--input-type=module", "-e",
      'import config from "./app.config.ts"; config({ config: {} });'], { env, encoding: "utf8" });
  };

  assert.match(check("production", "real", "release-test-token").stderr, /Remove EXPO_PUBLIC_OWNER_BEARER_TOKEN/);
  assert.match(check("development", "real", "release-test-token", "true").stderr, /Remove EXPO_PUBLIC_OWNER_BEARER_TOKEN/);
  assert.match(check("production", "mock").stderr, /require EXPO_PUBLIC_DATA_MODE=real/);
  assert.equal(check("production", "real").status, 0);
  assert.equal(check("development", "dev", "release-test-token").status, 0);
});
