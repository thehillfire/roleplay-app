// What happens right after a new account is created, however it was created (email form or
// "Continue with Google/Apple"): the device checks, the moderator heads-up, the session.
const crypto = require('crypto');
const { hashToken, deviceHash } = require('../auth');
const { VERIFY_TTL_MS, publicUser } = require('./common');

function createSignup({ store, auth, mailer, siteUrl }) {
  // Emails a confirmation link. Moderator rights (ADMIN_EMAILS) need a confirmed inbox, so
  // registering someone else's address first gets you nothing.
  const sendVerification = async (req, user) => {
    const base = siteUrl(req);
    if (!base) return;
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createEmailVerification(hashToken(token), user.id, VERIFY_TTL_MS);
    mailer.send({
      to: user.email,
      subject: 'Confirm your email for Kindred',
      text: `Welcome to Kindred, ${user.handle}.\n\nConfirm this is your email so you can reset your password if you ever forget it:\n${base}/verify#${token}\n\nIf you didn't sign up, ignore this email.`,
    }).catch((err) => console.error('verification email failed', err.message));
  };

  // `emailConfirmed`: the provider already proved the inbox, so no confirmation email is needed.
  async function finish(req, res, user, { emailConfirmed = false } = {}) {
    const device = deviceHash(req, res);
    const banReason = await store.deviceBanReason(device);
    await store.noteDevice(user.id, device);
    let created = user;
    if (banReason) {
      // Same browser as a suspended account, or as an under-18 signup that was turned away:
      // a moderator takes a look first (they can appeal).
      await store.setUserStatus(user.id, 'review');
      await store.logModAction({ targetId: user.id, action: 'auto_pause', detail: banReason === 'suspended' ? 'Signed up on the device of a suspended account' : 'Signed up on a device that was refused as under 18' });
      created = { ...user, status: 'review' };
      store.moderatorEmails().then((emails) => Promise.all(emails.map((to) => mailer.send({
        to,
        subject: banReason === 'suspended' ? '[Kindred] Possible ban evasion paused' : '[Kindred] Possible minor paused',
        text: `A new account (${user.handle}) signed up on a device ${banReason === 'suspended' ? 'used by a suspended account' : 'where an under-18 signup was just refused'} and was paused for review. Look it up under Moderate → Look up.`,
      })))).catch((err) => console.error('evasion alert failed', err.message));
    }
    if (emailConfirmed) {
      await store.markEmailVerified(user.id);
      created = { ...created, emailVerified: true };
    } else {
      await sendVerification(req, user);
    }
    await auth.startSession(req, res, user.id);
    return publicUser(created);
  }

  return { sendVerification, finish };
}

module.exports = { createSignup };
