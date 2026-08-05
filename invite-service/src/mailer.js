const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
  // The 'gmail' service shorthand defaults to port 465 (implicit TLS), which
  // this host's outbound firewall blocks (confirmed via raw TCP test - 465
  // times out, 587 connects). Use explicit STARTTLS on 587 instead.
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  // Without explicit timeouts a bad/misconfigured account can hang the
  // request indefinitely instead of failing back to the admin.
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 10_000,
});

async function sendInviteEmail({ to, boardName, inviterEmail, acceptUrl, expiresAt }) {
  const expiresText = expiresAt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  await transport.sendMail({
    from: `PLANKA <${process.env.GMAIL_USER}>`,
    to,
    subject: `You've been invited to the "${boardName}" board on PLANKA`,
    text: `${inviterEmail} has invited you to the "${boardName}" board on PLANKA.

Set up your account here: ${acceptUrl}

This link expires on ${expiresText} and can only be used once.

If you weren't expecting this invite, you can ignore this email.`,
    html: `
      <p><strong>${inviterEmail}</strong> has invited you to the "<strong>${boardName}</strong>" board on PLANKA.</p>
      <p><a href="${acceptUrl}">Click here to set up your account</a></p>
      <p style="color:#666;font-size:0.9em">This link expires on ${expiresText} and can only be used once. If you weren't expecting this invite, you can ignore this email.</p>
    `,
  });
}

module.exports = { sendInviteEmail };
