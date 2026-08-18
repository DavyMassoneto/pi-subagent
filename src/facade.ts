import { Type } from "typebox";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  agentsAction,
  cancelAction,
  errorResult,
  inspectAction,
  joinAction,
  listAction,
  resumeAction,
  spawnAction,
  steerAction,
  type ActionDeps,
  type ActionResult,
  type SubagentToolDeps,
} from "./tool.js";
import { isSubagentId, type SubagentId } from "./identifiers.js";
import type { ParsedResumeRequest, ParsedSpawnRequest, SubagentTarget } from "./schema.js";

export const FACADE_TOOL_NAMES = [
  "subagent_list_agents",
  "subagent_run",
  "subagent_status",
  "subagent_result",
  "subagent_list_tasks",
  "subagent_cancel",
  "subagent_send_message",
  "subagent_continue",
] as const;

const RunParams = Type.Object({
  agent: Type.Optional(Type.String()),
  agents: Type.Optional(Type.Array(Type.String())),
  task: Type.String(),
  context: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("background")])),
});

const TaskIdParams = Type.Object({
  task_id: Type.Optional(Type.String()),
  subagentId: Type.Optional(Type.String()),
});

const ContinueParams = Type.Object({
  task_id: Type.Optional(Type.String()),
  subagentId: Type.Optional(Type.String()),
  prompt: Type.String(),
  mode: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("background")])),
});

const SendParams = Type.Object({
  task_id: Type.Optional(Type.String()),
  subagentId: Type.Optional(Type.String()),
  message: Type.String(),
});

export function resolveFacadeAgentNames(params: { agent?: string; agents?: string[] }): string[] {
  const names = [
    ...(params.agent ? [params.agent] : []),
    ...(params.agents ?? []),
  ].map(name => name.trim()).filter(Boolean);
  return [...new Set(names)];
}

export function buildFacadePrompt(task: string, context?: string): string {
  return context?.trim() ? `${task}\n\n${context}` : task;
}

export function shouldJoinAfterStart(mode?: "task" | "background"): boolean {
  return mode !== "background";
}

