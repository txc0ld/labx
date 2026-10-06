export async function POST() {
  return Response.json({ ok: false, error: "This entry route is retired. Bonus entries are included only with purchased memberships." }, { status: 410 });
}
