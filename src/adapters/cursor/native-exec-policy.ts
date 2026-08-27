export interface CursorNativeExecPolicyContext {
  codeMode?: boolean;
}

export function nativeLocalExecDisabledMessage(opts: CursorNativeExecPolicyContext = {}): string {
  if (opts.codeMode) {
    return (
      "Cursor-native local tools are policy-redirected to the Codex bridge for this request; this is not a permissions denial. "
      + "Use the top-level \`exec\` tool and call nested helpers inside its JavaScript body as \`await tools.<name>(args)\` "
      + "(for example \`await tools.exec_command({cmd: \"ls\"})\`, \`await tools.apply_patch(input)\`, or another helper listed in \`ALL_TOOLS\`). "
      + "Do not call \`shell_command\` or \`exec_command\` at the top level in code mode."
    );
  }
  return (
    "Cursor-native filesystem tools are not executed locally. Use a catalog tool for this work: \`shell_command\` / \`exec_command\` "
    + "(or the listed \`mcp_opencodex-responses_*\` display alias) with host-shell-safe equivalents: POSIX (\`cat\`, \`head\`, \`ls\`, \`rg\`, \`grep\`) "
    + "or Windows PowerShell (\`Get-Content\`, \`Get-ChildItem\`, \`Select-String\`); use \`apply_patch\` for file edits."
  );
}

export function nativeFetchDisabledMessage(opts: CursorNativeExecPolicyContext = {}): string {
  if (opts.codeMode) {
    return (
      "Cursor-native fetch is policy-redirected to the Codex bridge for this request; this is not a permissions denial. "
      + "Use the top-level \`exec\` tool and call a nested shell helper inside its JavaScript body as \`await tools.exec_command({cmd: \"curl ...\"})\` "
      + "(or another helper listed in \`ALL_TOOLS\`). Do not call \`shell_command\` or \`exec_command\` at the top level in code mode."
    );
  }
  return (
    "Cursor-native fetch is not executed locally. Use the Codex shell bridge tool \`shell_command\` "
    + "(aliases: \`exec_command\`, \`mcp_opencodex-responses_shell_command\`, \`mcp_opencodex-responses_exec_command\`) with curl or wget."
  );
}

export function nativeShellDisabledMessage(opts: CursorNativeExecPolicyContext = {}): string {
  if (opts.codeMode) {
    return (
      "Cursor-native shell is policy-redirected to the Codex bridge for this request; this is not a permissions denial. "
      + "Use the top-level \`exec\` tool and call a nested shell helper inside its JavaScript body as \`await tools.exec_command({cmd: \"...\"})\` "
      + "(or another helper listed in \`ALL_TOOLS\`). Do not call \`shell_command\` or \`exec_command\` at the top level in code mode."
    );
  }
  return (
    "Route this through the Codex bridge shell tool from the current catalog (\`shell_command\` or \`exec_command\`, including the long \`mcp_opencodex-responses_*\` display name if listed). "
    + "Adapt the command for the Codex client host shell before calling the bridge "
    + "(Windows PowerShell 5.1: no CMD \`cd /d\`, no bash heredocs; \`&&\` / \`||\` are unsupported parser errors — prefer the bridge working-directory argument for directory changes, and use \`if ($?) { ... }\` for success-gated follow-up steps; do not treat \`;\` as a substitute for \`&&\`). "
    + "Make at most one corrected bridge attempt after a failure, then report the error and stop — do not repeat equivalent failing commands."
  );
}
