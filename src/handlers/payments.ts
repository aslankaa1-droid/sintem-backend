// NowPayments + CryptoCloud invoice creation, webhook handlers, subscription activation.

import { log } from '../lib/log';
import { sendMessage } from '../lib/tg';
import { verifyNowPaymentsSig, verifyCryptoCloudSig } from '../lib/hmac';
import { type Env, type PaidPlan, PLAN_CONFIG } from '../types';

interface PaymentRow {
  id: number;
  tg_user_id: number;
  provider: 'nowpayments' | 'cryptocloud' | 'admin_manual';
  plan: PaidPlan;
  amount_rub: number;
}

/**
 * Create a payment row + a provider invoice. Returns the invoice URL the user
 * should open to pay. Tries NowPayments first, falls back to CryptoCloud on
 * 5xx / network failure.
 */
export async function createInvoice(
  env: Env,
  userId: number,
  plan: PaidPlan,
): Promise<{ url: string; payment_id: number; provider: 'nowpayments' | 'cryptocloud' }> {
  const amount = PLAN_CONFIG[plan].price_rub;

  // Step 1 — record a pending payment row (provider_payment_id будет заполнен после создания invoice).
  const payRow = await env.DB.prepare(
    `INSERT INTO payments (tg_user_id, provider, amount_rub, plan, status)
     VALUES (?, 'nowpayments', ?, ?, 'pending')
     RETURNING id`,
  )
    .bind(userId, amount, plan)
    .first<{ id: number }>();
  if (!payRow) throw new Error('failed to insert payment row');
  const payment_id = payRow.id;

  // Step 2 — try NowPayments
  try {
    const url = await createNowPaymentsInvoice(env, payment_id, amount, plan);
    await env.DB.prepare(
      `UPDATE payments SET provider_payment_id = ? WHERE id = ?`,
    )
      .bind(`np-${payment_id}`, payment_id)
      .run();
    return { url, payment_id, provider: 'nowpayments' };
  } catch (e) {
    log({ event: 'nowpayments_failed_fallback', level: 'warn', error: (e as Error).message });
  }

  // Step 3 — fallback to CryptoCloud
  try {
    const url = await createCryptoCloudInvoice(env, payment_id, amount, plan);
    await env.DB.prepare(
      `UPDATE payments SET provider = 'cryptocloud', provider_payment_id = ? WHERE id = ?`,
    )
      .bind(`cc-${payment_id}`, payment_id)
      .run();
    return { url, payment_id, provider: 'cryptocloud' };
  } catch (e) {
    log({ event: 'cryptocloud_failed', level: 'error', error: (e as Error).message });
    await env.DB.prepare(
      `UPDATE payments SET status = 'failed', finalized_at = strftime('%s','now') WHERE id = ?`,
    )
      .bind(payment_id)
      .run();
    throw new Error('Both payment providers failed');
  }
}

