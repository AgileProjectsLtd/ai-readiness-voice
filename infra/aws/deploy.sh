#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# AI Readiness Voice Interview — AWS Deployment
# ─────────────────────────────────────────────────
# Configure these variables before running:

SCRIPT_DIR_EARLY="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR_EARLY/../.." && pwd)/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

REGION="${AWS_REGION:-ap-southeast-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
PROJECT="ai-readiness"
ENV="${DEPLOY_ENV:-dev}"

HOSTED_ZONE_DOMAIN="${HOSTED_ZONE_DOMAIN:-example.com}"
CUSTOM_DOMAIN="ai-readiness-${ENV}.${HOSTED_ZONE_DOMAIN}"

WEB_BUCKET="${PROJECT}-${ENV}-public-web"
DATA_BUCKET="${PROJECT}-${ENV}-data"
LAMBDA_ROLE_NAME="${PROJECT}-${ENV}-lambda-role"
API_NAME="${PROJECT}-${ENV}-api"
SECRET_NAME="ai-readiness/${ENV}/openai-api-key"
ADMIN_SECRET_NAME="ai-readiness/${ENV}/admin-key"
LAMBDA_RUNTIME="nodejs24.x"
LAMBDA_TIMEOUT=30
LAMBDA_MEMORY=2048

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── Deploy mode flag ───
# Usage: ./deploy.sh [front|back|both]
#   front — build & upload frontend + invalidate cache only
#   back  — build & deploy Lambda functions only
#   both  — front + back (skip infra provisioning)
#   (no arg) — full deploy (all infrastructure + code)
DEPLOY_MODE="${1:-full}"
case "$DEPLOY_MODE" in
  front|back|both|full) ;;
  *) echo "Usage: $0 [front|back|both]"; exit 1 ;;
esac

echo "=== AI Readiness Voice — Deploying [${ENV}] to ${REGION} ==="
echo "Account: ${ACCOUNT_ID}"
echo "Domain:  ${CUSTOM_DOMAIN}"
echo "Mode:    ${DEPLOY_MODE}"
echo ""

if [ "$DEPLOY_MODE" = "full" ]; then
# ─────────────────────────────────────────────────
# 1. S3 Buckets
# ─────────────────────────────────────────────────
echo "--- Creating S3 buckets ---"

# Web bucket (static hosting)
if ! aws s3api head-bucket --bucket "$WEB_BUCKET" 2>/dev/null; then
  aws s3api create-bucket \
    --bucket "$WEB_BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  echo "Created web bucket: $WEB_BUCKET"
else
  echo "Web bucket already exists: $WEB_BUCKET"
fi

aws s3 website "s3://${WEB_BUCKET}" \
  --index-document index.html \
  --error-document index.html

aws s3api put-public-access-block \
  --bucket "$WEB_BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Data bucket (private)
if ! aws s3api head-bucket --bucket "$DATA_BUCKET" 2>/dev/null; then
  aws s3api create-bucket \
    --bucket "$DATA_BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  echo "Created data bucket: $DATA_BUCKET"
else
  echo "Data bucket already exists: $DATA_BUCKET"
fi

aws s3api put-public-access-block \
  --bucket "$DATA_BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-versioning \
  --bucket "$DATA_BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$DATA_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
echo "Enabled default encryption (SSE-S3) on $DATA_BUCKET"

echo ""

# ─────────────────────────────────────────────────
# 2. IAM Role for Lambda
# ─────────────────────────────────────────────────
echo "--- Setting up IAM role ---"

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'

