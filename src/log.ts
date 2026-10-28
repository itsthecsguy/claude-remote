export type LogEvent = {
  tool: string;
  sessionId?: string;
  ticketId?: string;
  durationMs?: number;
  exitCode?: number;
  evidence?: string;
  code?: string;
  attachmentCount?: number;
  attachmentBytes?: number;
  attachmentTypes?: string;
};

/**
 * One line per event, with a UTC timestamp first. The helper log had no timestamps, which made
 * it impossible to line failures up with the tunnel log or with sleep and wake.
 */
export function logEvent(event: LogEvent): void {
  const payload: Record<string, string | number> = { at: new Date().toISOString(), tool: event.tool };
  if (event.sessionId) payload.sessionId = event.sessionId;
  if (event.ticketId) payload.ticketId = event.ticketId;
  if (event.durationMs != null) payload.durationMs = event.durationMs;
  if (event.exitCode != null) payload.exitCode = event.exitCode;
  if (event.evidence) payload.evidence = event.evidence;
  if (event.code) payload.code = event.code;
  if (event.attachmentCount != null) payload.attachmentCount = event.attachmentCount;
  if (event.attachmentBytes != null) payload.attachmentBytes = event.attachmentBytes;
  if (event.attachmentTypes) payload.attachmentTypes = event.attachmentTypes;
  console.error(`claude-remote ${JSON.stringify(payload)}`);
}
