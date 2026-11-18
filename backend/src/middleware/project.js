import { AppError, asyncHandler, forbidden, notFound } from '../lib/errors.js';
import { canContribute, roleOf } from '../services/access/policy.js';
import { Project } from '../models/index.js';

export async function getProjectForUser(projectId, user) {
  const project = await Project.findById(projectId);
  if (!project) throw notFound('Project not found');
  if (!roleOf(project, user._id)) throw forbidden('You are not a member of this project');
  return project;
}

export const loadProject = asyncHandler(async (req, _res, next) => {
  const project = await Project.findById(req.params.projectId);
  if (!project) throw notFound('Project not found');

  const role = roleOf(project, req.user._id);
  if (!role) throw forbidden('You are not a member of this project');

  req.project = project;
  req.projectRole = role;
  next();
});

export const requireProjectLead = asyncHandler(async (req, _res, next) => {
  if (!req.project) throw new AppError(500, 'missing_project', 'loadProject must run first');
  const role = roleOf(req.project, req.user._id);
  if (role !== 'lead') throw forbidden('Only a project lead can do this');
  next();
});

export const requireProjectContributor = asyncHandler(async (req, _res, next) => {
  if (!req.project) throw new AppError(500, 'missing_project', 'loadProject must run first');
  if (!canContribute(req.project, req.user)) {
    throw forbidden('Read-only members can see the project but cannot change its content');
  }
  next();
});
