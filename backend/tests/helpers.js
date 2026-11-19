import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/db/connect.js';
import { seedDemo } from '../src/demo/seed.js';
import { clearSessionCache } from '../src/lib/sessionCache.js';
import { resetHealthCache } from '../src/services/health.js';
import { resetQueueForTests, whenIdle } from '../src/services/queue.js';
import { signEmailVerificationToken } from '../src/services/verification.js';
import { User } from '../src/models/index.js';

export { app, request, whenIdle };

export async function startDb() {
  clearSessionCache();
  resetHealthCache();
  await connectDB();
  await mongoose.connection.dropDatabase();
}

export async function stopDb() {
  resetQueueForTests();
  clearSessionCache();
  resetHealthCache();
  await disconnectDB();
}

export async function seed() {
  await mongoose.connection.dropDatabase();
  return seedDemo({ reset: true });
}

export function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Registration is deliberately uniform and does not hand out a session, so
 * tests that need a signed-in account register and then sign in.
 */
export async function registerAndLogin(email, name, password = 'Threadline#2026') {
  const registered = await request(app).post('/api/auth/register').send({ email, name, password });
  if (registered.status !== 201) {
    throw new Error(
      `Registration failed for ${email}: ${registered.status} ${JSON.stringify(registered.body)}`,
    );
  }
  // The owner clicks the link from the confirmation mail. Tests stand in for
  // that mail client by signing the same token the service issues.
  const user = await User.findOne({ email });
  await request(app)
    .post('/api/auth/verify-email')
    .send({ token: signEmailVerificationToken(user) })
    .expect(200);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  if (login.status !== 200) {
    throw new Error(`Login failed for ${email}: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return login.body;
}

export function userOf(seeded, email) {
  return seeded.users.find((user) => user.email === email);
}

export function tokenOf(seeded, email) {
  return userOf(seeded, email).token;
}

export function idOf(seeded, email) {
  return userOf(seeded, email).id;
}

export function sourceIdOf(seeded, name) {
  const source = seeded.sources.find((entry) => entry.name === name);
  if (!source) throw new Error(`Demo source not found: ${name}`);
  return source.id;
}
