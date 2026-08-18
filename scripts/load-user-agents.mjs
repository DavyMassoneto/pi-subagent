import { AgentRegistry } from "../src/agents.ts";

const registry = new AgentRegistry();
const warnings = [];
await registry.reload(process.cwd(), {
  onWarning: message => warnings.push(message),
});
const names = [...registry.agents.keys()].sort();
console.log(JSON.stringify({
  count: names.length,
  names,
  warnings,
  toolsSample: Object.fromEntries(
    names.slice(0, 5).map(name => [name, registry.agents.get(name)?.tools ?? null]),
  ),
}, null, 2));