ROLE_ARN=$(aws iam get-role --role-name "$LAMBDA_ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || true)

if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
  ROLE_ARN=$(aws iam create-role \
    --role-name "$LAMBDA_ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --query 'Role.Arn' --output text)
  echo "Created IAM role: $LAMBDA_ROLE_NAME"
  sleep 10  # Wait for role propagation
else
  echo "IAM role already exists: $LAMBDA_ROLE_NAME"
fi

# Inline policy with actual resource ARNs
POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::${DATA_BUCKET}/allowlist/*",
        "arn:aws:s3:::${DATA_BUCKET}/config/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:CopyObject"],
      "Resource": "arn:aws:s3:::${DATA_BUCKET}/submissions/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${DATA_BUCKET}"
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": [
        "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${SECRET_NAME}*",
        "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${ADMIN_SECRET_NAME}*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:*"
    }
  ]
}
EOF
)

aws iam put-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name "${PROJECT}-${ENV}-lambda-policy" \
  --policy-document "$POLICY"

echo ""

echo ""

fi # end full-only: S3 + IAM

# ─────────────────────────────────────────────────
# 3. Build and package Lambda
# ─────────────────────────────────────────────────
if [ "$DEPLOY_MODE" = "full" ] || [ "$DEPLOY_MODE" = "back" ] || [ "$DEPLOY_MODE" = "both" ]; then

# Ensure ROLE_ARN is available for Lambda deploys (already set in full mode)
if [ -z "${ROLE_ARN:-}" ]; then
  ROLE_ARN=$(aws iam get-role --role-name "$LAMBDA_ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || true)
  if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
    echo "ERROR: IAM role $LAMBDA_ROLE_NAME not found. Run a full deploy first."
    exit 1
  fi
fi

echo "--- Building backend ---"

cd "$ROOT_DIR/backend"
npm ci --production=false
npm run build

# Package: dist + node_modules + config files
PACKAGE_DIR=$(mktemp -d)
cp -r dist/* "$PACKAGE_DIR/"
cp -r node_modules "$PACKAGE_DIR/"
mkdir -p "$PACKAGE_DIR/config"
cp src/config/systemPrompt.v1.txt "$PACKAGE_DIR/config/"

cd "$PACKAGE_DIR"
zip -r "$ROOT_DIR/backend/lambda-package.zip" . -q
cd "$ROOT_DIR"
rm -rf "$PACKAGE_DIR"

LAMBDA_ZIP="fileb://${ROOT_DIR}/backend/lambda-package.zip"
echo "Package created: backend/lambda-package.zip"
echo ""

# ─────────────────────────────────────────────────
# 4. Create/Update Lambda functions
# ─────────────────────────────────────────────────
echo "--- Deploying Lambda functions ---"

LAMBDA_ENV="Variables={DATA_BUCKET=${DATA_BUCKET},OPENAI_SECRET_NAME=${SECRET_NAME},ADMIN_SECRET_NAME=${ADMIN_SECRET_NAME},AWS_REGION_OVERRIDE=${REGION},ALLOWED_ORIGIN=https://${CUSTOM_DOMAIN}}"

FUNC_NAMES=(
  "${PROJECT}-${ENV}-get-respondent"
  "${PROJECT}-${ENV}-create-ephemeral"
  "${PROJECT}-${ENV}-get-submission"
  "${PROJECT}-${ENV}-put-submission"
  "${PROJECT}-${ENV}-clear-submission"
  "${PROJECT}-${ENV}-admin-dashboard"
  "${PROJECT}-${ENV}-get-config"
)

FUNC_HANDLERS=(
  "handlers/getRespondent.handler"
  "handlers/createEphemeral.handler"
  "handlers/getSubmission.handler"
  "handlers/putSubmission.handler"
  "handlers/clearSubmission.handler"
  "handlers/adminDashboard.handler"
  "handlers/getConfig.handler"
)

deploy_lambda() {
  local func_name="$1"
  local handler="$2"

  EXISTING=$(aws lambda get-function --function-name "$func_name" 2>/dev/null || true)

  if [ -z "$EXISTING" ]; then
    aws lambda create-function \
      --function-name "$func_name" \
      --runtime "$LAMBDA_RUNTIME" \
      --role "$ROLE_ARN" \
      --handler "$handler" \
      --zip-file "$LAMBDA_ZIP" \
      --timeout "$LAMBDA_TIMEOUT" \
      --memory-size "$LAMBDA_MEMORY" \
      --environment "$LAMBDA_ENV" \
      --no-cli-pager
    echo "Created Lambda: $func_name"
  else
    aws lambda update-function-code \
      --function-name "$func_name" \
      --zip-file "$LAMBDA_ZIP" \
      --no-cli-pager
    echo "Updated Lambda code: $func_name"

    echo "Waiting for code update to complete..."
    aws lambda wait function-updated \
      --function-name "$func_name"

    aws lambda update-function-configuration \
      --function-name "$func_name" \
      --runtime "$LAMBDA_RUNTIME" \
      --role "$ROLE_ARN" \
      --handler "$handler" \
      --timeout "$LAMBDA_TIMEOUT" \
      --memory-size "$LAMBDA_MEMORY" \
      --environment "$LAMBDA_ENV" \
      --no-cli-pager
    echo "Updated Lambda config: $func_name"
  fi
}

for i in "${!FUNC_NAMES[@]}"; do
  deploy_lambda "${FUNC_NAMES[$i]}" "${FUNC_HANDLERS[$i]}"
done

echo ""
echo "Backend deploy complete."
echo ""

fi # end back/both: Lambda build + deploy

# ─────────────────────────────────────────────────
# 5. API Gateway (HTTP API)
# ─────────────────────────────────────────────────
if [ "$DEPLOY_MODE" = "full" ]; then
echo "--- Setting up API Gateway ---"

API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null || true)

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID=$(aws apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --cors-configuration "AllowOrigins=https://${CUSTOM_DOMAIN},AllowMethods=GET,POST,OPTIONS,AllowHeaders=Content-Type,Authorization" \
    --query 'ApiId' --output text)
  echo "Created API Gateway: $API_ID"
else
  echo "API Gateway already exists: $API_ID"
  aws apigatewayv2 update-api \
    --api-id "$API_ID" \
    --cors-configuration "AllowOrigins=https://${CUSTOM_DOMAIN},AllowMethods=GET,POST,OPTIONS,AllowHeaders=Content-Type,Authorization" \
    --no-cli-pager
  echo "Updated API Gateway CORS for: ${CUSTOM_DOMAIN}"
fi

# Clean up orphaned integrations before creating/updating
echo "Cleaning up orphaned integrations..."
EXISTING_INTEGRATIONS=$(aws apigatewayv2 get-integrations \
  --api-id "$API_ID" \
  --query 'Items[].IntegrationId' --output text 2>/dev/null || true)

EXISTING_ROUTES_JSON=$(aws apigatewayv2 get-routes \
  --api-id "$API_ID" \
  --query 'Items[].[RouteKey,Target]' --output json 2>/dev/null || echo "[]")

# Build a list of integration IDs actually used by routes
USED_INTEGRATION_IDS=$(echo "$EXISTING_ROUTES_JSON" | python3 -c "
import sys, json
routes = json.load(sys.stdin)
for r in routes:
    target = r[1] if len(r) > 1 and r[1] else ''
    if target.startswith('integrations/'):
        print(target.split('/')[1])
" 2>/dev/null || true)

ORPHAN_COUNT=0
ORPHAN_IDS=""
for INT_ID in $EXISTING_INTEGRATIONS; do
  if ! echo "$USED_INTEGRATION_IDS" | grep -q "$INT_ID"; then
    ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
    ORPHAN_IDS="${ORPHAN_IDS} ${INT_ID}"
  fi
done

if [ "$ORPHAN_COUNT" -gt 0 ]; then
  echo "Found ${ORPHAN_COUNT} orphaned integrations:${ORPHAN_IDS}"
  read -r -p "Delete them? [y/N] " CONFIRM
  if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
    for INT_ID in $ORPHAN_IDS; do
      aws apigatewayv2 delete-integration \
        --api-id "$API_ID" \
        --integration-id "$INT_ID" \
        --no-cli-pager 2>/dev/null || true
      echo "  Removed: $INT_ID"
    done
  else
    echo "  Skipped cleanup."
  fi
else
  echo "  No orphaned integrations found."
fi

# Create or update integrations and routes
ROUTE_KEYS=(
  "GET /api/respondent/{token}"
  "POST /api/realtime/ephemeral"
  "GET /api/submission/{token}"
  "POST /api/submission/{token}"
  "POST /api/submission/{token}/clear"
  "GET /api/admin/dashboard"
  "GET /api/config/dimensions"
)

ROUTE_FUNCS=(
  "${PROJECT}-${ENV}-get-respondent"
  "${PROJECT}-${ENV}-create-ephemeral"
  "${PROJECT}-${ENV}-get-submission"
  "${PROJECT}-${ENV}-put-submission"
  "${PROJECT}-${ENV}-clear-submission"
  "${PROJECT}-${ENV}-admin-dashboard"
  "${PROJECT}-${ENV}-get-config"
)

ensure_route() {
  local route_key="$1"
  local func_name="$2"
  local func_arn="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${func_name}"

  # Check if route already exists
  local existing_route_id
  existing_route_id=$(echo "$EXISTING_ROUTES_JSON" | python3 -c "
import sys, json
routes = json.load(sys.stdin)
for r in routes:
    if r[0] == '${route_key}':
        target = r[1] if len(r) > 1 and r[1] else ''
        print(target.replace('integrations/', ''))
        break
" 2>/dev/null || true)

  if [ -n "$existing_route_id" ] && [ "$existing_route_id" != "" ]; then
    # Route exists — update integration URI to point to current Lambda
    aws apigatewayv2 update-integration \
      --api-id "$API_ID" \
      --integration-id "$existing_route_id" \
      --integration-uri "$func_arn" \
      --no-cli-pager 2>/dev/null || true
    echo "  Updated route: $route_key -> $func_name"
    return
  fi

  # Route doesn't exist — create integration and route
  local integration_id
  integration_id=$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type AWS_PROXY \
    --integration-uri "$func_arn" \
    --payload-format-version "2.0" \
    --query 'IntegrationId' --output text 2>/dev/null || true)

  if [ -n "$integration_id" ] && [ "$integration_id" != "None" ]; then
    aws apigatewayv2 create-route \
      --api-id "$API_ID" \
      --route-key "$route_key" \
      --target "integrations/${integration_id}" \
      --no-cli-pager 2>/dev/null || true

    aws lambda add-permission \
      --function-name "$func_name" \
      --statement-id "apigateway-${func_name}" \
      --action "lambda:InvokeFunction" \
      --principal "apigateway.amazonaws.com" \
      --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*" \
      --no-cli-pager 2>/dev/null || true

    echo "  Created route: $route_key -> $func_name"
  fi
}

echo "Ensuring routes..."
for i in "${!ROUTE_KEYS[@]}"; do
  ensure_route "${ROUTE_KEYS[$i]}" "${ROUTE_FUNCS[$i]}"
done

# Create default stage with auto-deploy
aws apigatewayv2 create-stage \
  --api-id "$API_ID" \
  --stage-name '$default' \
  --auto-deploy \
  --no-cli-pager 2>/dev/null || true

# Stage-level throttling (burst: 10 req/s, sustained: 5 req/s)
aws apigatewayv2 update-stage \
  --api-id "$API_ID" \
  --stage-name '$default' \
  --default-route-settings '{"ThrottlingBurstLimit":10,"ThrottlingRateLimit":5}' \
  --no-cli-pager
echo "Applied stage-level throttle: 10 burst / 5 sustained req/s"

API_ENDPOINT=$(aws apigatewayv2 get-api --api-id "$API_ID" --query 'ApiEndpoint' --output text)
echo "API endpoint: $API_ENDPOINT"
echo ""

fi # end full-only: API Gateway

# ─────────────────────────────────────────────────
# 6. Build and upload frontend to S3
# ─────────────────────────────────────────────────
if [ "$DEPLOY_MODE" = "full" ] || [ "$DEPLOY_MODE" = "front" ] || [ "$DEPLOY_MODE" = "both" ]; then
echo "--- Building frontend ---"

cd "$ROOT_DIR/frontend"
npm ci --prefer-offline
npm run build

echo "--- Uploading frontend ---"

aws s3 sync dist/ "s3://${WEB_BUCKET}/" \
  --delete \
  --cache-control "max-age=300"

cd "$ROOT_DIR"

# Invalidate CloudFront cache for frontend-only deploys
if [ "$DEPLOY_MODE" = "front" ] || [ "$DEPLOY_MODE" = "both" ]; then
  DIST_ID=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Aliases.Items[?@=='${CUSTOM_DOMAIN}']].Id | [0]" \
    --output text 2>/dev/null || true)
  if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
    echo "Invalidating CloudFront cache..."
    aws cloudfront create-invalidation \
      --distribution-id "$DIST_ID" \
      --paths "/*" \
      --query 'Invalidation.Id' --output text --no-cli-pager
    echo "Cache invalidation submitted."
  fi
fi

echo ""
echo "Frontend deploy complete."
echo ""

fi # end front/both: frontend build + upload

# ─────────────────────────────────────────────────
# 6b. Upload dimensions config to S3 (runs on every deploy mode)
# ─────────────────────────────────────────────────
DIMENSIONS_FILE="${DIMENSIONS_FILE:-config/dimensions.json}"
DIMS_PATH="$ROOT_DIR/$DIMENSIONS_FILE"
if [ -f "$DIMS_PATH" ]; then
  echo "--- Uploading dimensions config ---"
  aws s3 cp "$DIMS_PATH" "s3://${DATA_BUCKET}/config/dimensions.json" --quiet
  echo "Uploaded $DIMENSIONS_FILE → s3://${DATA_BUCKET}/config/dimensions.json"
else
  echo "WARNING: Dimensions file not found at $DIMS_PATH — skipping upload."
  echo "         Set DIMENSIONS_FILE in .env or create the file."
fi
echo ""

# ─────────────────────────────────────────────────
# 7. ACM Certificate (must be in us-east-1 for CloudFront)
# ─────────────────────────────────────────────────
if [ "$DEPLOY_MODE" = "full" ]; then
echo "--- Setting up ACM certificate for ${CUSTOM_DOMAIN} ---"

CERT_ARN=$(aws acm list-certificates \
  --region us-east-1 \
  --certificate-statuses ISSUED PENDING_VALIDATION \
  --query "CertificateSummaryList[?DomainName=='${CUSTOM_DOMAIN}'].CertificateArn | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  CERT_ARN=$(aws acm request-certificate \
    --region us-east-1 \
    --domain-name "$CUSTOM_DOMAIN" \
    --validation-method DNS \
    --query 'CertificateArn' --output text)
  echo "Requested certificate: $CERT_ARN"

  echo "Waiting for DNS validation details..."
  sleep 5

  VALIDATION_JSON=$(aws acm describe-certificate \
    --region us-east-1 \
    --certificate-arn "$CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord' \
    --output json)

  VALIDATION_NAME=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Name'])")
  VALIDATION_VALUE=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Value'])")

  echo "Creating DNS validation record: ${VALIDATION_NAME}"

  HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
    --dns-name "$HOSTED_ZONE_DOMAIN" \
    --query "HostedZones[?Name=='${HOSTED_ZONE_DOMAIN}.'].Id | [0]" \
    --output text | sed 's|/hostedzone/||')

  if [ -z "$HOSTED_ZONE_ID" ] || [ "$HOSTED_ZONE_ID" = "None" ]; then
    echo "ERROR: Hosted zone for ${HOSTED_ZONE_DOMAIN} not found in Route53."
    echo "Please create it first or verify the domain name."
    exit 1
  fi

  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "{
      \"Changes\": [{
        \"Action\": \"UPSERT\",
        \"ResourceRecordSet\": {
          \"Name\": \"${VALIDATION_NAME}\",
          \"Type\": \"CNAME\",
          \"TTL\": 300,
          \"ResourceRecords\": [{\"Value\": \"${VALIDATION_VALUE}\"}]
        }
      }]
    }" --no-cli-pager

  echo "Waiting for certificate validation (this may take a few minutes)..."
  aws acm wait certificate-validated \
    --region us-east-1 \
    --certificate-arn "$CERT_ARN"
  echo "Certificate validated."
else
  echo "Certificate already exists: $CERT_ARN"

  CERT_STATUS=$(aws acm describe-certificate \
    --region us-east-1 \
    --certificate-arn "$CERT_ARN" \
    --query 'Certificate.Status' --output text)

  if [ "$CERT_STATUS" = "PENDING_VALIDATION" ]; then
    echo "Certificate is pending validation. Waiting..."
    aws acm wait certificate-validated \
      --region us-east-1 \
      --certificate-arn "$CERT_ARN"
    echo "Certificate validated."
  fi
fi

echo ""

# ─────────────────────────────────────────────────
# 8. CloudFront Distribution
# ─────────────────────────────────────────────────
echo "--- Setting up CloudFront ---"

# Look up by CNAME alias first (preferred — this is the one we want to keep)
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Aliases.Items[?@=='${CUSTOM_DOMAIN}']].Id | [0]" \
  --output text 2>/dev/null || true)

# Fallback: look up by S3 origin
if [ -z "$DIST_ID" ] || [ "$DIST_ID" = "None" ]; then
  DIST_ID=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Origins.Items[?DomainName=='${WEB_BUCKET}.s3.${REGION}.amazonaws.com']].Id | [0]" \
    --output text 2>/dev/null || true)
fi

# Check for orphaned distributions (origin match without the CNAME)
if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  ORIGIN_DIST_ID=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Origins.Items[?DomainName=='${WEB_BUCKET}.s3.${REGION}.amazonaws.com']].Id | [0]" \
    --output text 2>/dev/null || true)

  if [ -n "$ORIGIN_DIST_ID" ] && [ "$ORIGIN_DIST_ID" != "None" ] && [ "$ORIGIN_DIST_ID" != "$DIST_ID" ]; then
    echo ""
    echo "WARNING: Found an extra CloudFront distribution: $ORIGIN_DIST_ID"
    echo "  The active distribution with your custom domain is: $DIST_ID"
    echo "  You should disable and delete $ORIGIN_DIST_ID in the AWS console."
    echo ""
  fi
fi

API_DOMAIN=$(echo "$API_ENDPOINT" | sed 's|https://||')

# Ensure OAC exists (look up first, create if missing)
OAC_NAME="${PROJECT}-${ENV}-oac"
OAC_ID=$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='${OAC_NAME}'].Id | [0]" \
  --output text 2>/dev/null || true)

if [ -z "$OAC_ID" ] || [ "$OAC_ID" = "None" ]; then
  OAC_ID=$(aws cloudfront create-origin-access-control \
    --origin-access-control-config "{
      \"Name\": \"${OAC_NAME}\",
      \"OriginAccessControlOriginType\": \"s3\",
      \"SigningBehavior\": \"always\",
      \"SigningProtocol\": \"sigv4\"
    }" \
    --query 'OriginAccessControl.Id' --output text)
  echo "Created OAC: $OAC_ID"
else
  echo "OAC already exists: $OAC_ID"
fi

if [ -z "$DIST_ID" ] || [ "$DIST_ID" = "None" ]; then
  # ── Create new distribution ──
  CF_CONFIG=$(cat <<CFEOF
{
  "CallerReference": "${PROJECT}-${ENV}-$(date +%s)",
  "Comment": "AI Readiness Voice Interview (${ENV})",
  "Aliases": {
    "Quantity": 1,
    "Items": ["${CUSTOM_DOMAIN}"]
  },
  "ViewerCertificate": {
    "ACMCertificateArn": "${CERT_ARN}",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-web",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": {
        "Quantity": 2,
        "Items": ["GET", "HEAD"]
      }
    },
    "ForwardedValues": {
      "QueryString": false,
      "Cookies": { "Forward": "none" }
    },
    "MinTTL": 0,
    "DefaultTTL": 300,
    "MaxTTL": 1200,
    "Compress": true
  },
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "s3-web",
        "DomainName": "${WEB_BUCKET}.s3.${REGION}.amazonaws.com",
        "OriginAccessControlId": "${OAC_ID}",
        "S3OriginConfig": {
          "OriginAccessIdentity": ""
        }
      },
      {
        "Id": "api-gateway",
        "DomainName": "${API_DOMAIN}",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only"
        }
      }
    ]
  },
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "api-gateway",
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": {
          "Quantity": 7,
          "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": {
            "Quantity": 2,
            "Items": ["GET", "HEAD"]
          }
        },
        "ForwardedValues": {
          "QueryString": true,
          "Headers": {
            "Quantity": 3,
            "Items": ["Authorization", "Content-Type", "Accept"]
          },
          "Cookies": { "Forward": "none" }
        },
        "MinTTL": 0,
        "DefaultTTL": 0,
        "MaxTTL": 0,
        "Compress": true
      }
    ]
  },
  "DefaultRootObject": "index.html",
  "CustomErrorResponses": {
    "Quantity": 2,
    "Items": [
      {
        "ErrorCode": 403,
        "ResponsePagePath": "/index.html",
        "ResponseCode": "200",
        "ErrorCachingMinTTL": 0
      },
      {
        "ErrorCode": 404,
        "ResponsePagePath": "/index.html",
        "ResponseCode": "200",
        "ErrorCachingMinTTL": 0
      }
    ]
  },
  "Enabled": true
}
CFEOF
)

  DIST_ID=$(aws cloudfront create-distribution \
    --distribution-config "$CF_CONFIG" \
    --query 'Distribution.Id' --output text)
  echo "Created CloudFront distribution: $DIST_ID"

else
  # ── Update existing distribution if needed ──
  echo "CloudFront distribution already exists: $DIST_ID"

  CURRENT_ALIASES=$(aws cloudfront get-distribution \
    --id "$DIST_ID" \
    --query "Distribution.DistributionConfig.Aliases.Items" \
    --output text 2>/dev/null || true)

  CURRENT_CERT=$(aws cloudfront get-distribution \
    --id "$DIST_ID" \
    --query "Distribution.DistributionConfig.ViewerCertificate.ACMCertificateArn" \
    --output text 2>/dev/null || true)

  if echo "$CURRENT_ALIASES" | grep -q "$CUSTOM_DOMAIN" && [ "$CURRENT_CERT" = "$CERT_ARN" ]; then
    echo "  Custom domain and certificate already configured. No update needed."
  else
    echo "  Updating distribution with custom domain and certificate..."

    ETAG=$(aws cloudfront get-distribution-config \
      --id "$DIST_ID" \
      --query 'ETag' --output text)

    aws cloudfront get-distribution-config \
      --id "$DIST_ID" \
      --query 'DistributionConfig' \
      --output json > /tmp/cf-dist-config.json

    python3 -c "
import json

with open('/tmp/cf-dist-config.json') as f:
    config = json.load(f)

config['Aliases'] = {'Quantity': 1, 'Items': ['${CUSTOM_DOMAIN}']}
config['ViewerCertificate'] = {
    'ACMCertificateArn': '${CERT_ARN}',
    'SSLSupportMethod': 'sni-only',
    'MinimumProtocolVersion': 'TLSv1.2_2021'
}

with open('/tmp/cf-dist-config.json', 'w') as f:
    json.dump(config, f, indent=2)
"

    aws cloudfront update-distribution \
      --id "$DIST_ID" \
      --if-match "$ETAG" \
      --distribution-config "file:///tmp/cf-dist-config.json" \
      --no-cli-pager

    rm -f /tmp/cf-dist-config.json
    echo "  Updated CloudFront distribution: $DIST_ID"
  fi
fi

# Ensure OAC is attached to the S3 origin (for existing distributions)
CURRENT_OAC=$(aws cloudfront get-distribution-config \
  --id "$DIST_ID" \
  --query "DistributionConfig.Origins.Items[?Id=='s3-web'].OriginAccessControlId | [0]" \
  --output text 2>/dev/null || true)

if [ "$CURRENT_OAC" != "$OAC_ID" ]; then
  echo "Attaching OAC to S3 origin..."
  ETAG_OAC=$(aws cloudfront get-distribution-config \
    --id "$DIST_ID" --query 'ETag' --output text)

  aws cloudfront get-distribution-config \
    --id "$DIST_ID" --query 'DistributionConfig' \
    --output json > /tmp/cf-oac-config.json

  python3 -c "
import json
with open('/tmp/cf-oac-config.json') as f:
    config = json.load(f)
for origin in config.get('Origins', {}).get('Items', []):
    if origin['Id'] == 's3-web':
        origin['OriginAccessControlId'] = '${OAC_ID}'
with open('/tmp/cf-oac-config.json', 'w') as f:
    json.dump(config, f, indent=2)
"

  aws cloudfront update-distribution \
    --id "$DIST_ID" \
    --if-match "$ETAG_OAC" \
    --distribution-config "file:///tmp/cf-oac-config.json" \
    --no-cli-pager
  rm -f /tmp/cf-oac-config.json
  echo "  OAC attached to distribution: $DIST_ID"
else
  echo "OAC already attached to S3 origin."
fi

# S3 bucket policy: allow CloudFront OAC to read from the web bucket
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
WEB_BUCKET_POLICY=$(cat <<BPEOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": {"Service": "cloudfront.amazonaws.com"},
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${WEB_BUCKET}/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "${DIST_ARN}"
        }
      }
    }
  ]
}
BPEOF
)

aws s3api put-bucket-policy \
  --bucket "$WEB_BUCKET" \
  --policy "$WEB_BUCKET_POLICY"
echo "Applied web bucket policy (CloudFront OAC only)"

CF_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)

# Invalidate CloudFront cache so new frontend files are served immediately
echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' --output text --no-cli-pager
echo "Cache invalidation submitted."
echo ""

# ─────────────────────────────────────────────────
# 9. Route53 DNS alias record
# ─────────────────────────────────────────────────
echo "--- Creating Route53 alias for ${CUSTOM_DOMAIN} ---"

if [ -z "${HOSTED_ZONE_ID:-}" ]; then
  HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
    --dns-name "$HOSTED_ZONE_DOMAIN" \
    --query "HostedZones[?Name=='${HOSTED_ZONE_DOMAIN}.'].Id | [0]" \
    --output text | sed 's|/hostedzone/||')
fi

if [ -z "$HOSTED_ZONE_ID" ] || [ "$HOSTED_ZONE_ID" = "None" ]; then
  echo "WARNING: Hosted zone for ${HOSTED_ZONE_DOMAIN} not found. Skipping DNS record."
  echo "Manually create an A alias record for ${CUSTOM_DOMAIN} -> ${CF_DOMAIN}"
else
  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "{
      \"Changes\": [{
        \"Action\": \"UPSERT\",
        \"ResourceRecordSet\": {
          \"Name\": \"${CUSTOM_DOMAIN}\",
          \"Type\": \"A\",
          \"AliasTarget\": {
            \"HostedZoneId\": \"Z2FDTNDATAQYW2\",
            \"DNSName\": \"${CF_DOMAIN}\",
            \"EvaluateTargetHealth\": false
          }
        }
      }]
    }" --no-cli-pager
  echo "Created A alias: ${CUSTOM_DOMAIN} -> ${CF_DOMAIN}"
fi

echo ""

fi # end full-only: ACM + CloudFront + Route53

# ─────────────────────────────────────────────────
# 10. Summary
# ─────────────────────────────────────────────────
echo "==========================================="
echo "  Deployment Complete! [mode: ${DEPLOY_MODE}]"
echo "==========================================="
echo ""
echo "  Custom Domain:   https://${CUSTOM_DOMAIN}"
if [ "$DEPLOY_MODE" = "full" ]; then
echo "  CloudFront URL:  https://${CF_DOMAIN}"
echo "  API Gateway URL: ${API_ENDPOINT}"
echo "  Certificate:     ${CERT_ARN}"
fi
echo "  Data Bucket:     s3://${DATA_BUCKET}"
echo "  Web Bucket:      s3://${WEB_BUCKET}"
echo ""
echo "  Interview URL pattern:"
echo "    https://${CUSTOM_DOMAIN}/r/<TOKEN>"
if [ "$DEPLOY_MODE" = "full" ]; then
echo ""
echo "  Next steps:"
echo "    1. Store OpenAI key (if not already done):"
echo "       aws secretsmanager create-secret --name '${SECRET_NAME}' --secret-string '{\"OPENAI_API_KEY\":\"sk-...\"}'"
echo "    2. Generate tokens:"
echo "       node scripts/generate-token.js --name 'Jane Doe' --company 'Acme' --env ${ENV}"
echo "    3. Upload allowlist to S3:"
echo "       aws s3 cp allowlist.json s3://${DATA_BUCKET}/allowlist/allowlist.json"
echo "    4. Store admin key (if not already done):"
echo "       aws secretsmanager create-secret --name '${ADMIN_SECRET_NAME}' --secret-string '{\"ADMIN_KEY\":\"your-secret-key\"}' --region ${REGION}"
echo "       Admin URL: https://${CUSTOM_DOMAIN}/admin.html"
fi
echo "==========================================="
