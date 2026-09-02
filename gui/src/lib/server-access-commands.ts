export function sshForwardCommand(port: number, host: string, localPort: number): string {
  return `ssh -N -L 127.0.0.1:${localPort}:127.0.0.1:${port} user@${host}`;
}

export function forwardedDashboardUrl(localPort: number): string {
  return `http://127.0.0.1:${localPort}/#dashboard`;
}
