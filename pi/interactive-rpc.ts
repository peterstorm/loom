import { StringDecoder } from "node:string_decoder";

export const MAX_INTERACTIVE_RPC_FRAME_BYTES = 4 * 1024 * 1024;

export type RpcParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: string }>;

export type ExtensionUiRequest =
  | Readonly<{ kind: "select"; id: string; title: string; options: readonly string[]; timeout?: number }>
  | Readonly<{ kind: "confirm"; id: string; title: string; message: string; timeout?: number }>
  | Readonly<{ kind: "input"; id: string; title: string; placeholder?: string; timeout?: number }>
  | Readonly<{ kind: "editor"; id: string; title: string; prefill: string }>
  | Readonly<{ kind: "notify"; id: string; message: string; notifyType: "info" | "warning" | "error" }>
  | Readonly<{ kind: "set-status"; id: string; key: string; text?: string }>
  | Readonly<{
      kind: "set-widget";
      id: string;
      key: string;
      lines?: readonly string[];
      placement: "aboveEditor" | "belowEditor";
    }>
  | Readonly<{ kind: "set-title"; id: string; title: string }>
  | Readonly<{ kind: "set-editor-text"; id: string; text: string }>;

export type ExtensionUiResponse =
  | Readonly<{ type: "extension_ui_response"; id: string; value: string }>
  | Readonly<{ type: "extension_ui_response"; id: string; confirmed: boolean }>
  | Readonly<{ type: "extension_ui_response"; id: string; cancelled: true }>;

export type PiRpcFrame =
  | Readonly<{ kind: "extension-ui"; request: ExtensionUiRequest }>
  | Readonly<{ kind: "event"; type: string; payload: Readonly<Record<string, unknown>> }>;

const success = <T>(value: T): RpcParseResult<T> => Object.freeze({ ok: true, value });
const failure = <T>(error: string): RpcParseResult<T> => Object.freeze({ ok: false, error });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (record: Record<string, unknown>, key: string, context: string): RpcParseResult<string> => {
  const value = record[key];
  return typeof value === "string" && value.length > 0
    ? success(value)
    : failure(`${context}.${key} must be a non-empty string`);
};

const optionalTimeout = (record: Record<string, unknown>, context: string): RpcParseResult<number | undefined> => {
  const value = record.timeout;
  if (value === undefined) return success(undefined);
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? success(value)
    : failure(`${context}.timeout must be a positive integer when present`);
};

const stringArray = (value: unknown, context: string, allowEmpty: boolean): RpcParseResult<readonly string[]> => {
  if (!Array.isArray(value)) return failure(`${context} must be an array`);
  if (!allowEmpty && value.length === 0) return failure(`${context} must be non-empty`);
  const invalid = value.findIndex((entry) => typeof entry !== "string" || entry.length === 0);
  return invalid === -1
    ? success(Object.freeze(value.map((entry) => String(entry))))
    : failure(`${context}[${invalid}] must be a non-empty string`);
};

function parseDialogRequest(
  method: "select" | "confirm" | "input" | "editor",
  record: Record<string, unknown>,
  id: string,
): RpcParseResult<ExtensionUiRequest> {
  const title = requiredString(record, "title", `extension_ui_request(${method})`);
  if (!title.ok) return title;
  if (method === "editor") {
    return typeof record.prefill === "string"
      ? success(Object.freeze({ kind: method, id, title: title.value, prefill: record.prefill }))
      : failure("extension_ui_request(editor).prefill must be a string");
  }

  const timeout = optionalTimeout(record, `extension_ui_request(${method})`);
  if (!timeout.ok) return timeout;
  const timed = timeout.value === undefined ? {} : { timeout: timeout.value };
  if (method === "select") {
    const options = stringArray(record.options, "extension_ui_request(select).options", false);
    return options.ok
      ? success(Object.freeze({ kind: method, id, title: title.value, options: options.value, ...timed }))
      : options;
  }
  if (method === "confirm") {
    return typeof record.message === "string"
      ? success(Object.freeze({ kind: method, id, title: title.value, message: record.message, ...timed }))
      : failure("extension_ui_request(confirm).message must be a string");
  }
  if (record.placeholder !== undefined && typeof record.placeholder !== "string") {
    return failure("extension_ui_request(input).placeholder must be a string when present");
  }
  return success(Object.freeze({
    kind: method,
    id,
    title: title.value,
    ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
    ...timed,
  }));
}

