import { User } from '../models/index.js';

// Observers read the workspace but cannot act on tasks or own work, so they
// must never be linked as the owner of a claim.
const ACTIONABLE_ROLES = new Set(['lead', 'contributor']);

/**
 * Builds lookup tables for the people who can actually own work in a project.
 * Names are resolved once per ingest so every claim gets a stable member id
 * instead of being matched by display text later.
 */
export async function loadOwnerDirectory(project) {
  const memberIds = (project.members || [])
    .filter((member) => ACTIONABLE_ROLES.has(member.role))
    .map((member) => member.user?._id ?? member.user)
    .filter(Boolean);
  const users = await User.find({ _id: { $in: memberIds } })
    .select('_id name email')
    .lean();

  const byEmail = new Map();
  const byName = new Map();
  const byFirstName = new Map();
  for (const user of users) {
    const email = String(user.email || '').trim().toLowerCase();
    if (email) byEmail.set(email, user._id);
    const name = String(user.name || '').trim().toLowerCase();
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(user._id);
      const first = name.split(/\s+/)[0];
      if (!byFirstName.has(first)) byFirstName.set(first, []);
      byFirstName.get(first).push(user._id);
    }
  }
  return { byEmail, byName, byFirstName };
}

/**
 * Resolves a free-text owner to a member id. Only an exact email or an exact
 * full name is trusted. A first name is kept as text and labelled unconfirmed:
 * a note that says "Rohan will follow up" may name someone outside the
 * project, so attributing it to the only project member called Rohan would
 * invent an owner.
 */
export function resolveOwnerName(directory, rawName) {
  const name = String(rawName ?? '').trim().replace(/^@/, '');
  if (!name) return { userId: null, ambiguous: false, unconfirmed: false };
  const lowered = name.toLowerCase();

  if (directory.byEmail.has(lowered)) {
    return { userId: directory.byEmail.get(lowered), ambiguous: false, unconfirmed: false };
  }
  if (directory.byName.has(lowered)) {
    const ids = directory.byName.get(lowered);
    return ids.length === 1
      ? { userId: ids[0], ambiguous: false, unconfirmed: false }
      : { userId: null, ambiguous: true, unconfirmed: false };
  }

  const first = lowered.split(/\s+/)[0];
  const candidates = directory.byFirstName.get(first) || [];
  if (candidates.length > 0) {
    return { userId: null, ambiguous: candidates.length > 1, unconfirmed: true };
  }
  return { userId: null, ambiguous: false, unconfirmed: false };
}
