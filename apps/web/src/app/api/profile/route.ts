import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/projects';

const UpdateProfileSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email(),
  company: z.string().max(120).optional().default(''),
  avatarUrl: z.string().url().nullable().optional(),
});

export async function PATCH(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = UpdateProfileSchema.parse(await request.json());
    const displayName = `${body.firstName.trim()} ${body.lastName.trim()}`.trim();

    const { error: authError } = await supabase.auth.updateUser({
      email: body.email !== user.email ? body.email : undefined,
      data: {
        first_name: body.firstName.trim(),
        last_name: body.lastName.trim(),
        display_name: displayName,
        company: body.company.trim() || null,
        studio_name: body.company.trim() || null,
      },
    });
    if (authError) throw authError;

    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        display_name: displayName,
        email: body.email,
        avatar_url: body.avatarUrl === undefined ? undefined : body.avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (profileError) throw profileError;

    return NextResponse.json({ ok: true, displayName });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