function parseFireAndForgetRequest(
  method: string,
  record: Record<string, unknown>,
  id: string,
): RpcParseResult<ExtensionUiRequest> {
  if (method === "notify") {
    const message = requiredString(record, "message", "extension_ui_request(notify)");
    if (!message.ok) return message;
    const notifyType = record.notifyType ?? "info";
    return notifyType === "info" || notifyType === "warning" || notifyType === "error"
      ? success(Object.freeze({ kind: "notify", id, message: message.value, notifyType }))
      : failure("extension_ui_request(notify).notifyType must be info, warning, or error");
  }
  if (method === "setStatus") {
    const key = requiredString(record, "statusKey", "extension_ui_request(setStatus)");
    if (!key.ok) return key;
    if (record.statusText !== undefined && typeof record.statusText !== "string") {
      return failure("extension_ui_request(setStatus).statusText must be a string when present");
    }
    return success(Object.freeze({
      kind: "set-status", id, key: key.value,
      ...(typeof record.statusText === "string" ? { text: record.statusText } : {}),
    }));
  }
  if (method === "setWidget") {
    const key = requiredString(record, "widgetKey", "extension_ui_request(setWidget)");
    if (!key.ok) return key;
    const lines = record.widgetLines === undefined
      ? success<readonly string[] | undefined>(undefined)
      : stringArray(record.widgetLines, "extension_ui_request(setWidget).widgetLines", true);
    if (!lines.ok) return lines;
    const placement = record.widgetPlacement ?? "aboveEditor";
    if (placement !== "aboveEditor" && placement !== "belowEditor") {
      return failure("extension_ui_request(setWidget).widgetPlacement must be aboveEditor or belowEditor");
    }
    return success(Object.freeze({
      kind: "set-widget", id, key: key.value,
      ...(lines.value === undefined ? {} : { lines: lines.value }), placement,
    }));
  }
  let field: "title" | "text";
  if (method === "setTitle") field = "title";
  else if (method === "set_editor_text") field = "text";
  else return failure(`extension_ui_request method ${JSON.stringify(method)} is not supported`);
  const value = requiredString(record, field, `extension_ui_request(${method})`);
  if (!value.ok) return value;
  return success(Object.freeze(method === "setTitle"
    ? { kind: "set-title", id, title: value.value }
    : { kind: "set-editor-text", id, text: value.value }));
}

function parseExtensionUiRequest(record: Record<string, unknown>): RpcParseResult<ExtensionUiRequest> {
  const id = requiredString(record, "id", "extension_ui_request");
  if (!id.ok) return id;
  const method = requiredString(record, "method", "extension_ui_request");
  if (!method.ok) return method;
  return method.value === "select" || method.value === "confirm" ||
      method.value === "input" || method.value === "editor"
    ? parseDialogRequest(method.value, record, id.value)
    : parseFireAndForgetRequest(method.value, record, id.value);
}

export function parsePiRpcLine(line: string): RpcParseResult<PiRpcFrame> {
  if (line.length === 0) return failure("Pi RPC emitted an empty frame");
  if (Buffer.byteLength(line, "utf8") > MAX_INTERACTIVE_RPC_FRAME_BYTES) {
    return failure(`Pi RPC frame exceeds ${MAX_INTERACTIVE_RPC_FRAME_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return failure(`Pi RPC frame is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) return failure("Pi RPC frame must be an object");
  const type = requiredString(raw, "type", "Pi RPC frame");
  if (!type.ok) return type;
  if (type.value === "extension_ui_request") {
    const request = parseExtensionUiRequest(raw);
    return request.ok ? success(Object.freeze({ kind: "extension-ui", request: request.value })) : request;
  }
  return success(Object.freeze({ kind: "event", type: type.value, payload: Object.freeze({ ...raw }) }));
}

export const cancelledUiResponse = (id: string): ExtensionUiResponse =>
  Object.freeze({ type: "extension_ui_response", id, cancelled: true });

export const valueUiResponse = (id: string, value: string): ExtensionUiResponse =>
  Object.freeze({ type: "extension_ui_response", id, value });

export const confirmUiResponse = (id: string, confirmed: boolean): ExtensionUiResponse =>
  Object.freeze({ type: "extension_ui_response", id, confirmed });

/** LF-delimited UTF-8 framing; CRLF is tolerated by stripping the CR before each LF. U+2028/U+2029 remain ordinary JSON string bytes. */
export class StrictLfJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Uint8Array): RpcParseResult<readonly string[]> {
    this.buffer += this.decoder.write(Buffer.from(chunk));
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > MAX_INTERACTIVE_RPC_FRAME_BYTES) {
        return failure(`Pi RPC frame exceeds ${MAX_INTERACTIVE_RPC_FRAME_BYTES} bytes`);
      }
      lines.push(line);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_INTERACTIVE_RPC_FRAME_BYTES) {
      return failure(`Pi RPC frame exceeds ${MAX_INTERACTIVE_RPC_FRAME_BYTES} bytes before LF delimiter`);
    }
    return success(Object.freeze(lines));
  }

  finish(): RpcParseResult<readonly string[]> {
    this.buffer += this.decoder.end();
    return this.buffer.length === 0
      ? success(Object.freeze([]))
      : failure("Pi RPC stream ended with an unterminated frame");
  }
}
