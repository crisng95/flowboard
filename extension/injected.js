/**
 * Injected into the page's MAIN world on flow.google.com (and an old pinned
 * labs.google tab) — has access to window.grecaptcha.
 *
 * Used solely for reCAPTCHA solving. Media urls still come back on the
 * generation response itself, so no response interception is needed here.
 *
 * The site key survived the September 2026 migration unchanged; it was the
 * transport around it that changed.
 */
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// Mints are serialised. On the batchexecute path every RPC carries its own
// single-use token, and an image dispatch fires up to four RPCs at once —
// overlapping grecaptcha.enterprise.execute() calls for the same action return
// interfering tokens, and a replayed or crossed one comes back from Flow as
// PUBLIC_ERROR_UNUSUAL_ACTIVITY. Queueing them costs a few hundred ms per
// variant and removes that whole failure mode.
let captchaMintTail = Promise.resolve();

async function mintCaptcha(pageAction) {
  const previous = captchaMintTail.catch(() => {});
  let release;
  captchaMintTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    await waitForGrecaptcha();
    return await window.grecaptcha.enterprise.execute(SITE_KEY, {
      action: pageAction,
    });
  } finally {
    release();
  }
}

window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction } = detail;
  try {
    const token = await mintCaptcha(pageAction);
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, token },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, error: e.message },
    }));
  }
});

function waitForGrecaptcha(timeout = 22000) {   // lazily loaded; 10s was optimistic
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.grecaptcha?.enterprise?.execute) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
      setTimeout(check, 200);
    };
    check();
  });
}
