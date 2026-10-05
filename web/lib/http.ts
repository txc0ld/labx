export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function fail(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Request failed";
  return json({ ok: false, error: message }, status);
}
