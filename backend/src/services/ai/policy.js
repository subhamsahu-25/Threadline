/**
 * Decides whether a source's text may be sent to the external LLM.
 *
 * Ordinary sources default to allowed; confidential sources default to local
 * extraction and only leave the server when a lead has explicitly allowed it.
 * An unset flag therefore keeps the safe behaviour, including for sources that
 * were ingested before this policy existed.
 */
export function allowsExternalAI(source) {
  const setting = source?.aiPolicy?.allowExternal;
  if (source?.sensitivity === 'confidential') return setting === true;
  return setting !== false;
}
