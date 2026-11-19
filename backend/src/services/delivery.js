import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { Delivery } from '../models/index.js';

/**
 * Sends one plain-text message to the configured webhook and records the
 * outcome. Delivery never throws: a missing or broken webhook must not fail
 * the action that triggered it. The record says `skipped` when nothing left
 * the server, and the UI shows that word rather than "sent".
 */
export async function deliverOutbound({
  projectId,
  user,
  handoverId,
  clarificationId,
  kind,
  text,
  createdBy,
}) {
  let status = 'skipped';
  let detail =
    'No outbound webhook is configured, so no message left this server. The in-app notification is the only delivery.';

  if (env.outboundWebhookUrl) {
    try {
      const response = await fetch(env.outboundWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(env.outboundWebhookTimeoutMs),
      });
      if (response.ok) {
        status = 'sent';
        detail = `The webhook accepted the message (HTTP ${response.status}).`;
      } else {
        status = 'failed';
        detail = `The webhook rejected the message (HTTP ${response.status}).`;
      }
    } catch (error) {
      status = 'failed';
      detail =
        error?.name === 'TimeoutError'
          ? 'The webhook did not answer before the timeout.'
          : 'The webhook could not be reached.';
      // The URL is deliberately excluded: webhook URLs usually carry a secret.
      logger.warn({ kind, error: error?.name }, 'Outbound delivery failed');
    }
  }

  try {
    return await Delivery.create({
      project: projectId,
      user,
      handover: handoverId,
      clarification: clarificationId,
      kind,
      channel: 'webhook',
      status,
      detail,
      createdBy,
    });
  } catch (error) {
    logger.warn({ kind, error: error?.name }, 'Could not record an outbound delivery');
    return null;
  }
}
