# AI Readiness Voice Interview

A real-time voice interview web application that assesses organisational AI readiness using the OpenAI Realtime API. Respondents can complete an adaptive voice interview or fill in the survey manually. Dimensions are configurable at runtime via an S3-hosted JSON file.

## Architecture

- **Frontend**: Static HTML/JS/CSS (Bootstrap 5), bundled with Vite, hosted on S3 + CloudFront
- **Backend**: Node.js/TypeScript Lambda functions behind API Gateway (HTTP API)
- **Storage**: S3 for allowlist, submissions, scoring jobs, and static assets
- **Queue**: SQS for async scoring (decouples scoring from API Gateway timeout)
- **Voice**: OpenAI Realtime API via WebRTC using the `@openai/agents-realtime` SDK
- **Scoring**: OpenAI `gpt-4o-mini` with Zod-enforced structured output (JSON Schema)
- **Secrets**: AWS Secrets Manager for OpenAI API key and admin key
- **Domain**: `ai-readiness-{env}.yourdomain.com` (configurable via `HOSTED_ZONE_DOMAIN`)

## Quick Start

### Prerequisites

- Node.js >= 20
- AWS CLI configured with appropriate permissions
- An OpenAI API key with Realtime access
- A Route53 hosted zone for your domain

### 1. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Store secrets in Secrets Manager

```bash
# OpenAI key
aws secretsmanager create-secret \
  --name ai-readiness/dev/openai-api-key \
  --secret-string '{"OPENAI_API_KEY":"sk-..."}' \
  --region ap-southeast-1

# Admin dashboard key
aws secretsmanager create-secret \
  --name ai-readiness/dev/admin-key \
  --secret-string '{"ADMIN_KEY":"your-secret-key"}' \
  --region ap-southeast-1
```

### 3. Configure your domain

Create a `.env` file in the project root (already gitignored):

```bash
echo "HOSTED_ZONE_DOMAIN=yourdomain.com" > .env
```

All scripts (`deploy.sh`, `generate-token.js`) auto-load this file.

### 4. Deploy infrastructure

```bash
# Full deploy (default)
npm run deploy

# Frontend only
npm run deploy -- front

# Backend (Lambda) only
npm run deploy -- back

# Frontend + backend (skip infra)
npm run deploy -- both

# Deploy prod
DEPLOY_ENV=prod npm run deploy
```

This creates all AWS resources: S3 buckets, SQS queue, Lambda functions, API Gateway, ACM certificate, CloudFront distribution with custom domain, and Route53 DNS records.

### 5. Generate tokens

```bash
# Single respondent
node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd"

# Batch from CSV
node scripts/generate-token.js --batch respondents.csv

# List all tokens
node scripts/generate-token.js --list
```

CSV format (header row optional):

```csv
name,company
Jane Doe,Acme Ltd
John Smith,Widgets Corp
```

Optional extra columns: `expires`, `portfolio`, `region`.

Re-running for an existing name/company revokes the old token and issues a new one.

Upload the allowlist to S3:

```bash
aws s3 cp allowlist.json s3://ai-readiness-dev-data/allowlist/allowlist.json
```

### 6. Configure dimensions

Create your `dimensions.json` from the template (see `backend/src/config/dimensions.example.json` for the format) and save it locally:

```bash
cp backend/src/config/dimensions.example.json config/dimensions.json
# Edit config/dimensions.json with your real questions
```

The `config/` directory is gitignored so your private questions stay out of the repo. The deploy script auto-uploads this file to S3 on every deploy. The path is configured in `.env`:

```
DIMENSIONS_FILE=config/dimensions.json
```

To update dimensions without a full redeploy, just run `./deploy.sh front` or upload directly:

```bash
aws s3 cp config/dimensions.json s3://ai-readiness-dev-data/config/dimensions.json
```

### 7. Access the app

