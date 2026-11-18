import { User } from '../models/index.js';

/**
 * Builds lookup tables for the people who can actually own work in a project.
 * Names are resolved once per ingest so every claim gets a stable member id
 * instead of being matched by display text later.
 */
export async function loadOwnerDirectory(project) {
  const memberIds = (project.members || [])
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
 * Resolves a free-text owner to a member id. Exact email and full name win;
 * a first name resolves only when it identifies exactly one member. Anything
 * ambiguous returns `{ userId: null, ambiguous: true }` so a reviewer assigns
 * it explicitly instead of the product guessing.
 */
export function resolveOwnerName(directory, rawName) {
  const name = String(rawName ?? '').trim().replace(/^@/, '');
  if (!name) return { userId: null, ambiguous: false };
  const lowered = name.toLowerCase();

  if (directory.byEmail.has(lowered)) {
    return { userId: directory.byEmail.get(lowered), ambiguous: false };
  }
  if (directory.byName.has(lowered)) {
    const ids = directory.byName.get(lowered);
    return ids.length === 1
      ? { userId: ids[0], ambiguous: false }
      : { userId: null, ambiguous: true };
  }

  const first = lowered.split(/\s+/)[0];
  const candidates = directory.byFirstName.get(first) || [];
  if (candidates.length === 1) return { userId: candidates[0], ambiguous: false };
  if (candidates.length > 1) return { userId: null, ambiguous: true };
  return { userId: null, ambiguous: false };
}
