/** Raw DeepSeek control output, not quoted examples or ordinary prose discussing it. */
export function isRawToolReply(text: string): boolean {
  return /^\s*<\s*[|｜]{1,2}DSML[|｜]{1,2}\s*(?:calls|tool_calls|invoke)\b/i.test(text)
}

export function displayAgentReply(text: string): string {
  return isRawToolReply(text) ? 'The Agent returned an incomplete tool call instead of a reply. Please contact the provider.' : text
}
