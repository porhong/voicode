// Prepares a release: bumps the voicecode-agent version, syncs the lockfile, commits
// and creates the matching tag. Pushing the tag starts the Release workflow.
//
//   npm run release -- 0.2.0        (or patch | minor | major | 0.2.0-beta.1)
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PKG = 'apps/agent/package.json';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const arg = process.argv[2];
if (!arg) fail('Usage: npm run release -- <patch|minor|major|x.y.z[-pre]>');

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const current = SEMVER.exec(pkg.version);
if (!current) fail(`Current version ${pkg.version} is not valid semver`);
const [major, minor, patch] = current.slice(1, 4).map(Number);

const next =
  arg === 'major'
    ? `${major + 1}.0.0`
    : arg === 'minor'
      ? `${major}.${minor + 1}.0`
      : arg === 'patch'
        ? `${major}.${minor}.${patch + 1}`
        : arg;
if (!SEMVER.exec(next)) fail(`${next} is not a valid version`);
if (next === pkg.version) fail(`Version is already ${next}`);

if (git('status', '--porcelain')) fail('Working tree is not clean; commit or stash first.');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('Releases are cut from main.');
if (git('tag', '--list', `v${next}`)) fail(`Tag v${next} already exists.`);

pkg.version = next;
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
execSync('npm install --package-lock-only --ignore-scripts', { stdio: 'inherit' });

git('add', PKG, 'package-lock.json');
git('commit', '-m', `Release v${next}`);
git('tag', '-a', `v${next}`, '-m', `voicecode-agent v${next}`);

console.log(
  `\nCreated commit and tag v${next}. Publish with:\n\n  git push origin main v${next}\n`,
);
