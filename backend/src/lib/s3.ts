import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-1' });
const DATA_BUCKET = process.env.DATA_BUCKET || 'ai-readiness-dev-data';

export async function getJson<T>(key: string): Promise<T | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
    const body = await resp.Body?.transformToString('utf-8');
    if (!body) return null;
    return JSON.parse(body) as T;
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function putJson(key: string, data: unknown): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: DATA_BUCKET,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
  }));
}

export async function copyObject(sourceKey: string, destKey: string): Promise<void> {
  await s3.send(new CopyObjectCommand({
    Bucket: DATA_BUCKET,
    CopySource: `${DATA_BUCKET}/${sourceKey}`,
    Key: destKey,
  }));
}
