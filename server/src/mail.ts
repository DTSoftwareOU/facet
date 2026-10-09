import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close?(): void;
}

export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
    close() {
      transport.close();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function resetCodeEmail(to: string, code: string, publicUrl: string): MailMessage {
  const pretty = `${code.slice(0, 4)} ${code.slice(4)}`;
  const text = [
    'Someone asked to reset the password for your Facet account.',
    '',
    `Your reset code: ${pretty}`,
    '',
    'The code expires in 30 minutes. Resetting with this code permanently deletes your',
    'encrypted chats, assistants, keys and files, because they can only be decrypted with your',
    'old password or recovery code. If you still have your recovery code, use it instead.',
    '',
    "If you didn't ask for this, ignore this email. Your account is unchanged.",
    '',
    `Facet — ${publicUrl}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#F5F6F8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#12161C">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#FFFFFF;border-radius:18px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:20px;font-weight:600;padding-bottom:12px">Reset your Facet password</td></tr>
<tr><td style="font-size:15px;line-height:22px;color:#4F5968;padding-bottom:20px">Someone asked to reset the password for your Facet account. Enter this code in the app:</td></tr>
<tr><td style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;letter-spacing:4px;font-weight:600;padding:16px 0;text-align:center;background:#ECEFF3;border-radius:14px">${escapeHtml(pretty)}</td></tr>
<tr><td style="font-size:14px;line-height:21px;color:#4F5968;padding-top:20px">The code expires in 30 minutes. Resetting with this code <strong>permanently deletes your encrypted chats, assistants, keys and files</strong>, because they can only be decrypted with your old password or recovery code. If you still have your recovery code, use it instead.</td></tr>
<tr><td style="font-size:14px;line-height:21px;color:#8590A0;padding-top:16px">If you didn't ask for this, ignore this email. Your account is unchanged.</td></tr>
</table>
<div style="font-size:12px;color:#8590A0;padding-top:16px">Facet · <a href="${escapeHtml(publicUrl)}" style="color:#087A6C">${escapeHtml(publicUrl.replace(/^https?:\/\//, ''))}</a></div>
</td></tr></table></body></html>`;
  return { to, subject: `Your Facet reset code: ${pretty}`, text, html };
}
