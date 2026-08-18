import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, resolveDiscoveryDirs } from "../../src/agents.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";

const previousAgentDir = process.env.PI_AGENT_DIR;

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = previousAgentDir;
});

function agentMarkdown(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name}\n${extra}---\nPrompt for ${name}\n`;
}

test("discovery loads user/project agents and subagents, cwd only", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-discovery-"));
  const user = join(root, "user");
  const project = join(root, "project");
  const ancestor = join(root, "ancestor");
  process.env.PI_AGENT_DIR = user;

  await mkdir(join(user, "agents"), { recursive: true });
  await mkdir(join(user, "subagents"), { recursive: true });
  await mkdir(join(project, ".pi", "agents"), { recursive: true });
  await mkdir(join(project, ".pi", "subagents"), { recursive: true });
  await mkdir(join(ancestor, ".pi", "agents"), { recursive: true });
  await mkdir(join(project, "nested"), { recursive: true });

  await writeFile(join(user, "agents", "user-agent.md"), agentMarkdown("user-agent", "tools: read\n"));
  await writeFile(join(user, "subagents", "user-sub.md"), agentMarkdown("user-sub", "tools:\n  - grep\n"));
  await writeFile(join(project, ".pi", "agents", "project-agent.md"), agentMarkdown("project-agent"));
  await writeFile(join(project, ".pi", "subagents", "project-sub.md"), agentMarkdown("project-sub"));
  await writeFile(join(ancestor, ".pi", "agents", "ancestor.md"), agentMarkdown("ancestor"));

  const registry = new AgentRegistry();
  await registry.reload(project);

  assert.deepEqual([...registry.agents.keys()].sort(), [
    "project-agent",
    "project-sub",
    "user-agent",
    "user-sub",
  ]);
  assert.deepEqual(registry.agents.get("user-agent")?.tools, ["read"]);
  assert.deepEqual(registry.agents.get("user-sub")?.tools, ["grep"]);

  const nested = new AgentRegistry();
  await nested.reload(join(project, "nested"), { discovery: { includeUserAgents: false } });
  assert.equal(nested.agents.has("project-agent"), false);
  assert.equal(nested.agents.has("ancestor"), false);
});

test("resolveDiscoveryDirs is cwd plus user agents/subagents", () => {
  process.env.PI_AGENT_DIR = "C:/tmp/pi-agent";
  const dirs = resolveDiscoveryDirs("D:/repo", DEFAULT_SUBAGENT_SETTINGS.agentDiscovery);
  assert.deepEqual(dirs.map(([dir]) => dir.replaceAll("\\", "/")), [
    "C:/tmp/pi-agent/agents",
    "C:/tmp/pi-agent/subagents",
    "D:/repo/.pi/agents",
    "D:/repo/.pi/subagents",
  ]);
});
