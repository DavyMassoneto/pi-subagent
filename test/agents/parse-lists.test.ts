import { test } from "vitest";
import assert from "node:assert/strict";
import { buildAgentDefinition, parseStringList } from "../../src/agents.js";

test("parseStringList accepts CSV, YAML arrays, and absent values", () => {
  assert.deepEqual(parseStringList("read, bash", "tools"), ["read", "bash"]);
  assert.deepEqual(parseStringList(["read", "bash"], "tools"), ["read", "bash"]);
  assert.equal(parseStringList(null, "tools"), undefined);
  assert.equal(parseStringList(undefined, "tools"), undefined);
  assert.equal(parseStringList("none", "tools"), undefined);
});

test("parseStringList keeps string names and skips deny-all objects", () => {
  assert.deepEqual(parseStringList([{ "*": false }, "read", "grep"], "tools"), ["read", "grep"]);
  assert.throws(
    () => parseStringList({ read: true }, "tools"),
    /CSV string or a YAML list, but got object/,
  );
});

test("buildAgentDefinition loads YAML list, CSV, and CRLF frontmatter", () => {
  const yaml = [
    "---",
    "name: yaml-agent",
    "description: YAML list",
    "tools:",
    "  - read",
    "  - bash",
    "---",
    "Prompt",
  ].join("\r\n");
  const csv = "---\nname: csv-agent\ndescription: CSV\ntools: read, grep\n---\nPrompt\n";
  const absent = "---\nname: bare-agent\ndescription: No tools\n---\nPrompt\n";

  const yamlAgent = buildAgentDefinition(yaml, "user");
  const csvAgent = buildAgentDefinition(csv, "user");
  const bareAgent = buildAgentDefinition(absent, "user");
  assert.ok(!("error" in yamlAgent), "error" in yamlAgent ? yamlAgent.error.message : "");
  assert.ok(!("error" in csvAgent), "error" in csvAgent ? csvAgent.error.message : "");
  assert.ok(!("error" in bareAgent), "error" in bareAgent ? bareAgent.error.message : "");
  assert.deepEqual(yamlAgent.tools, ["read", "bash"]);
  assert.deepEqual(csvAgent.tools, ["read", "grep"]);
  assert.equal(bareAgent.tools, undefined);
});

test("buildAgentDefinition keeps gentle-pi deny-all YAML lists", () => {
  const content = [
    "---",
    "name: review-risk",
    "description: Risk",
    "tools:",
    "  - \"*\": false",
    "  - read",
    "  - grep",
    "---",
    "Prompt",
  ].join("\r\n");
  const result = buildAgentDefinition(content, "user");
  assert.ok(!("error" in result), "error" in result ? result.error.message : "");
  assert.deepEqual(result.tools, ["read", "grep"]);
});

test("buildAgentDefinition rejects mixed CSV + YAML list with a visible error", () => {
  const mixed = [
    "---",
    "name: mixed-agent",
    "description: Mixed tools",
    "tools: read, bash",
    "  - grep",
    "---",
    "Prompt",
  ].join("\r\n");
  const result = buildAgentDefinition(mixed, "user");
  assert.ok("error" in result);
  assert.match(result.error.message, /CSV string or a YAML list, not both/);
});
