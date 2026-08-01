export interface PiContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface PiMessage {
  role: string;
  content: PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}
