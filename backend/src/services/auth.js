import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      tv: user.tokenVersion || 0,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

export function publicUser(user) {
  const data = user.toJSON ? user.toJSON() : { ...user };
  delete data.passwordHash;
  if (!data.id && data._id) data.id = String(data._id);
  delete data._id;
  return data;
}
