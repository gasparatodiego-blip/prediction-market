import nodemailer from 'nodemailer';

function getTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT ?? '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const FROM = process.env.FROM_EMAIL ?? 'alerts@predictionscanner.com';

export async function sendWelcomeEmail(user: { email: string; name?: string | null }) {
  const transport = getTransport();
  if (!transport) return;
  await transport.sendMail({
    from:    FROM,
    to:      user.email,
    subject: 'Welcome to PredMarket Scanner',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#111;color:#e5e7eb;padding:32px;border-radius:12px">
        <h1 style="color:#60a5fa;margin-bottom:8px">Welcome${user.name ? `, ${user.name}` : ''}!</h1>
        <p style="color:#9ca3af">Your account is ready. Start finding arbitrage opportunities across 12+ prediction markets.</p>
        <a href="${process.env.NEXTAUTH_URL}/dashboard" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">
          Open Dashboard →
        </a>
        <p style="margin-top:32px;font-size:12px;color:#4b5563">Not financial advice. Always verify before trading.</p>
      </div>
    `,
  }).catch(e => console.error('[email] welcome failed:', e.message));
}

export async function sendOpportunityAlert(
  user: { email: string; name?: string | null },
  opp: { title: string; roi: number; confidence: number; platform_a?: string; platform_b?: string; action?: string; description?: string }
) {
  const transport = getTransport();
  if (!transport) return;
  await transport.sendMail({
    from:    FROM,
    to:      user.email,
    subject: `🎯 New Arb Alert: ${opp.title.slice(0, 60)}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#111;color:#e5e7eb;padding:32px;border-radius:12px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
          <div style="background:#16a34a;color:white;padding:8px 16px;border-radius:8px;font-size:22px;font-weight:700">+${opp.roi.toFixed(1)}%</div>
          <div>
            <div style="font-size:16px;font-weight:600;color:white">${opp.title.slice(0, 80)}</div>
            <div style="font-size:12px;color:#9ca3af">Confidence: ${opp.confidence}%</div>
          </div>
        </div>
        ${opp.platform_a && opp.platform_b ? `
          <div style="background:#1f2937;padding:12px;border-radius:8px;margin-bottom:16px">
            <span style="color:#f87171;font-weight:600">${opp.platform_a}</span>
            <span style="color:#6b7280;margin:0 8px">→</span>
            <span style="color:#4ade80;font-weight:600">${opp.platform_b}</span>
          </div>
        ` : ''}
        ${opp.description ? `<p style="color:#9ca3af;font-size:14px">${opp.description.slice(0, 200)}</p>` : ''}
        <a href="${process.env.NEXTAUTH_URL}/dashboard" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">
          View Full Details →
        </a>
        <p style="margin-top:24px;font-size:11px;color:#4b5563">Not financial advice. Always verify before trading. <a href="${process.env.NEXTAUTH_URL}/dashboard/preferences" style="color:#6b7280">Manage alerts</a></p>
      </div>
    `,
  }).catch(e => console.error('[email] alert failed:', e.message));
}

export async function sendWeeklyDigest(
  user: { email: string; name?: string | null },
  opportunities: Array<{ title: string; roi: number; confidence: number; type: string }>
) {
  const transport = getTransport();
  if (!transport) return;
  const rows = opportunities.slice(0, 5).map((o, i) =>
    `<tr style="border-bottom:1px solid #374151">
      <td style="padding:8px;color:#9ca3af">${i + 1}</td>
      <td style="padding:8px;color:#e5e7eb">${o.title.slice(0, 55)}</td>
      <td style="padding:8px;color:#4ade80;font-weight:700">+${o.roi.toFixed(1)}%</td>
      <td style="padding:8px;color:#9ca3af">${o.confidence}%</td>
    </tr>`
  ).join('');

  await transport.sendMail({
    from:    FROM,
    to:      user.email,
    subject: `📊 Weekly Digest — Top ${Math.min(5, opportunities.length)} Opportunities`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#111;color:#e5e7eb;padding:32px;border-radius:12px">
        <h1 style="color:#60a5fa">Weekly Digest</h1>
        <p style="color:#9ca3af">Top opportunities from the past 7 days:</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          <thead><tr style="border-bottom:1px solid #374151;color:#6b7280;font-size:12px">
            <th style="padding:8px;text-align:left">#</th>
            <th style="padding:8px;text-align:left">Opportunity</th>
            <th style="padding:8px;text-align:left">ROI</th>
            <th style="padding:8px;text-align:left">Confidence</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <a href="${process.env.NEXTAUTH_URL}/dashboard" style="display:inline-block;margin-top:20px;padding:10px 20px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">
          Open Dashboard →
        </a>
        <p style="margin-top:24px;font-size:11px;color:#4b5563">Not financial advice. <a href="${process.env.NEXTAUTH_URL}/dashboard/preferences" style="color:#6b7280">Unsubscribe from digest</a></p>
      </div>
    `,
  }).catch(e => console.error('[email] digest failed:', e.message));
}

export async function sendPasswordReset(user: { email: string }, token: string) {
  const transport = getTransport();
  if (!transport) return;
  const url = `${process.env.NEXTAUTH_URL}/auth/reset?token=${token}`;
  await transport.sendMail({
    from:    FROM,
    to:      user.email,
    subject: 'Reset your PredMarket Scanner password',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#111;color:#e5e7eb;padding:32px;border-radius:12px">
        <h1 style="color:#60a5fa">Password Reset</h1>
        <p style="color:#9ca3af">Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${url}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#dc2626;color:white;border-radius:8px;text-decoration:none;font-weight:600">
          Reset Password →
        </a>
        <p style="margin-top:24px;font-size:12px;color:#4b5563">If you didn't request this, ignore this email.</p>
      </div>
    `,
  }).catch(e => console.error('[email] reset failed:', e.message));
}
