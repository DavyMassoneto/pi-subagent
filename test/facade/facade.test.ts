import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildFacadePrompt,
  defineGentleFacadeTools,
  FACADE_TOOL_NAMES,
  resolveFacadeAgentNames,
  resolveTaskId,
  shouldJoinAfterStart,
} from "../../src/facade.js";

test("facade helpers map Joker run shape onto Pi9 spawn/join", () => {
  assert.deepEqual(resolveFacadeAgentNames({ agent: "review-risk" }), ["review-risk"]);
  assert.deepEqual(resolveFacadeAgentNames({ agents: ["a", "b"], agent: "a" }), ["a", "b"]);
  assert.equal(buildFacadePrompt("do it", "cwd=D:/repo"), "do it\n\ncwd=D:/repo");
  assert.equal(shouldJoinAfterStart(undefined), true);
  assert.equal(shouldJoinAfterStart("task"), true);
  assert.equal(shouldJoinAfterStart("background"), false);
  assert.equal(resolveTaskId({ task_id: "agile-otter" }), "agile-otter");
  assert.equal(resolveTaskId({ subagentId: "agile-otter" }), "agile-otter");
});

test("facade registers the gentle-pi tool names", () => {
  const tools = defineGentleFacadeTools({
    runtime: {} as never,
    agentRegistry: { summarizeAgent: () => "" } as never,
    prepareInvocation: async () => ({}) as never,
  });
  assert.deepEqual(tools.map(tool => tool.name), [...FACADE_TOOL_NAMES]);
});
