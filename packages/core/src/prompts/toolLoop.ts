import type { ToolDescription } from '../tools/ToolDispatcher.js';

export function buildAgentActionSchema(tools: ToolDescription[]): Record<string, unknown> {
  return {
    oneOf: [
      ...tools.map((tool) => ({
        type: 'object',
        properties: {
          type: { const: 'tool_call' },
          summary: { type: 'string', minLength: 1 },
          tool: { const: tool.name },
          args: tool.argumentSchema,
        },
        required: ['type', 'summary', 'tool', 'args'],
        additionalProperties: false,
      })),
      {
        type: 'object',
        properties: {
          type: { const: 'complete' },
          summary: { type: 'string', minLength: 1 },
          changedFiles: { type: 'array', items: { type: 'string' } },
          verification: { type: 'array', items: { type: 'string' } },
          noChangeReason: { type: 'string', minLength: 1 },
        },
        required: ['type', 'summary'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          type: { const: 'request_input' },
          question: { type: 'string', minLength: 1 },
          context: { type: 'string', minLength: 1 },
        },
        required: ['type', 'question'],
        additionalProperties: false,
      },
    ],
  };
}

export function getToolLoopSystemPrompt(tools: ToolDescription[]): string {
  const toolText = tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  schema: ${JSON.stringify(tool.argumentSchema)}\n  example args: ${JSON.stringify(tool.example)}`
    )
    .join('\n');

  return `You are a local coding agent working inside one repository.

Return exactly one JSON action and no prose. Choose one action per turn.

Tool action:
{"type":"tool_call","summary":"short present-tense action","tool":"tool_name","args":{}}

Completion action:
{"type":"complete","summary":"what changed and what was verified","noChangeReason":"only when no edit was needed"}

Question action (only when user input is truly required):
{"type":"request_input","question":"specific question","context":"why it is needed"}

Rules:
- Inspect relevant code before editing.
- Prefer exact, small edits.
- Use only listed tools and their documented arguments.
- For an existing file that needs a complete rewrite, use replace_file; create_file never overwrites.
- Do not claim verification unless a command result proves it.
- If a tool fails, use its error to choose a different next action.
- Call complete only when the request is actually handled or no edits are needed.

Tools:
${toolText}`;
}

export function buildToolLoopPrompt(
  task: string,
  initialContext: string,
  transcript: string,
  stateSummary: string
): string {
  return `Task:\n${task}\n\nInitial context:\n${initialContext}\n\nRuntime state:\n${stateSummary}\n\nConversation:\n${transcript || '(no actions yet)'}\n\nReturn the next single JSON action.`;
}
