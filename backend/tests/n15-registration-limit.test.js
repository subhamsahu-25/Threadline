import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRegistrationLimiter } from '../src/routes/auth.routes.js';

function appWithLimiter() {
  const app = express();
  app.use(express.json());
  app.post(
    '/register',
    // The suite normally skips limiters; this instance runs the real config.
    createRegistrationLimiter({ skip: () => false }),
    (_req, res) => res.status(201).json({ created: true }),
  );
  return app;
}

describe('registration limiter', () => {
  it('counts successful registrations and stops the sixth in an hour', async () => {
    const app = appWithLimiter();

    for (let index = 0; index < 5; index += 1) {
      const response = await request(app)
        .post('/register')
        .send({ email: `person${index}@example.test`, name: 'Person', password: 'Str0ng#Pass' });
      expect(response.status).toBe(201);
      expect(response.body.created).toBe(true);
    }

    const blocked = await request(app)
      .post('/register')
      .send({ email: 'sixth@example.test', name: 'Person', password: 'Str0ng#Pass' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('too_many_attempts');
    expect(blocked.body.error.message).toContain('registrations');
  });
});
