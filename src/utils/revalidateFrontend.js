// Fires an on-demand ISR revalidation request to cashlo-final after a blog
// changes, so publish/edit/delete show up immediately instead of waiting for
// the fetch-level revalidate window to expire. Best-effort: never throws,
// since a failed revalidation should not fail the admin's request — the
// time-based revalidate on the frontend's fetch calls is the fallback.
export const revalidateBlogFrontend = async (slug) => {
  const baseUrl = process.env.FRONTEND_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!baseUrl || !secret) return;

  try {
    await fetch(`${baseUrl}/api/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': secret,
      },
      body: JSON.stringify({ slug }),
    });
  } catch (err) {
    console.error('[revalidateFrontend] failed to revalidate blog frontend:', err.message);
  }
};