```
Interview:  https://ai-readiness-dev.yourdomain.com/r/<TOKEN>
Admin:      https://ai-readiness-dev.yourdomain.com/admin.html
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `HOSTED_ZONE_DOMAIN` | `example.com` | Your Route53 hosted zone domain |
| `DEPLOY_ENV` | `dev` | Environment name (`dev`, `staging`, `prod`) |
| `AWS_REGION` | `ap-southeast-1` | AWS region for all resources |
| `DIMENSIONS_FILE` | `config/dimensions.json` | Path to private dimensions JSON (relative to project root) |
| `NOTIFICATION_EMAIL` | (none) | SES-verified email for score notifications; omit to disable |
| `SES_REGION` | (same as `AWS_REGION`) | AWS region where the sender email is verified in SES |
| `BASE_URL` | (derived from domain) | Full URL override for token generator |

## Environments

All AWS resources are fully isolated per environment:

| Resource | Naming pattern |
|---|---|
| S3 buckets | `ai-readiness-{env}-data`, `ai-readiness-{env}-public-web` |
| SQS queue | `ai-readiness-{env}-score-queue` |
| Lambda functions | `ai-readiness-{env}-get-respondent`, etc. |
| API Gateway | `ai-readiness-{env}-api` |
| Secrets Manager | `ai-readiness/{env}/openai-api-key`, `ai-readiness/{env}/admin-key` |
| IAM role | `ai-readiness-{env}-lambda-role` |
| CloudFront + domain | `ai-readiness-{env}.{HOSTED_ZONE_DOMAIN}` |

Set environment via `DEPLOY_ENV` env var or `--env` flag (for the token generator).

## API Endpoints

All endpoints are served via API Gateway at `https://ai-readiness-{env}.{domain}/api/`.

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `GET` | `/api/respondent/{token}` | `getRespondent` | Validate a token and return respondent info, submission status |
| `POST` | `/api/realtime/ephemeral` | `createEphemeral` | Create an ephemeral OpenAI Realtime client secret + system prompt |
| `GET` | `/api/config/dimensions` | `getConfig` | Return the dimensions configuration from S3 |
| `POST` | `/api/score` | `scoreEnqueue` | Enqueue an async scoring job (returns `jobId` immediately) |
| `GET` | `/api/score/{jobId}` | `getScoreResult` | Poll for scoring job status and result |
| `GET` | `/api/submission/{token}` | `getSubmission` | Retrieve a respondent's latest submission |
| `PUT` | `/api/submission/{token}` | `putSubmission` | Save/update a submission (used for manual edits) |
| `POST` | `/api/submission/{token}/clear` | `clearSubmission` | Archive existing submission and allow a fresh interview |
| `GET` | `/api/admin/dashboard` | `adminDashboard` | Aggregated dashboard data (requires admin key) |

The `score-worker` Lambda has no API Gateway route — it is triggered by SQS.

## Scoring Pipeline

Scoring is fully asynchronous to avoid API Gateway timeout constraints:

1. **Enqueue** — when the AI agent calls the `interview_complete` tool (or the user clicks "End Interview"), the frontend sends the transcript to `POST /api/score`. The `scoreEnqueue` Lambda stores the job in S3 (`jobs/{jobId}.json`) and sends a message to an SQS queue. Returns the `jobId` immediately.

2. **Process** — the `scoreWorker` Lambda is triggered by SQS. It loads the job from S3, calls OpenAI (`gpt-4o-mini`) with a structured output schema (Zod → JSON Schema) to score all dimensions, and writes the result back to the job file in S3.

3. **Auto-save submission** — on successful scoring, the worker also writes the submission to `submissions/{token}/latest.json` and a timestamped copy to `submissions/{token}/final/{ts}.json`. This ensures the scorecard is persisted server-side even if the user closes their browser.

4. **Poll** — the frontend polls `GET /api/score/{jobId}` every 2 seconds until the status is `complete` or `failed` (max 60 seconds).

5. **Display** — the scorecard is rendered for the user to review and optionally edit. Manual edits are saved via `PUT /api/submission/{token}` and create a new timestamped `final/` snapshot.

### Email Notifications

An optional email notification is sent each time a score is saved — both after automated scoring (via the score worker) and when a user saves from the frontend (via `PUT /api/submission`). The email contains an HTML table of all dimension scores grouped by category, with score, confidence, and rationale columns.

To enable notifications:

