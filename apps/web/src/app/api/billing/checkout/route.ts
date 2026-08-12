import { NextResponse } from 'next/server';
import { CreateCheckoutSchema } from '@aihd/api-client';
import { requireUser } from '@/lib/projects';
import { getStripe, PLAN_PRICES } from '@/lib/stripe';

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = CreateCheckoutSchema.parse(await request.json());
    const priceId = PLAN_PRICES[body.plan];

    if (!process.env.STRIPE_SECRET_KEY || !priceId) {
      return NextResponse.json(
        {
          ok: false,
          message:
            'Stripe is not fully configured. Set STRIPE_SECRET_KEY and price IDs to enable checkout.',
          plan: body.plan,
          seatCount: body.seatCount,
        },
        { status: 200 },
      );
    }

    const stripe = getStripe();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    const { data: existing } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('workspace_id', body.workspaceId)
      .maybeSingle();

    let customerId = existing?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { workspaceId: body.workspaceId, userId: user.id },
      });
      customerId = customer.id;
      if (existing) {
        await supabase
          .from('subscriptions')
          .update({ stripe_customer_id: customerId })
          .eq('id', existing.id);
      } else {
        await supabase.from('subscriptions').insert({
          workspace_id: body.workspaceId,
          stripe_customer_id: customerId,
          plan: body.plan,
          status: 'incomplete',
          seat_count: body.seatCount,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: body.seatCount }],
      success_url: `${appUrl}/app/settings?billing=success`,
      cancel_url: `${appUrl}/app/settings?billing=cancel`,
      metadata: { workspaceId: body.workspaceId, plan: body.plan },
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
