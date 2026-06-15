const nodemailer = require('nodemailer');
const logger = require('./logger');

const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
  throw new Error('FRONTEND_URL env var is required');
}

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

  const resetUrl = `${FRONTEND_URL}/reset-password?token=${rawToken}`;

  try {
    await getTransport().sendMail({
      from: FROM_ADDR,
      to: email,
      subject: 'Password Reset — 619 Fitness Studio',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#e11d48">Password Reset Request</h2>
          <p>Click the link below to reset your password. This link expires in 15 minutes.</p>
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

async function sendAdminResetOtp(email, otp) {
  if (!isConfigured()) {
    logger.warn({ email }, 'SMTP not configured — admin reset OTP not sent');
    return;
  }
  try {
    const t = getTransport();
    await t.sendMail({
      from: FROM_ADDR,
      to: email,
      subject: '619 ERP — Admin Data Reset OTP',
      text: `Your one-time code to confirm the data reset is: ${otp}\n\nThis code expires in 10 minutes. If you did not request this, ignore this email.`,
      html: `<p>Your one-time code to confirm the data reset is:</p><h2>${otp}</h2><p>This code expires in <strong>10 minutes</strong>. If you did not request this, ignore this email.</p>`,
    });
  } catch (err) {
    logger.error({ err: err.message, email }, 'Failed to send admin reset OTP email');
  }
}

module.exports = { sendPasswordReset, sendAdminResetOtp, isConfigured };
