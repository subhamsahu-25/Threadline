import { forbidden } from '../../lib/errors.js';

export function roleOf(project, userId) {
  if (!project || !userId) return null;
  const id = String(userId);
  const membership = (project.members || []).find(
    (entry) => String(entry.user?._id ?? entry.user) === id,
  );
  return membership ? membership.role : null;
}

export function isMember(project, userId) {
  return roleOf(project, userId) !== null;
}

export function isProjectOwner(project, userId) {
  return String(project?.owner?._id ?? project?.owner) === String(userId);
}

export function canManageProject(project, user) {
  const id = user?._id ?? user?.id ?? user;
  return isProjectOwner(project, id) || roleOf(project, id) === 'lead';
}

export function canContribute(project, user) {
  const id = user?._id ?? user?.id ?? user;
  return ['lead', 'contributor'].includes(roleOf(project, id));
}

/**
 * Fail-closed content visibility. A source is visible only when the user is a
 * project member AND the source's explicit sharing rule names them or their
 * role. Unknown scopes, soft-deleted sources and hidden sources are excluded.
 */
export function sourceVisibleTo(source, project, userId) {
  if (!source || source.deletedAt || source.hiddenAt) return false;
  if (!isMember(project, userId)) return false;

  // Person-confirmed answers are owned by the project leads: whoever holds the
  // lead role can review them, including leads who joined after the answer.
  if (source.kind === 'confirmation' && roleOf(project, userId) === 'lead') return true;

  const scope = source.visibility?.scope ?? 'project';
  if (scope === 'project') return true;
  if (scope === 'roles') {
    const role = roleOf(project, userId);
    return Boolean(role) && (source.visibility?.roles || []).includes(role);
  }
  if (scope === 'users') {
    const id = String(userId);
    return (source.visibility?.users || []).some(
      (entry) => String(entry?._id ?? entry) === id,
    );
  }
  return false;
}

export function assertSourceVisible(source, project, userId) {
  if (!sourceVisibleTo(source, project, userId)) {
    throw forbidden('You are not authorized to access this source');
  }
}

export function visibleSourcesFor(sources, project, userId) {
  return (sources || []).filter((source) => sourceVisibleTo(source, project, userId));
}

/**
 * A claim is visible only when every citation behind it resolves to a source
 * the recipient may read. Partial visibility is treated as no visibility so
 * that a restricted document can never be inferred from an included claim.
 */
export function claimVisibleTo({ evidence, sourceById, project, userId }) {
  if (!evidence || evidence.length === 0) return false;
  return evidence.every((item) => {
    const source = sourceById.get(String(item.source?._id ?? item.source));
    return sourceVisibleTo(source, project, userId);
  });
}
