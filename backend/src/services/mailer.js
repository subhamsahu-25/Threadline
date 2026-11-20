import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { Delivery } from '../models/index.js';

/**
 * Verification mail goes to one mailbox through a provider API. It never uses
 * the operator webhook: that is a shared channel, and a working verification
 * token must not be readable by everyone in it.
 */
export function mailConfigured() {
  return env.mailProvider === 'resend' && Boolean(env.resendApiKey);
}

function verificationText(user, url) {
  return [
    `Hello ${user.name},`,
    '',
    `Confirm the email address ${user.email} for your Threadline account by opening this link:`,
    url,
    '',
    `The link expires in ${env.emailVerificationTtlHours} hours and works only for this address.`,
    'If you did not create this account, you can ignore this message.',
  ].join('\n');
}

async function postToProvider(user, url) {
  const response = await fetch(`${env.mailApiBase}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.mailFrom,
      to: [user.email],
      subject: 'Confirm your Threadline email address',
      text: verificationText(user, url),
    }),
    signal: AbortSignal.timeout(env.mailTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Mail provider answered HTTP ${response.status}`);
  }
}

/**
 * Records the outcome either way. Detail text never repeats the link or the
 * token, so an operator reading delivery rows cannot complete the journey on
 * somebody else's behalf.
 */
export async function sendVerificationEmail(user, url) {
  let status = 'skipped';
  let detail =
    'No mail transport is configured, so no message left this server. The confirmation link was returned only to the registering caller.';

  if (mailConfigured()) {
    try {
      await postToProvider(user, url);
      status = 'sent';
      detail = 'The mail provider accepted the confirmation message.';
    } catch (error) {
      status = 'failed';
      detail =
        error?.name === 'TimeoutError'
          ? 'The mail provider did not answer before the timeout.'
          : 'The mail provider could not be reached or rejected the message.';
      logger.warn({ error: error?.name }, 'Verification mail failed');
    }
  }

  try {
    await Delivery.create({
      user: user._id,
      kind: 'auth.verify_email',
      channel: 'email',
      status,
      detail,
      createdBy: user._id,
    });
  } catch (error) {
    logger.warn({ error: error?.name }, 'Could not record the verification delivery');
  }
  return { status, detail };
}
