# Disclosure of AI Tools and Reused Material — Round 3

Per the participation framework (rules on templates, AI assistance and
disclosure), this file lists every significant tool, generated component and
reused material used to build Threadline.

## AI used inside the product (runtime)

- **Google Gemini API** — structured extraction of decisions, tasks, risks,
  dependencies and open questions from ingested source chunks, when
  `GEMINI_API_KEY` is configured. Includes an automatic model-fallback chain
  and a deterministic, non-AI heuristic extractor when no key is present.
  Extracted items are always validated against verbatim source quotes before
  they can enter a handover.

## AI used during development

- **Qoder (Claude) agent** — pair-programming assistance across the build
  window: scaffolding the Express and React applications, implementing the
  ingestion / extraction / reconstruction / handover services, writing tests
  and documentation, and browser-automation for verification. All code was
  reviewed, run and tested as part of the normal development loop.
- **Google Stitch** — early UI design mockups used as visual reference for
  the frontend layout.
- **Gemini / ChatGPT** — drafting and structuring the Round 1 proposal and
  Round 2 progress report documents.

## No code reuse from previous projects

The repository was created fresh for this event. No templates, boilerplate
or previously written application code were reused beyond standard
open-source dependencies (below), which are used under their own licenses.

## Notable open-source dependencies

Express, Mongoose, mongodb-memory-server, Zod, jsonwebtoken, bcryptjs,
multer, helmet, express-rate-limit, cors, mammoth (DOCX parsing), unpdf (PDF
text extraction), React, React Router, Vite, Tailwind CSS, Vitest, Supertest,
lucide-react. All are used per their published licenses.

## Data disclosure

All demonstration data is synthetic and seeded by the application itself.
No confidential or workplace material was uploaded at any point.
