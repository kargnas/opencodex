import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadConfig,
  saveConfig,
  setRuntimeDir,
  writePid,
  writeRuntimePort,
  removePid,
  removeRuntimePort,
  withConfigMutationLockSync,
} from "../src/config";
import {
  credentialGeneration,
  mergeAccountCredential,
  replaceProviderAccountSet,
  getAccountCredential,
} from "../src/oauth/store";
import { appendUsageEntry } from "../src/usage/log";

let home = "";
const configUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
const oauthUrl = pathToFileURL(join(import.meta.dir, "../src/oauth/store.ts")).href;
const usageUrl = pathToFileURL(join(import.meta.dir, "../src/usage/log.ts")).href;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-slot-shared-"));
  process.env.OPENCODEX_HOME = home;
  saveConfig({ port: 10100, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function child(source: string) {
  const spawned = Bun.spawn([globalThis.process.execPath, "-e", source], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODEX_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await spawned.exited;
  const [stderr, stdout] = await Promise.all([
    new Response(spawned.stderr).text(),
    new Response(spawned.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error(`child exited ${exitCode}: ${stderr}`);
  return stdout;
}

async function waitFor(path: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("child slots keep lifecycle records independent while sharing durable home", async () => {
  const source = (runtime: string, pid: number, port: number, ready: string, release: string) => `
    import { existsSync, writeFileSync } from "node:fs";
    import { setRuntimeDir, writePid, writeRuntimePort, removePid, removeRuntimePort } from ${JSON.stringify(configUrl)};
    setRuntimeDir(${JSON.stringify(runtime)});
    writePid(${pid});
    writeRuntimePort({ pid: ${pid}, port: ${port} });
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
    removePid(${pid});
    removeRuntimePort(${pid});
  `;
  const a = join(home, "slot-a"), b = join(home, "slot-b");
  const aReady = join(home, "a.ready"), bReady = join(home, "b.ready");
  const aRelease = join(home, "a.release"), bRelease = join(home, "b.release");
  const first = Bun.spawn([process.execPath, "-e", source(a, 4101, 11101, aReady, aRelease)], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCODEX_HOME: home }, stdin: "ignore" });
  const second = Bun.spawn([process.execPath, "-e", source(b, 4102, 11102, bReady, bRelease)], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCODEX_HOME: home }, stdin: "ignore" });
  await Promise.all([waitFor(aReady), waitFor(bReady)]);
  expect(readFileSync(join(a, "ocx.pid"), "utf8")).toBe("4101");
  expect(readFileSync(join(b, "ocx.pid"), "utf8")).toBe("4102");
  expect(JSON.parse(readFileSync(join(a, "runtime-port.json"), "utf8")).port).toBe(11101);
  expect(JSON.parse(readFileSync(join(b, "runtime-port.json"), "utf8")).port).toBe(11102);
  writeFileSync(aRelease, "release");
  writeFileSync(bRelease, "release");
  expect(await first.exited).toBe(0);
  expect(await second.exited).toBe(0);
  expect(existsSync(join(a, "ocx.pid"))).toBe(false);
  expect(existsSync(join(b, "runtime-port.json"))).toBe(false);
});

test("shared config, OAuth CAS, and usage append survive concurrent child writers", async () => {
  const configSource = (field: string, value: string) => `
    import { loadConfig, saveConfig, withConfigMutationLockSync } from ${JSON.stringify(configUrl)};
    let succeeded = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { withConfigMutationLockSync(() => { const config = loadConfig(); (config as any)[${JSON.stringify(field)}] = ${field === "port" ? Number(value) : JSON.stringify(value)}; saveConfig(config); }); succeeded = true; break; }
      catch { Bun.sleepSync(10); }
    }
    if (!succeeded) throw new Error("config mutation retries exhausted");
  `;
  await Promise.all([
    child(configSource("port", "20101")),
    child(configSource("hostname", "127.0.0.2")),
  ]);
  expect(loadConfig().port).toBe(20101);
  expect(loadConfig().hostname).toBe("127.0.0.2");

  const initial = { refresh: "refresh-0", access: "access-0", expires: Date.now() + 60_000 };
  await replaceProviderAccountSet("anthropic", { activeAccountId: "acct", accounts: [{ id: "acct", credential: initial }] });
  const staleGeneration = credentialGeneration(initial);
  const oauthSource = (ready: string, release: string) => `
    import { existsSync, writeFileSync } from "node:fs";
    import { mergeAccountCredential } from ${JSON.stringify(oauthUrl)};
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
    const result = await mergeAccountCredential("anthropic", "acct", { refresh: "refresh-new", access: "access-new", expires: Date.now() + 60_000 }, { expectedGeneration: process.argv[2] });
    console.log(JSON.stringify(result));
  `;
  const oauthAReady = join(home, "oauth-a.ready"), oauthBReady = join(home, "oauth-b.ready");
  const oauthRelease = join(home, "oauth.release");
  const oauthA = child(oauthSource(oauthAReady, oauthRelease).replace("process.argv[2]", JSON.stringify(staleGeneration)));
  const oauthB = child(oauthSource(oauthBReady, oauthRelease).replace("process.argv[2]", JSON.stringify(staleGeneration)));
  await Promise.all([waitFor(oauthAReady), waitFor(oauthBReady)]);
  writeFileSync(oauthRelease, "release");
  const [fresh, stale] = await Promise.all([oauthA, oauthB]);
  expect(getAccountCredential("anthropic", "acct")?.refresh).toBe("refresh-new");
  expect([JSON.parse(fresh).superseded, JSON.parse(stale).superseded].sort()).toEqual([false, true]);

  const usageSource = (prefix: string, ready: string, release: string) => `
    import { existsSync, writeFileSync } from "node:fs";
    import { appendUsageEntry } from ${JSON.stringify(usageUrl)};
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
    for (let i = 0; i < 12; i++) appendUsageEntry({ requestId: ${JSON.stringify(prefix)} + i, timestamp: i, provider: "openai", model: "gpt-test", status: 200, durationMs: 1, usageStatus: "reported" });
  `;
  const usageAReady = join(home, "usage-a.ready"), usageBReady = join(home, "usage-b.ready");
  const usageRelease = join(home, "usage.release");
  const usageA = child(usageSource("a-", usageAReady, usageRelease));
  const usageB = child(usageSource("b-", usageBReady, usageRelease));
  await Promise.all([waitFor(usageAReady), waitFor(usageBReady)]);
  writeFileSync(usageRelease, "release");
  await Promise.all([usageA, usageB]);
  const rows = readFileSync(join(home, "usage.jsonl"), "utf8").trim().split(String.fromCharCode(10)).map(line => JSON.parse(line));
  expect(rows).toHaveLength(24);
  expect(new Set(rows.map(row => row.requestId)).size).toBe(24);
});
