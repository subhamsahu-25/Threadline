import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { connectDB, disconnectDB } from '../src/db/connect.js';
import { seedDemo } from '../src/demo/seed.js';
import { resetQueueForTests, whenIdle } from '../src/services/queue.js';

export { app, request, whenIdle };

export async function startDb() {
  await connectDB();
  await mongoose.connection.dropDatabase();
}

export async function stopDb() {
  resetQueueForTests();
  await disconnectDB();
}

export async function seed() {
  await mongoose.connection.dropDatabase();
  return seedDemo({ reset: true });
}

export function auth(token) {
  return { Authorization: `Bearer ${token}` };
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
