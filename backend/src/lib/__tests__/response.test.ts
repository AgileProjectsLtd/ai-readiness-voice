import { describe, it, expect } from 'vitest';
import { ok, created, unauthorized, notFound, badRequest, serverError } from '../response';

describe('response helpers', () => {
  it('ok() returns 200 with serialized body and CORS headers', () => {
    const result = ok({ hello: 'world' });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ hello: 'world' });
    expect(result.headers).toHaveProperty('Access-Control-Allow-Origin');
    expect(result.headers).toHaveProperty('Access-Control-Allow-Headers');
    expect(result.headers).toHaveProperty('Access-Control-Allow-Methods');
    expect(result.headers).toHaveProperty('Content-Type', 'application/json');
  });

  it('created() returns 201', () => {
    const result = created({ id: 1 });
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body)).toEqual({ id: 1 });
  });

  it('unauthorized() returns 401 with default message', () => {
    const result = unauthorized();
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'Unauthorized' });
  });

  it('unauthorized() accepts custom message', () => {
    const result = unauthorized('Bad key');
    expect(JSON.parse(result.body)).toEqual({ error: 'Bad key' });
  });

  it('notFound() returns 404', () => {
    const result = notFound();
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'Not found' });
  });

  it('badRequest() returns 400', () => {
    const result = badRequest('missing field');
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'missing field' });
  });

  it('serverError() returns 500', () => {
    const result = serverError();
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Internal server error' });
  });
});
