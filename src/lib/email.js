const nodemailer = require('nodemailer');
const logger = require('./logger');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_ADDR = process.env.SMTP_FROM || 'noreply@619fitness.com';

function isConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

let transporter = null;

function getTransport() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendPasswordReset(email, rawToken) {
  if (!isConfigured()) {
    logger.warn({ email }, 'SMTP not configured — password reset email skipped');
    return;
  }

  const resetUrl = `${process.env.FRONTEND_URL || 'https://619-erp-frontend.vercel.app'}/reset-password?token=${rawToken}`;

  try {
    await getTransport().sendMail({
      from: FROM_ADDR,
      to: email,
      subject: 'Password Reset — 619 Fitness Studio',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#e11d48">Password Reset Request</h2>
          <p>Click the link below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#e11d48;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Reset Password</a>
          <p style="color:#666;font-size:13px">If you didn't request this, ignore this email.</p>
        </div>
      `,
    });
    logger.info({ email }, 'Password reset email sent');
  } catch (err) {
    logger.error({ err: err.message, email }, 'Failed to send password reset email');
  }
}

module.exports = { sendPasswordReset, isConfigured };
