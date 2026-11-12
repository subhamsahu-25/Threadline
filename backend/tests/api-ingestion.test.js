import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, request, app, startDb, stopDb, whenIdle } from './helpers.js';

const MEMBER_EMAIL = 'member@api.test';

async function register(email, name) {
  const response = await request(app).post('/api/auth/register').send({
    email,
    name,
    password: 'Threadline#2026',
  });
  expect(response.status).toBe(201);
  return response.body;
}

function notes(namespace, statement) {
  return `# ${namespace}\n\n${statement}\n`;
}

describe('source ingestion over the HTTP API', () => {
  let projectId;
  let lead;
  let member;
  let restrictedSourceId;
  let restrictedDocumentId;

  beforeAll(async () => {
    await startDb();

    lead = await register('lead@api.test', 'Lead Person');
    member = await register(MEMBER_EMAIL, 'Member Person');

    const project = await request(app)
      .post('/api/projects')
      .set(auth(lead.token))
      .send({
        key: 'INGEST',
        name: 'Ingestion Test Project',
        description: 'Created by the API test suite',
        members: [{ email: MEMBER_EMAIL, role: 'contributor' }],
        transition: {
          outgoingUserId: member.user.id,
          outgoingName: member.user.name,
          context: 'Member is rotating off the project.',
        },
      });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;
  });

  afterAll(async () => {
    await stopDb();
  });

  it('ingests an uploaded document and serves evidence with context', async () => {
    const upload = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(lead.token))
      .field('name', 'Weekly sync')
      .attach(
        'files',
        Buffer.from(
          notes(
            'Weekly sync',
            'Decision: Ship the beta on 2026-12-15. (date: 2026-10-02, status: active)\nTask: Draft the release notes (owner: Member Person, due: 2026-11-25, status: open)',
          ),
          'utf8',
        ),
        'sync.md',
      );

    expect(upload.status).toBe(202);
    expect(upload.body.source.status).toBe('queued');
    await whenIdle({ timeoutMs: 60_000 });

    const sources = await request(app)
      .get(`/api/projects/${projectId}/sources`)
      .set(auth(lead.token))
      .expect(200);
    const ingested = sources.body.sources.find((source) => source.name === 'Weekly sync');
    expect(ingested.status).toBe('ready');
    expect(ingested.stats.claims).toBeGreaterThanOrEqual(2);

    const claims = await request(app)
      .get(`/api/projects/${projectId}/claims`)
      .set(auth(member.token))
      .expect(200);
    expect(claims.body.total).toBeGreaterThanOrEqual(2);

    const decision = claims.body.claims.find((claim) => claim.type === 'decision');
    expect(decision.statement).toBe('Ship the beta on 2026-12-15.');
    expect(decision.citations[0].validation).toBe('exact');

    const evidence = await request(app)
      .get(`/api/projects/${projectId}/evidence/${decision.citations[0].evidenceId}`)
      .set(auth(member.token))
      .expect(200);
    expect(evidence.body.source.name).toBe('Weekly sync');
    expect(evidence.body.context).toContain(evidence.body.evidence.quote);
    expect(evidence.body.context.slice(evidence.body.highlight.start, evidence.body.highlight.end)).toBe(
      evidence.body.evidence.quote,
    );

    const audit = await request(app)
      .get(`/api/projects/${projectId}/audit`)
      .set(auth(lead.token))
      .expect(200);
    expect(audit.body.events.map((event) => event.action)).toContain('source.ingested');
  });

  it('keeps a role-restricted source out of the member experience', async () => {
    const upload = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(lead.token))
      .field('name', 'Compensation review')
      .field('sensitivity', 'confidential')
      .field('visibility', JSON.stringify({ scope: 'roles', roles: ['lead'], users: [] }))
      .attach(
        'files',
        Buffer.from(
          notes(
            'Compensation review',
            'Decision: Approve the confidential severance package for the vendor team.\nTask: Notify the vendor account manager (owner: Lead Person, status: open)',
          ),
          'utf8',
        ),
        'compensation.md',
      );

    expect(upload.status).toBe(202);
    restrictedSourceId = upload.body.source.id;
    await whenIdle({ timeoutMs: 60_000 });

    const memberClaims = await request(app)
      .get(`/api/projects/${projectId}/claims`)
      .set(auth(member.token))
      .expect(200);
    expect(JSON.stringify(memberClaims.body)).not.toContain('severance');

    const leadClaims = await request(app)
      .get(`/api/projects/${projectId}/claims`)
      .set(auth(lead.token))
      .expect(200);
    expect(JSON.stringify(leadClaims.body)).toContain('severance');

    const memberState = await request(app)
      .get(`/api/projects/${projectId}/state`)
      .set(auth(member.token))
      .expect(200);
    expect(JSON.stringify(memberState.body)).not.toContain('severance');
    expect(memberState.body.visibleClaimCount).toBeLessThan(leadClaims.body.total);

    await request(app)
      .get(`/api/projects/${projectId}/sources/${restrictedSourceId}`)
      .set(auth(member.token))
      .expect(403);

    const memberSources = await request(app)
      .get(`/api/projects/${projectId}/sources`)
      .set(auth(member.token))
      .expect(200);
    expect(memberSources.body.sources.some((source) => source.id === restrictedSourceId)).toBe(false);

    const leadSources = await request(app)
      .get(`/api/projects/${projectId}/sources`)
      .set(auth(lead.token))
      .expect(200);
    expect(leadSources.body.sources.some((source) => source.id === restrictedSourceId)).toBe(true);

    const leadDocuments = await request(app)
      .get(`/api/projects/${projectId}/documents?sourceId=${restrictedSourceId}`)
      .set(auth(lead.token))
      .expect(200);
    restrictedDocumentId = leadDocuments.body.documents[0].id;

    await request(app)
      .get(`/api/projects/${projectId}/documents/${restrictedDocumentId}`)
      .set(auth(member.token))
      .expect(403);

    const memberDocuments = await request(app)
      .get(`/api/projects/${projectId}/documents`)
      .set(auth(member.token))
      .expect(200);
    expect(memberDocuments.body.documents.some((document) => document.id === restrictedDocumentId)).toBe(
      false,
    );
  });

  it('rejects unsupported uploads before ingestion', async () => {
    const upload = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(lead.token))
      .attach('files', Buffer.from('MZ'), 'installer.exe');

    expect(upload.status).toBe(415);
    expect(upload.body.error.code).toBe('unsupported_file');
  });
});
