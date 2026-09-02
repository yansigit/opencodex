export function sshForwardCommand(port: number, host: string, localPort: number): string {
  return `ssh -L ${localPort}:localhost:${port} user@${host}`;
}

export function openAiBaseUrlConfig(localPort: number): string {
  return `openai_base_url = "http://localhost:${localPort}/v1"`;
}
