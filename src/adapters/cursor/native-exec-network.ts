import { create } from "@bufbuild/protobuf";
import { FetchErrorSchema, FetchResultSchema, FetchSuccessSchema, type ExecServerMessage } from "./gen/agent_pb";
import { errorText, execBytes } from "./native-exec-common";
import { nativeFetchDisabledMessage, type CursorNativeExecPolicyContext } from "./native-exec-policy";

export interface CursorNativeNetworkDeps {
  fetch?: typeof fetch;
}

export function rejectFetchExecForPolicy(execMsg: ExecServerMessage, opts: CursorNativeExecPolicyContext = {}): Uint8Array {
  if (execMsg.message.case !== "fetchArgs") throw new Error("invalid fetch exec");
  const args = execMsg.message.value;
  return execBytes(execMsg, "fetchResult", create(FetchResultSchema, {
    result: { case: "error", value: create(FetchErrorSchema, { url: args.url, error: nativeFetchDisabledMessage(opts) }) },
  }));
}

export async function fetchExec(execMsg: ExecServerMessage, deps: CursorNativeNetworkDeps = {}): Promise<Uint8Array> {
  if (execMsg.message.case !== "fetchArgs") throw new Error("invalid fetch exec");
  const args = execMsg.message.value;
  try {
    const fetchImpl = deps.fetch ?? fetch;
    const response = await fetchImpl(args.url);
    const content = await response.text();
    return execBytes(execMsg, "fetchResult", create(FetchResultSchema, {
      result: {
        case: "success",
        value: create(FetchSuccessSchema, {
          url: args.url,
          content,
          statusCode: response.status,
          contentType: response.headers.get("content-type") ?? "",
        }),
      },
    }));
  } catch (err) {
    return execBytes(execMsg, "fetchResult", create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: args.url, error: errorText(err) }) },
    }));
  }
}
