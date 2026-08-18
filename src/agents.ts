import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SpawnRequest } from "./schema.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentAgentDiscoverySettings } from "./settings.js";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (MODEL_THINKING_LEVELS as readonly string[]).includes(value);
}

export type AgentSource = "user" | "project";

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  tools?: string[];
  skills?: string[];
  systemPrompt: string;
  source: AgentSource;
  sourcePath?: string;
}

export type AgentDefinitionSummary = Readonly<Pick<
  AgentDefinition,
  "name" | "description" | "source" | "sourcePath"
>>;

export interface RequestedExecutionConfig {
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly cwd?: string;
}

export interface EffectiveExecutionConfig {
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly cwd: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
}

export type ExecutionOverrides = Readonly<Pick<RequestedExecutionConfig, "model" | "thinking">>;

export function buildAgentDefinition(
  content: string,
  source: AgentSource,
): AgentDefinition | { error: Error } {
  try {
    const mixed = mixedCsvAndListField(content, "tools") ?? mixedCsvAndListField(content, "skills");
    if (mixed) {
      throw new Error(`Expected field "${mixed}" to be either a CSV string or a YAML list, not both.`);
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    return {
      name: parseRequiredString(frontmatter.name, "name"),
      description: parseRequiredString(frontmatter.description, "description"),
      model: parseString(frontmatter.model, "model"),
      thinking: parseThinkingLevel(frontmatter.thinking),
      tools: parseStringList(frontmatter.tools, "tools"),
      skills: parseStringList(frontmatter.skills, "skills"),
      systemPrompt: body.trim(),
      source,
      sourcePath: undefined,
    };
  } catch (error) {
    return { error: error as Error }
  }
}

function parseString(val: unknown, field: string): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val;
  throw new Error(`Expected field "${field}" to be a string, but got ${typeof val}.`);
}

function parseRequiredString(val: unknown, field: string): string {
  const value = parseString(val, field);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Expected required field "${field}" to be a non-empty string.`);
  }
  return value;
}

function parseThinkingLevel(val: unknown): ModelThinkingLevel | undefined {
  const thinking = parseString(val, "thinking");
  if (thinking === undefined || isModelThinkingLevel(thinking)) return thinking;
  throw new Error(`Expected field "thinking" to be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`);
}

export function parseStringList(val: unknown, field: string): Array<string> | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || trimmed === "none") return undefined;
    const items = trimmed.split(",").map(item => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (Array.isArray(val)) {
    // ponytail: keep string names; skip `{ "*": false }` deny markers used by gentle-pi.
    const items = val.flatMap(item => typeof item === "string" && item.trim() ? [item.trim()] : []);
    return items.length > 0 ? items : undefined;
  }
  throw new Error(`Expected field "${field}" to be a CSV string or a YAML list, but got ${typeof val}.`);
}

function frontmatterBlock(content: string): string | undefined {
  const opening = content.match(/^---\r?\n/);
  if (!opening) return undefined;
  const rest = content.slice(opening[0].length);
  const closing = /(?:^|\r?\n)---(?=\r?\n|$)/.exec(rest);
  return closing ? rest.slice(0, closing.index) : undefined;
}

/** Raw frontmatter can declare both `tools: a, b` and a following `- item` list. */
export function mixedCsvAndListField(content: string, field: string): string | undefined {
  const block = frontmatterBlock(content);
  if (!block) return undefined;
  const key = new RegExp(`^${field}:\\s*(.*)$`);
  let format: "csv" | "list" | undefined;
  let inField = false;
  for (const line of block.split(/\r?\n/)) {
    const header = line.match(key);
    if (header) {
      const next: "csv" | "list" = header[1].trim() ? "csv" : "list";
      if (format && format !== next) return field;
      format = next;
      inField = true;
      continue;
    }
    if (inField && /^\s+-\s+/.test(line)) {
      if (format === "csv") return field;
      continue;
    }
    if (inField && /^\S/.test(line)) inField = false;
  }
  return undefined;
}

export interface AgentRegistryOptions {
  discovery?: Partial<SubagentAgentDiscoverySettings>;
  onWarning?: (message: string) => void;
}

export class AgentRegistry {

  private _agents = new Map<string, AgentDefinition>();
  get agents(): Map<string, AgentDefinition> { return this._agents }

  /**
   * Load agent configs from user/project `agents` and `subagents` dirs.
   * Project overrides user unless settings say otherwise. No ancestor walk.
   */
  async reload(cwd: string = process.cwd(), options: AgentRegistryOptions = {}): Promise<void> {
    const discovery = { ...DEFAULT_SUBAGENT_SETTINGS.agentDiscovery, ...options.discovery };
    const agents = new Map<string, AgentDefinition>();
    const extensions = new Set(discovery.agentFileExtensions);

    async function loadAgents(dir: string | undefined, source: AgentSource): Promise<void> {
      if (!dir || !existsSync(dir)) { return }
      const all = await readdir(dir);
      const files = all.filter(f => extensions.has(extname(f)));

      for (const file of files) {
        const path = join(dir, file);
        let content: string;

        try {
          content = await readFile(path, { encoding: "utf-8" });
        } catch (error) {
          if (discovery.warnOnInvalidAgents) options.onWarning?.(`Failed to read subagent definition ${path}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        const result = buildAgentDefinition(content, source);
        if ("error" in result) {
          if (discovery.warnOnInvalidAgents) options.onWarning?.(`Invalid subagent definition ${path}: ${result.error.message}`);
          continue;
        } else {
          agents.set(result.name, { ...result, sourcePath: path });
        }
      }
    }

    for (const [dir, source] of resolveDiscoveryDirs(cwd, discovery)) await loadAgents(dir, source);
    this._agents = agents;
  }

  summarizeAgent(): string {
    return Array.from(this.agents.values())
      .map(agent => `${agent.name} (${agent.source}) — ${agent.description}`).join("\n");
  }
}