export function resolveTaskId(params: { task_id?: string; subagentId?: string }): string | undefined {
  const id = params.task_id ?? params.subagentId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function attachTaskIds(result: ActionResult): ActionResult {
  const response = result.details.response;
  if (!response || !("results" in response) || !Array.isArray(response.results)) return result;
  const results = response.results.map(entry => {
    if (!entry || typeof entry !== "object") return entry;
    const record = entry;
    const id = "subagentId" in record && typeof record.subagentId === "string"
      ? record.subagentId
      : "task_id" in record && typeof record.task_id === "string"
        ? record.task_id
        : undefined;
    return id ? { ...record, task_id: id, subagentId: "subagentId" in record ? record.subagentId ?? id : id } : entry;
  });
  return {
    ...result,
    content: [{ type: "text" as const, text: JSON.stringify({ ...response, results }, null, 2) }],
  };
}

function extractSpawnedIds(result: ActionResult): string[] {
  const response = result.details.response;
  if (!response || !("results" in response) || !Array.isArray(response.results)) return [];
  return response.results.flatMap(entry => (
    entry
    && typeof entry === "object"
    && "ok" in entry
    && entry.ok
    && "subagentId" in entry
    && typeof entry.subagentId === "string"
      ? [entry.subagentId]
      : []
  ));
}

function asTarget(id: string): SubagentTarget {
  return isSubagentId(id) ? id : { subagentId: id, error: `Invalid subagentId format: ${id}.` };
}

function missingTaskId(action: string): ActionResult {
  return errorResult(`Provide task_id for ${action}.`, "inspect");
}

function requireSubagentId(id: string): SubagentId | ActionResult {
  return isSubagentId(id) ? id : errorResult(`Invalid subagentId format: ${id}.`, "inspect");
}

function isActionResult(value: unknown): value is ActionResult {
  return typeof value === "object" && value !== null && "content" in value && "details" in value;
}

/** Parent-only Joker-shaped facade. Children still get only native `subagent`. */
export function defineGentleFacadeTools(deps: SubagentToolDeps): ToolDefinition[] {
  const { runtime, agentRegistry, prepareInvocation } = deps;
  const actionDeps = (): ActionDeps => ({ runtime, agentRegistry });

  const prepare = async (ctx: ExtensionContext) => {
    await prepareInvocation(ctx);
    return actionDeps();
  };

  return [
    defineTool({
      name: "subagent_list_agents",
      label: "Subagent List Agents",
      description: "List available markdown-defined subagents for delegation.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return attachTaskIds(agentsAction(await prepare(ctx), { action: "agents" }));
      },
    }),
    defineTool({
      name: "subagent_run",
      label: "Subagent Run",
      description: "Delegate a task to one or more markdown-defined subagents. mode=task waits; mode=background returns after spawn.",
      parameters: RunParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const depsForCall = await prepare(ctx);
        const names = resolveFacadeAgentNames(params);
        if (names.length === 0) {
          return errorResult(
            `Provide agent or agents.\n\nAvailable agents:\n${depsForCall.agentRegistry.summarizeAgent()}`,
            "spawn",
          );
        }
        const prompt = buildFacadePrompt(params.task, params.context);
        const spawns: ParsedSpawnRequest[] = names.map(agent => ({
          kind: "spawn",
          agent,
          prompt,
          label: agent,
        }));
        const spawned = await spawnAction(depsForCall, { action: "spawn", spawns }, ctx);
        if (!shouldJoinAfterStart(params.mode)) return attachTaskIds(spawned);
        const ids = extractSpawnedIds(spawned);
        if (ids.length === 0) return attachTaskIds(spawned);
        return attachTaskIds(await joinAction(
          depsForCall,
          { action: "join", subagentIds: ids.map(asTarget) },
          signal,
          onUpdate,
          toolCallId,
        ));
      },
    }),
    defineTool({
      name: "subagent_status",
      label: "Subagent Status",
      description: "Inspect a delegated subagent without waiting.",
      parameters: TaskIdParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const id = resolveTaskId(params);
        if (!id) return missingTaskId("subagent_status");
        return attachTaskIds(inspectAction(await prepare(ctx), {
          action: "inspect",
          subagentIds: [asTarget(id)],
        }));
      },
    }),
    defineTool({
      name: "subagent_result",
      label: "Subagent Result",
      description: "Join and collect a delegated subagent result. Idempotent after collection.",
      parameters: TaskIdParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const id = resolveTaskId(params);
        if (!id) return missingTaskId("subagent_result");
        return attachTaskIds(await joinAction(
          await prepare(ctx),
          { action: "join", subagentIds: [asTarget(id)] },
          signal,
          onUpdate,
          toolCallId,
        ));
      },
    }),
    defineTool({
      name: "subagent_list_tasks",
      label: "Subagent List Tasks",
      description: "List delegated subagent tasks.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return attachTaskIds(listAction(await prepare(ctx), { action: "list" }));
      },
    }),
    defineTool({
      name: "subagent_cancel",
      label: "Subagent Cancel",
      description: "Cancel a running delegated subagent.",
      parameters: TaskIdParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const id = resolveTaskId(params);
        if (!id) return missingTaskId("subagent_cancel");
        return attachTaskIds(await cancelAction(await prepare(ctx), {
          action: "cancel",
          subagentIds: [asTarget(id)],
        }));
      },
    }),
    defineTool({
      name: "subagent_send_message",
      label: "Subagent Send Message",
      description: "Steer a running subagent.",
      parameters: SendParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const rawId = resolveTaskId(params);
        if (!rawId) return missingTaskId("subagent_send_message");
        const id = requireSubagentId(rawId);
        if (isActionResult(id)) return id;
        return attachTaskIds(await steerAction(await prepare(ctx), {
          action: "steer",
          messages: [{ kind: "steer", subagentId: id, message: params.message }],
        }));
      },
    }),
    defineTool({
      name: "subagent_continue",
      label: "Subagent Continue",
      description: "Resume a finished subagent. mode=task waits; mode=background returns after resume.",
      parameters: ContinueParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const rawId = resolveTaskId(params);
        if (!rawId) return missingTaskId("subagent_continue");
        const id = requireSubagentId(rawId);
        if (isActionResult(id)) return id;
        const depsForCall = await prepare(ctx);
        const resumes: ParsedResumeRequest[] = [{
          kind: "resume",
          subagentId: id,
          prompt: params.prompt,
        }];
        const resumed = await resumeAction(depsForCall, { action: "resume", resumes }, ctx);
        if (!shouldJoinAfterStart(params.mode)) return attachTaskIds(resumed);
        const ids = extractSpawnedIds(resumed);
        if (ids.length === 0) return attachTaskIds(resumed);
        return attachTaskIds(await joinAction(
          depsForCall,
          { action: "join", subagentIds: ids.map(asTarget) },
          signal,
          onUpdate,
          toolCallId,
        ));
      },
    }),
  ];
}
