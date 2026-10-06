export interface ClaudeHookHandler {
  type?: string;
  name?: string;
  command?: string;
  prompt?: string;
  script?: string;
  [key: string]: unknown;
}

export interface ClaudeMatcherGroup {
  matcher?: unknown;
  hooks: ClaudeHookHandler[];
  [key: string]: unknown;
}

export interface ClaudeRemovedHookDefinition {
  event: string;
  groupMeta?: Record<string, unknown>;
  handler: ClaudeHookHandler;
  [key: string]: unknown;
}