export function serializeAgentDefinition(config: AgentDefinition) {
  return {
    name: config.name,
    description: config.description,
    source: config.source,
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    skills: config.skills,
    sourcePath: config.sourcePath,
  };
}

export function listAgentDefinitions(registry: AgentRegistry) {
  return Array.from(registry.agents.values()).map(serializeAgentDefinition);
}

export function resolveUserAgentRoot(): string {
  return process.env.PI_AGENT_DIR ?? getAgentDir();
}

export function resolveDiscoveryDirs(
  cwd: string,
  discovery: SubagentAgentDiscoverySettings,
): Array<[string, AgentSource]> {
  const userRoot = resolveUserAgentRoot();
  const userDirs = discovery.includeUserAgents
    ? [join(userRoot, "agents"), join(userRoot, "subagents")]
    : [];
  // ponytail: cwd only. ancestor nearest-walk hid checkout-local agents.
  const projectDirs = discovery.includeProjectAgents && discovery.projectAgentsStrategy !== "off"
    ? [join(cwd, ".pi", "agents"), join(cwd, ".pi", "subagents")]
    : [];
  const user = userDirs.map(dir => [dir, "user"] as [string, AgentSource]);
  const project = projectDirs.map(dir => [dir, "project"] as [string, AgentSource]);
  return discovery.duplicateNamePolicy === "userOverridesProject"
    ? [...project, ...user]
    : [...user, ...project];
}

export function summarizeAgentDefinition(definition: AgentDefinition): AgentDefinitionSummary {
  return {
    name: definition.name,
    description: definition.description,
    source: definition.source,
    ...(definition.sourcePath ? { sourcePath: definition.sourcePath } : {}),
  };
}

/** Resolve spawn-over-definition precedence. */
export function resolveRequestedConfig(
  config: AgentDefinition,
  spawn: SpawnRequest,
): RequestedExecutionConfig {
  const skills = spawn.skills ?? config.skills;
  return {
    model: spawn.model ?? config.model,
    thinking: spawn.thinking ?? config.thinking,
    skills: skills !== undefined ? [...skills] : undefined,
    tools: config.tools !== undefined ? [...config.tools] : undefined,
    cwd: spawn.cwd,
  };
}
