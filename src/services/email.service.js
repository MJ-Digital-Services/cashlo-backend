import nodemailer from 'nodemailer';
import { config } from '../config/environment.js';

// SES SMTP — sends as noreply@cashlo.app (domain-verified, DKIM signed).
// Daily quota: 50,000/day, 14 emails/sec (production access granted).
const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

export const sendOtpEmail = async ({ to, name, otp }) => {
  try {
    await transporter.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to,
      subject: 'Your Cashlo Distributor OTP',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Verify your email</h2>
          <p>Use the OTP below to verify your email and continue reserving your Cashlo distributor pincode:</p>
          <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${otp}</p>
          <p>This OTP is valid for 5 minutes. If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });
  } catch (err) {
    const error = new Error('Failed to send OTP email');
    error.statusCode = 502;
    error.details = err.message;
    throw error;
  }
};

export const sendPaymentConfirmationEmail = async ({ to, name, pincode, district, state, amount, paymentId, receiptUrl }) => {
  try {
    await transporter.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to,
      subject: "Your Cashlo Distributor PIN Code is Reserved! 🎉",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; background-color: #f5f6fa; padding: 40px 20px;">
          <div style="background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(68, 93, 240, 0.08);">
            
            <!-- Header -->
            <div style="background: #445df0; padding: 32px 32px 28px; text-align: center;">
              <div style="color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Cashlo</div>
            </div>

            <!-- Body -->
            <div style="padding: 36px 32px;">
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="font-size: 40px; line-height: 1; margin-bottom: 12px;">🎉</div>
                <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #111827;">Congratulations, ${name}!</h1>
              </div>

              <p style="font-size: 15px; line-height: 1.6; color: #4b5563; margin: 0 0 24px;">
                Your PIN Code <strong style="color: #111827;">${pincode}</strong> (${district}, ${state}) has been successfully reserved. This territory is now exclusively assigned to you — no other distributor can reserve this PIN Code.
              </p>

              <!-- Details card -->
              <div style="background: #f8f9ff; border: 1px solid #e8eaf9; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #6b7280;">Amount Paid</td>
                    <td style="padding: 6px 0; font-size: 14px; color: #111827; font-weight: 600; text-align: right;">₹${(amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #6b7280;">Payment ID</td>
                    <td style="padding: 6px 0; font-size: 13px; color: #111827; font-weight: 500; text-align: right; font-family: monospace;">${paymentId}</td>
                  </tr>
                </table>
              </div>

              ${receiptUrl ? `
              <!-- CTA -->
              <div style="text-align: center; margin-bottom: 28px;">
                <a href="${receiptUrl}" style="display: inline-block; background: #445df0; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; padding: 13px 28px; border-radius: 8px;">Download Receipt (PDF)</a>
              </div>
              ` : ''}

              <p style="font-size: 14px; line-height: 1.6; color: #4b5563; margin: 0; text-align: center;">
                Our team will contact you shortly for onboarding and KYC.
              </p>
            </div>

            <!-- Footer -->
            <div style="padding: 20px 32px; border-top: 1px solid #f0f1f5; text-align: center;">
              <p style="font-size: 12px; color: #9ca3af; margin: 0;">
                This is an automated confirmation from Cashlo.<br/>
                For queries, contact <a href="mailto:support@cashlo.in" style="color: #445df0; text-decoration: none;">support@cashlo.in</a>
              </p>
            </div>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('❌ Failed to send payment confirmation email:', err.message);
  }
};

export const sendDistributorActivationEmail = async ({ to, name, pincode, district, state, totalAmount, receiptUrl }) => {
  try {
    await transporter.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to,
      subject: "You're Live! Your Cashlo Distributor PIN Code is Activated ✅",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; background-color: #f5f6fa; padding: 40px 20px;">
          <div style="background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(16, 185, 129, 0.08);">

            <!-- Header -->
            <div style="background: #059669; padding: 32px 32px 28px; text-align: center;">
              <div style="color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Cashlo</div>
            </div>

            <!-- Body -->
            <div style="padding: 36px 32px;">
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="font-size: 40px; line-height: 1; margin-bottom: 12px;">✅</div>
                <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #111827;">You're all set, ${name}!</h1>
              </div>

              <p style="font-size: 15px; line-height: 1.6; color: #4b5563; margin: 0 0 24px;">
                Your final payment has been verified and your PIN Code <strong style="color: #111827;">${pincode}</strong> (${district}, ${state}) is now <strong style="color: #059669;">fully activated</strong>. You can now start onboarding merchants in your territory as a Cashlo Distributor.
              </p>

              <!-- Details card -->
              <div style="background: #f0fdf6; border: 1px solid #d3f4e3; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #6b7280;">Total Distributor Fee Paid</td>
                    <td style="padding: 6px 0; font-size: 14px; color: #111827; font-weight: 600; text-align: right;">₹${(totalAmount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #6b7280;">Status</td>
                    <td style="padding: 6px 0; font-size: 13px; color: #059669; font-weight: 600; text-align: right;">Activated</td>
                  </tr>
                </table>
              </div>

              ${receiptUrl ? `
              <div style="text-align: center; margin-bottom: 28px;">
                <a href="${receiptUrl}" style="display: inline-block; background: #059669; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; padding: 13px 28px; border-radius: 8px;">Download Receipt (PDF)</a>
              </div>
              ` : ''}

              <p style="font-size: 14px; line-height: 1.6; color: #4b5563; margin: 0; text-align: center;">
                Our onboarding team will reach out shortly with your next steps.
              </p>
            </div>

            <!-- Footer -->
            <div style="padding: 20px 32px; border-top: 1px solid #f0f1f5; text-align: center;">
              <p style="font-size: 12px; color: #9ca3af; margin: 0;">
                This is an automated confirmation from Cashlo.<br/>
                For queries, contact <a href="mailto:support@cashlo.in" style="color: #059669; text-decoration: none;">support@cashlo.in</a>
              </p>
            </div>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('❌ Failed to send distributor activation email:', err.message);
  }
};

export const sendDistributorRefundEmail = async ({ to, name, pincode, district, state, amount, utr }) => {
  try {
    await transporter.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to,
      subject: 'Your Cashlo Refund Has Been Processed',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; background-color: #f5f6fa; padding: 40px 20px;">
          <div style="background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(147, 51, 234, 0.08);">

            <!-- Header -->
            <div style="background: #7c3aed; padding: 32px 32px 28px; text-align: center;">
              <div style="color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Cashlo</div>
            </div>

            <!-- Body -->
            <div style="padding: 36px 32px;">
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="font-size: 40px; line-height: 1; margin-bottom: 12px;">↩️</div>
                <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #111827;">Hi ${name},</h1>
              </div>

                            <p style="font-size: 15px; line-height: 1.6; color: #4b5563; margin: 0 0 24px;">
                We've processed your refund for PIN Code <strong style="color: #111827;">${pincode}</strong> (${district}, ${state}). This PIN Code reservation has now been released. The refund amount will be credited to your bank account within 2–3 business days.
              </p>

              <!-- Details card -->
              <div style="background: #faf5ff; border: 1px solid #ede4fb; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #6b7280;">Refund Amount</td>
                    <td style="padding: 6px 0; font-size: 14px; color: #111827; font-weight: 600; text-align: right;">₹${(amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; font-size: 13px; color: #6b7280;">Refund UTR</td>
                    <td style="padding: 6px 0; font-size: 13px; color: #111827; font-weight: 500; text-align: right; font-family: monospace;">${utr}</td>
                  </tr>
                </table>
              </div>

              <p style="font-size: 14px; line-height: 1.6; color: #4b5563; margin: 0; text-align: center;">
                If you have any questions about this refund, please reach out to our support team.
              </p>
            </div>

            <!-- Footer -->
            <div style="padding: 20px 32px; border-top: 1px solid #f0f1f5; text-align: center;">
              <p style="font-size: 12px; color: #9ca3af; margin: 0;">
                This is an automated confirmation from Cashlo.<br/>
                For queries, contact <a href="mailto:support@cashlo.in" style="color: #7c3aed; text-decoration: none;">support@cashlo.in</a>
              </p>
            </div>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('❌ Failed to send distributor refund email:', err.message);
  }
};