1. Verify the sender/recipient email address in [AWS SES](https://console.aws.amazon.com/ses/) (or move out of the SES sandbox for unrestricted sending)
2. Set the environment variables in `.env`:

```bash
NOTIFICATION_EMAIL=you@example.com
SES_REGION=eu-west-1          # region where the email is verified; omit if same as AWS_REGION
```

3. Redeploy (`npm run deploy -- back` or a full deploy) to update Lambda env vars and IAM permissions

If `NOTIFICATION_EMAIL` is unset or empty, no email is sent. If SES fails (unverified sender, sandbox limits, service error), the error is logged but the score save completes normally.

## Project Structure

```
ai-readiness-voice/
  README.md
  LICENSE
  package.json
  .env                         # Local config (HOSTED_ZONE_DOMAIN, DIMENSIONS_FILE)
  .gitignore
  config/
    dimensions.json            # Private dimensions config (gitignored, auto-uploaded)
  infra/
    aws/
      deploy.sh                # AWS CLI deployment script
      iam-policy.json          # Lambda execution role policy (reference)
      api-gateway.json         # API Gateway OpenAPI spec (reference)
  backend/
    package.json
    tsconfig.json
    src/
      handlers/                # Lambda handler functions
        getRespondent.ts       # Token validation + respondent lookup
        createEphemeral.ts     # Ephemeral Realtime API key + system prompt
        getSubmission.ts       # Retrieve latest submission
        putSubmission.ts       # Save/update submission (manual edits)
        clearSubmission.ts     # Archive submission for re-interview
        adminDashboard.ts      # Admin dashboard data aggregation
        getConfig.ts           # Serves dimensions config from S3
        scoreEnqueue.ts        # Enqueue async scoring job to SQS
        scoreWorker.ts         # SQS-triggered: OpenAI scoring + auto-save
        getScoreResult.ts      # Poll for scoring job result
      lib/                     # Shared utilities
        s3.ts                  # S3 get/put helpers
        allowlist.ts           # Token validation + lookup
        secrets.ts             # Secrets Manager access
        response.ts            # HTTP response helpers
        dimensions.ts          # Dimension config loading + formatting
        submission.ts          # Shared submission write logic
        scorecardSchema.ts     # Zod schema for structured scoring output
        email.ts               # SES email notification on score save
      config/
        dimensions.example.json # Example dimensions format (not used at runtime)
        systemPrompt.v1.txt    # Realtime interview instructions (template)
  frontend/
    package.json
    vite.config.js             # Vite build config (multi-page: index + admin)
    index.html                 # Interview SPA with token-based routing
    admin.html                 # Admin dashboard (password-protected)
    styles.css                 # Custom styles (Bootstrap base)
    src/
      app.js                   # Entry point, routing
      api.js                   # API client helpers (GET, POST, PUT)
      pages/
        interview.js           # Interview lifecycle + Realtime session management
        scorecard.js           # Scorecard rendering, editing, submission
      lib/
        state.js               # Shared application state
        dimensions.js          # Client-side dimension config
        scorecardHelpers.js    # Scorecard normalisation utilities
        utils.js               # General utilities
      realtimeSession.js       # OpenAI Agents Realtime SDK wrapper
  scripts/
    generate-token.js          # CLI tool to create/revoke tokens
```

## How It Works

1. Respondent visits unique token URL (`/r/<token>`)
2. Backend validates token against S3 allowlist
3. Respondent chooses one of two paths:

**Voice interview path:**

4. Frontend requests an ephemeral Realtime client secret, connects to OpenAI Realtime via WebRTC (`@openai/agents-realtime` SDK), and completes an adaptive ~5-minute interview
5. When the interview ends (AI calls `interview_complete` tool, or user clicks "End Interview"), the transcript is sent to the backend for async scoring via SQS
6. The scoring worker calls OpenAI with structured output (Zod schema) to produce a Likert (1–5) scorecard with rationale and evidence for each dimension
7. The scored submission is auto-saved to S3 by the backend — no browser action required
8. Frontend polls for the result and displays the scorecard for review

**Manual survey path:**

4. Respondent skips the voice interview and rates each dimension directly on a 1–5 scale

**Both paths:**

9. Respondent can review and edit scores; updates are saved on demand via `PUT /api/submission/{token}`
10. Returning respondents can view/edit their existing scores or start a fresh interview

## Admin Dashboard

The admin dashboard (`/admin.html`) provides a read-only overview of all respondents and their scores.

- Password-protected via a key stored in Secrets Manager
- Sortable table of all allowlist respondents with completion status
- Per-category average scores and overall average
- Expandable rows showing individual dimension scores
- CSV download of all data

## Security

- OpenAI API keys never reach the browser; ephemeral tokens expire in ~60 seconds
- Admin key stored in Secrets Manager (not in env vars or on disk)
- API Gateway stage-level throttling (rate limiting)
- S3 data bucket: public access blocked, default encryption (AES-256)
- CloudFront Origin Access Control (OAC) for S3; no direct bucket access
- CORS locked to the environment's custom domain (fail-closed)
- Content Security Policy (CSP) restricts script/style sources
- Input validation: token format whitelist, submission size caps, field sanitisation

## Dimensions

Dimensions are loaded at runtime from S3 (`config/dimensions.json`), not hardcoded in the application. The repo ships with a generic example at `backend/src/config/dimensions.example.json`.

Each dimension belongs to a category and is scored 1 (Strongly Disagree) to 5 (Strongly Agree) with evidence-backed rationale.

JSON format:

```json
{
  "version": "1.0",
  "categories": [
    {
      "id": "strategy",
      "label": "Strategy & Vision",
      "prefix": "st",
      "dimensions": [
        {
          "id": "st_clear_strategy",
          "statement": "The organisation has a clearly articulated strategy..."
        }
      ]
    }
  ]
}
```

Upload to S3 to activate:

```bash
aws s3 cp dimensions.json s3://ai-readiness-dev-data/config/dimensions.json
```

## License

[MIT](LICENSE)
