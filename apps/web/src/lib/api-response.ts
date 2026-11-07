const JSON_UTF8_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, data }, { status, headers: JSON_UTF8_HEADERS })
}

export function err(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: JSON_UTF8_HEADERS })
}

export function unauthorized(): Response {
  return err('Unauthorized', 401)
}

export function forbidden(): Response {
  return err('Forbidden', 403)
}

export function notFound(resource = 'Resource'): Response {
  return err(`${resource} not found`, 404)
}

export function tooManyRequests(message = 'Rate limit exceeded'): Response {
  return err(message, 429)
}

export function serverError(message = 'Internal server error'): Response {
  return err(message, 500)
}
