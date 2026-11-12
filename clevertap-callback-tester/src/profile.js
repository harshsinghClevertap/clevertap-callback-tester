'use strict';

/**
 * Works out the CleverTap dashboard profile page where a WhatsApp
 * delivered / viewed / clicked callback gets recorded.
 *
 * WhatsApp:
 *   callback: https://in1.cb.wzrkt.com/wa/generic/status?a=<ACCOUNT_ID>
 *   msgId:    216336|1794298065|20261112|191529|0
 *   profile:  https://in1.dashboard.clevertap.com/<ACCOUNT_ID>/j191529/profile-view.html
 *
 * SMS: callback https://cb.wzrkt.com/sms/generic?account=<ACCOUNT_ID>, msgId
 *   918605962596.1736923649.1794480055.20261112.0.wzrk_default.-191529.-1.
 *   -> account id from "account", profile id from the second-last part ("-191529" -> j191529).
 *
 *  - region: the label before "cb." in the callback host; none means eu1.
 *  - account id: the "a" query parameter of the callback URL.
 *  - profile id: the 4th "|"-separated part of the msgId, prefixed with "j".
 *
 * Returns the URL string, or null when it cannot be derived (never throws).
 */
function deriveProfileUrl(callbackUrl, msgId, channel = 'whatsapp') {
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const labels = url.hostname.toLowerCase().split('.');
  const cbIndex = labels.indexOf('cb');
  if (cbIndex === -1 || cbIndex > 1) return null;
  const region = cbIndex === 1 ? labels[0] : 'eu1';
  if (!/^[a-z0-9-]+$/.test(region)) return null;

  const isSms = channel === 'sms';
  const accountId = (url.searchParams.get(isSms ? 'account' : 'a') || '').trim();
  if (!/^[A-Za-z0-9-]+$/.test(accountId)) return null;

  let profileId;
  if (isSms) {
    // e.g. 918605962596.1736923649.1794480055.20261112.0.wzrk_default.-191529.-1.
    // Second-last part (ignoring the trailing dot), without its leading "-".
    const parts = String(msgId || '').trim().split('.');
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    profileId = (parts[parts.length - 2] || '').trim().replace(/^-/, '');
  } else {
    profileId = (String(msgId || '').trim().split('|')[3] || '').trim();
  }
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) return null;

  return `https://${region}.dashboard.clevertap.com/${accountId}/j${profileId}/profile-view.html`;
}

module.exports = { deriveProfileUrl };
