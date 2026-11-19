#!/usr/bin/env node
// Builds the submission archive from tracked files only. Zipping the working
// folder previously shipped backend/.env, node_modules, storage and editor
// locks; git archive makes that class of leak impossible.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DISALLOWED = [
  { name: 'environment file', re: /(^|\/)\.env(\.|$)/, allow: /\.example$/ },
  { name: 'node_modules', re: /(^|\/)node_modules\// },
  { name: 'upload storage', re: /(^|\/)(storage|uploads)\// },
  { name: 'build output', re: /(^|\/)dist\// },
  { name: 'editor/lock files', re: /(^|\/)\.(qoder|idea|vscode)/ },
];

let repoRoot;

function root() {
  if (!repoRoot) {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  }
  return repoRoot;
}

function git(args, options = {}) {
  // Pin every invocation to the repository root so results do not depend on the
  // caller's cwd (vitest runs from backend/, which used to list only that subtree).
  return execFileSync('git', args, { encoding: 'utf8', cwd: root(), ...options });
}

export function trackedPaths() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

export function disallowedTrackedPaths(paths = trackedPaths()) {
  return paths.filter((file) =>
    DISALLOWED.some((rule) => rule.re.test(file) && !(rule.allow && rule.allow.test(file))),
  );
}

export function archiveEntryNames() {
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: root(),
    maxBuffer: 512 * 1024 * 1024,
  });
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length; offset += 512) {
    if (tar[offset] === 0) break;
    const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '');
    const type = String.fromCharCode(tar[offset + 156]);
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString('ascii').trim() || '0', 8);
    if (type === '0' || type === '\0') names.push(name);
    offset += Math.ceil(size / 512) * 512;
  }
  return names;
}

export function assertReleaseReady() {
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) {
    throw new Error(`working tree is not clean; commit or discard changes first:\n${dirty}`);
  }
  const disallowed = disallowedTrackedPaths();
  if (disallowed.length > 0) {
    throw new Error(`tracked files must not enter the archive:\n${disallowed.join('\n')}`);
  }
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = resolve(outIndex > -1 ? process.argv[outIndex + 1] : 'CodePuneThinkers.zip');
  assertReleaseReady();
  execFileSync('git', ['archive', '--format=zip', `--output=${out}`, 'HEAD']);
  if (!existsSync(out)) throw new Error(`archive was not created at ${out}`);
  const names = archiveEntryNames();
  const leaked = disallowedTrackedPaths(names);
  if (leaked.length > 0) {
    throw new Error(`archive contains disallowed paths:\n${leaked.join('\n')}`);
  }
  console.log(`Archive written to ${out} with ${names.length} tracked entries; no secrets or build output included.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