async function createNowPaymentsInvoice(env: Env, paymentId: number, amount: number, plan: PaidPlan): Promise<string> {
  const res = await fetch(`${env.NOWPAYMENTS_API_BASE}/invoice`, {
    method: 'POST',
    headers: {
      'x-api-key': env.NOWPAYMENTS_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      price_amount: amount,
      price_currency: 'rub',
      pay_currency: 'usdttrc20',
      ipn_callback_url: `${env.PUBLIC_BASE_URL}/webhook/nowpayments`,
      order_id: String(paymentId),
      order_description: `SINTEM ${plan} subscription, 30 days`,
      success_url: `${env.PUBLIC_BASE_URL}/pay/success`,
      cancel_url: `${env.PUBLIC_BASE_URL}/pay/cancel`,
    }),
  });
  if (!res.ok) throw new Error(`NowPayments invoice ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { invoice_url?: string; id?: string };
  if (!json.invoice_url) throw new Error('NowPayments returned no invoice_url');
  return json.invoice_url;
}

async function createCryptoCloudInvoice(env: Env, paymentId: number, amount: number, plan: PaidPlan): Promise<string> {
  const res = await fetch(`${env.CRYPTOCLOUD_API_BASE}/invoice/create`, {
    method: 'POST',
    headers: {
      authorization: `Token ${env.CRYPTOCLOUD_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      shop_id: env.CRYPTOCLOUD_SHOP_ID,
      amount,
      currency: 'RUB',
      order_id: String(paymentId),
      description: `SINTEM ${plan} subscription, 30 days`,
    }),
  });
  if (!res.ok) throw new Error(`CryptoCloud invoice ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { result?: { link?: string; uuid?: string }; status?: string };
  if (json.status !== 'success' || !json.result?.link) throw new Error('CryptoCloud returned bad payload');
  return json.result.link;
}

/**
 * Activate / extend a subscription. Atomic batch: deactivate all current, insert new.
 * Idempotent on (user_id, plan, payment_id) — re-applying the same paid webhook
 * does not duplicate the active row, only refreshes the BILLING_CACHE.
 */
export async function activateSubscription(
  env: Env,
  userId: number,
  plan: PaidPlan,
  paymentId: number,
): Promise<void> {
  // Idempotency check
  const existing = await env.DB.prepare(
    `SELECT 1 FROM subscriptions WHERE payment_id = ? AND is_active = 1`,
  )
    .bind(paymentId)
    .first<{ 1: number }>();
  if (existing) {
    await env.BILLING_CACHE.delete(`sub:${userId}`);
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + PLAN_CONFIG[plan].duration_days * 86400;
  await env.DB.batch([
    env.DB.prepare(`UPDATE subscriptions SET is_active = 0 WHERE tg_user_id = ? AND is_active = 1`).bind(userId),
    env.DB.prepare(
      `INSERT INTO subscriptions (tg_user_id, plan, is_active, expires_at, payment_id, source)
       VALUES (?, ?, 1, ?, ?, 'webhook')`,
    ).bind(userId, plan, expiresAt, paymentId),
  ]);
  await env.BILLING_CACHE.delete(`sub:${userId}`);
  log({ event: 'sub_activated', user_id: userId, plan, payment_id: paymentId, expires_at: expiresAt });

  await sendMessage(
    env,
    userId,
    `✅ Тариф <b>${plan}</b> активирован до ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}.\n` +
      `Доступно ${PLAN_CONFIG[plan].daily_quota_per_agent} запросов на агента в день. Удачных продаж.`,
  );
}

/**
 * NowPayments IPN handler. Body schema:
 *   {payment_status, payment_id, order_id (= payments.id), price_amount,
 *    pay_amount, pay_currency, outcome_amount, ...}
 */
export async function handleNowPaymentsWebhook(env: Env, ctx: ExecutionContext, body: string, sig: string): Promise<Response> {
  if (!(await verifyNowPaymentsSig(env.NOWPAYMENTS_IPN_SECRET, body, sig))) {
    log({ event: 'nowpay_bad_sig', level: 'warn' });
    return new Response('bad signature', { status: 403 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const status = String(payload.payment_status ?? '');
  const orderId = parseInt(String(payload.order_id ?? '0'), 10);
  const txHash = (payload.payin_hash as string | undefined) ?? null;
  if (!orderId) return new Response('no order_id', { status: 400 });

  const pay = await env.DB.prepare(
    `SELECT id, tg_user_id, plan FROM payments WHERE id = ?`,
  )
    .bind(orderId)
    .first<PaymentRow>();
  if (!pay) return new Response('unknown order', { status: 404 });

  if (status === 'finished' || status === 'confirmed') {
    await env.DB.prepare(
      `UPDATE payments SET status = 'paid', tx_hash = ?, raw_payload = ?, finalized_at = strftime('%s','now')
       WHERE id = ? AND status != 'paid'`,
    )
      .bind(txHash, body, orderId)
      .run();
    ctx.waitUntil(activateSubscription(env, pay.tg_user_id, pay.plan, pay.id));
  } else if (status === 'failed' || status === 'expired' || status === 'refunded') {
    await env.DB.prepare(
      `UPDATE payments SET status = ?, raw_payload = ?, finalized_at = strftime('%s','now')
       WHERE id = ? AND status NOT IN ('paid','refunded')`,
    )
      .bind(status === 'refunded' ? 'refunded' : status, body, orderId)
      .run();
  }
  return new Response('', { status: 200 });
}

/**
 * CryptoCloud postback handler. Body schema:
 *   {status, invoice_id, order_id, amount_crypto, currency, ...}
 * Header: `Sign` (HMAC-SHA256 base64).
 */
export async function handleCryptoCloudWebhook(env: Env, ctx: ExecutionContext, body: string, sig: string): Promise<Response> {
  if (!(await verifyCryptoCloudSig(env.CRYPTOCLOUD_SECRET, body, sig))) {
    log({ event: 'cc_bad_sig', level: 'warn' });
    return new Response('bad signature', { status: 403 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const status = String(payload.status ?? '');
  const orderId = parseInt(String(payload.order_id ?? '0'), 10);
  if (!orderId) return new Response('no order_id', { status: 400 });

  const pay = await env.DB.prepare(
    `SELECT id, tg_user_id, plan FROM payments WHERE id = ?`,
  )
    .bind(orderId)
    .first<PaymentRow>();
  if (!pay) return new Response('unknown order', { status: 404 });

  if (status === 'success' || status === 'paid') {
    await env.DB.prepare(
      `UPDATE payments SET status = 'paid', raw_payload = ?, finalized_at = strftime('%s','now')
       WHERE id = ? AND status != 'paid'`,
    )
      .bind(body, orderId)
      .run();
    ctx.waitUntil(activateSubscription(env, pay.tg_user_id, pay.plan, pay.id));
  } else if (status === 'fail' || status === 'expired' || status === 'cancel') {
    const newStatus = status === 'expired' ? 'expired' : 'failed';
    await env.DB.prepare(
      `UPDATE payments SET status = ?, raw_payload = ?, finalized_at = strftime('%s','now')
       WHERE id = ? AND status NOT IN ('paid','refunded')`,
    )
      .bind(newStatus, body, orderId)
      .run();
  }
  return new Response('', { status: 200 });
}

/**
 * Re-check payments that have been pending for more than 1 hour.
 * Called from cron. Polls provider GET endpoint to see if the payment confirmed
 * but the IPN was lost.
 */
export async function recheckPendingPayments(env: Env, ctx: ExecutionContext): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  const rows = await env.DB.prepare(
    `SELECT id, tg_user_id, provider, provider_payment_id, plan
       FROM payments
      WHERE status = 'pending' AND created_at < ?
      LIMIT 50`,
  )
    .bind(cutoff)
    .all<{ id: number; tg_user_id: number; provider: string; provider_payment_id: string; plan: PaidPlan }>();

  for (const p of rows.results ?? []) {
    if (p.provider === 'nowpayments') {
      ctx.waitUntil(recheckNowPayments(env, p));
    } else if (p.provider === 'cryptocloud') {
      ctx.waitUntil(recheckCryptoCloud(env, p));
    }
  }
}

async function recheckNowPayments(env: Env, p: { id: number; tg_user_id: number; provider_payment_id: string; plan: PaidPlan }): Promise<void> {
  try {
    // NowPayments: GET /v1/payment/{order_id} — но реальный endpoint требует payment_id (не order_id).
    // В MVP мы храним provider_payment_id вида "np-<id>" как placeholder, реальный id из IPN.
    // Если нужна точная сверка — заменить на их status endpoint и сопоставить через payments.raw_payload.
    const res = await fetch(`${env.NOWPAYMENTS_API_BASE}/payment/${encodeURIComponent(p.provider_payment_id)}`, {
      headers: { 'x-api-key': env.NOWPAYMENTS_API_KEY },
    });
    if (!res.ok) return;
    const json = (await res.json()) as { payment_status?: string };
    if (json.payment_status === 'finished' || json.payment_status === 'confirmed') {
      await env.DB.prepare(
        `UPDATE payments SET status = 'paid', finalized_at = strftime('%s','now') WHERE id = ?`,
      ).bind(p.id).run();
      await activateSubscription(env, p.tg_user_id, p.plan, p.id);
    }
  } catch (e) {
    log({ event: 'recheck_np_error', level: 'warn', error: (e as Error).message, payment_id: p.id });
  }
}

async function recheckCryptoCloud(env: Env, p: { id: number; tg_user_id: number; provider_payment_id: string; plan: PaidPlan }): Promise<void> {
  try {
    const res = await fetch(`${env.CRYPTOCLOUD_API_BASE}/invoice/info`, {
      method: 'POST',
      headers: {
        authorization: `Token ${env.CRYPTOCLOUD_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ uuids: [p.provider_payment_id] }),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { result?: { status?: string }[] };
    const status = json.result?.[0]?.status;
    if (status === 'paid' || status === 'success') {
      await env.DB.prepare(
        `UPDATE payments SET status = 'paid', finalized_at = strftime('%s','now') WHERE id = ?`,
      ).bind(p.id).run();
      await activateSubscription(env, p.tg_user_id, p.plan, p.id);
    }
  } catch (e) {
    log({ event: 'recheck_cc_error', level: 'warn', error: (e as Error).message, payment_id: p.id });
  }
}
