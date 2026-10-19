/* Golden Rule voice tools — one place for every Apps Script web-app URL.
 * Each tool is its own Apps Script project. After you deploy one (Deploy → Web app → /exec URL),
 * paste the URL here. A tool with an empty URL shows as "not connected yet" on the home page.
 * Pages that still have an inline ENDPOINT fall back to it when the entry here is empty. */
window.GR_ENDPOINTS = {
  notes:    "https://script.google.com/macros/s/AKfycbzmZAs9GmVh6srwcwMabNf2LKEjMH1lumMvy5vlB1AKVbMMjQnGfTmN0z67UpTQc4JC_w/exec",
  newJob:   "https://script.google.com/macros/s/AKfycbzEWKwytSekz0nzDibpQRIpVN3EVKD3tn_kM20YF_EBcMuIaqL2jZCEcyptUoiAs6Vrgw/exec",
  dispatch: "https://script.google.com/macros/s/AKfycbwM3Jj1HXMY1KOllTpQ_Jrg08aKlz-tag0ATXNfJb_s-X2WGKgGjBmn1W38-K3C25JB/exec",
  estimate: "https://script.google.com/macros/s/AKfycbx_RjHAhmNt7V0rGnyJIh1O6oo3JXsghWEY1pKofPGGbG1nk6ZG7FU3df7JVe_1Ajc2/exec",
  order:    "https://script.google.com/macros/s/AKfycbyu92e88bcaTG5Ps_g-PWp23ApU5DHSgPTVj7sBX_uBByR1_WcxYitp6A58HHc6bCiO6w/exec",
  clock:    "",
  jobInputs: "https://script.google.com/macros/s/AKfycbzoVcs67ro58JNElJG0zAPONOKx0HOhW8TjeJNB5j3LBILQJhc8m-KpD85VnqGPLLnd/exec"
};

/* Counter texting for the Order tool (the West Chester branch says "call or text" this number). */
window.GR_COUNTER = { name: "Weinstein West Chester", sms: "6104360880" };

/* Offline: install the service worker (sw.js) so every page opens with no signal after its first visit. */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) {}
}
